#!/usr/bin/env python3
"""kh - homework data CLI.

The Cloudflare Worker and its D1 database are the store. This tool talks to the
Worker's /admin routes and keeps a normalised, reviewable copy on disk under
data/ so a week can be read, diffed and planned without a browser.

  kh.py pull      API   -> data/   (writes a raw snapshot of the export first)
  kh.py status    one screen summary of what is on disk and what the API holds
  kh.py validate  check data/ against schema/ and the curriculum rules
  kh.py push      data/ -> API     (the fields a human owns, asks first)
  kh.py backup    raw snapshot of the export, nothing else
  kh.py answers   print one week's questions next to the answers given
  kh.py plan      the spec for NEXT week
  kh.py curriculum  the weekly brief

WHAT PUSH WRITES, AND WHY IT IS NARROW
--------------------------------------
The Worker owns marks. It marks each submission, records who decided every
question and recomputes the totals from its own rows, so a tool that pushed
`data/` wholesale would undo real marking with a stale local copy. That is not
hypothetical: the migration script this replaced did exactly that, and wiped a
submitted week along with the parent's marking queue.

So push writes only what a human authors during the weekly cycle:

  * the week write up: notes, summary, verdict, wins, errors, designIssues,
    hintedSections
  * gaps and their per week observation log
  * the curriculum position
  * next week's question set, and the current_week pointer that selects it

Scores, per question answers and the decision queue belong to the Worker and are
never written from here, unless --include-scores is passed to repair a week by
hand.

Credentials are read from CLAUDE.md in this folder and never printed.
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
SCHEMA = os.path.join(ROOT, "schema")
SPINE = os.path.join(ROOT, "curriculum", "spine.json")
POSITION = os.path.join(DATA, "curriculum", "position.json")
ROADMAP = os.path.join(ROOT, "assets", "roadmap.json")
CLAUDE_MD = os.path.join(ROOT, "CLAUDE.md")

CHILDREN = ("mason", "elysia")
SUBJECT_BY_PREFIX = {"1": "english", "2": "maths", "3": "thinking"}
# /admin/sql runs one batch per request and the Worker caps a batch at 500.
SQL_CHUNK = 400
UA = "kids-homework-cli/1.0"


# --------------------------------------------------------------------------
# credentials
# --------------------------------------------------------------------------

def creds():
    if not os.path.exists(CLAUDE_MD):
        die(f"CLAUDE.md not found at {CLAUDE_MD}. It holds the keys and is never committed.")
    txt = open(CLAUDE_MD, encoding="utf-8").read()

    def grab(pattern, label):
        m = re.search(pattern, txt, re.M)
        if not m:
            die(f"could not find {label} in CLAUDE.md")
        return m.group(1).strip()

    return {
        "api": grab(r"^\| API \| (https://\S+?)\s*\|", "the API base URL"),
        "token": grab(r"Worker admin token:\s*`([^`]+)`", "the Worker admin token"),
    }


def mask(key):
    return key[:6] + "..."


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------

def die(msg):
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


def now_stamp():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")


def today():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def read_json(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, indent=2, ensure_ascii=False, sort_keys=False)
        fh.write("\n")


# --------------------------------------------------------------------------
# the API
# --------------------------------------------------------------------------

def _request(c, path, payload=None, timeout=60):
    url = f"{c['api']}{path}"
    data = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None
    req = urllib.request.Request(
        url, data=data, method="POST" if data else "GET",
        headers={
            "Authorization": f"Bearer {c['token']}",
            "Content-Type": "application/json",
            "User-Agent": UA,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:300]
        die(f"{path} failed: HTTP {e.code} {body}")
    except urllib.error.URLError as e:
        die(f"{path} failed: {e.reason}. Is the Worker deployed and reachable?")


def api_export(c):
    """Everything the dashboard sees, for both children."""
    return _request(c, "/admin/export")


def api_query(c, sql, params=None):
    out = _request(c, "/admin/query", {"sql": sql, "params": params or []})
    return out.get("results") or []


def api_sql(c, statements, label=""):
    """Run write statements, chunked to the Worker's batch cap. Each chunk is one
    transaction; the chunks are not one transaction between them, so a statement
    list must be ordered so that a partial run leaves nothing contradictory."""
    done = 0
    for i in range(0, len(statements), SQL_CHUNK):
        chunk = statements[i:i + SQL_CHUNK]
        _request(c, "/admin/sql", {"statements": chunk})
        done += len(chunk)
        if len(statements) > SQL_CHUNK:
            print(f"    {label} {done}/{len(statements)}")
    return done


def st(sql, *params):
    """One statement for /admin/sql. Parameterised, never interpolated."""
    return {"sql": sql, "params": list(params)}


def jdump(v):
    """A JSON column, or NULL when there is nothing in it."""
    return json.dumps(v, ensure_ascii=False) if v else None


def subjects_from_section_marks(section_marks, sections=None):
    """Roll section marks up per subject. Section ids look like 1A, 2B, 3C and
    the leading digit is the subject. When the week's question set is on hand we
    use its declared subject and totalMarks instead, which is exact."""
    out = {}
    if sections:
        for sec in sections:
            subj = sec.get("subject") or SUBJECT_BY_PREFIX.get(str(sec["id"])[:1])
            if not subj:
                continue
            slot = out.setdefault(subj, {"marks": 0, "outOf": 0})
            slot["marks"] += section_marks.get(sec["id"], 0) or 0
            slot["outOf"] += sec.get("totalMarks", 0) or 0
        return out
    for sid, marks in (section_marks or {}).items():
        subj = SUBJECT_BY_PREFIX.get(str(sid)[:1])
        if not subj:
            continue
        slot = out.setdefault(subj, {"marks": 0, "outOf": 0})
        slot["marks"] += marks or 0
    return out


# --------------------------------------------------------------------------
# pull
# --------------------------------------------------------------------------

def normalise_week(child, raw, answers, sections=None):
    """One API week record in the on disk shape. Same fields for every week,
    whatever era it came from."""
    total = raw.get("total")
    out_of = raw.get("outOf")
    rec = {
        "schemaVersion": 2,
        "child": child,
        "week": raw["week"],
        "source": "api",
        "score": {
            "total": total,
            "outOf": out_of,
            "pct": round(total / out_of * 100) if total is not None and out_of else None,
        },
        "subjects": {},
        "sectionMarks": raw.get("sectionMarks") or {},
        "answers": answers or {},
        "submittedAt": raw.get("submittedAt"),
        "adjustedAt": raw.get("adjustedAt"),
        "notes": raw.get("notes") or "",
        "summary": raw.get("summary") or "",
        "verdict": raw.get("verdict"),
        "wins": raw.get("wins") or [],
        "errors": raw.get("errors") or [],
        "designIssues": raw.get("designIssues") or [],
        "hintedSections": raw.get("hintedSections") or [],
        "elapsedSecs": raw.get("elapsedSecs"),
        "unanswered": raw.get("unanswered"),
    }
    if rec["sectionMarks"]:
        rec["subjects"] = subjects_from_section_marks(rec["sectionMarks"], sections)
    return rec


def cmd_pull(args):
    c = creds()
    print(f"reading {c['api']} with admin token {mask(c['token'])}")
    export = api_export(c)

    snap = os.path.join(DATA, "snapshots", now_stamp())
    write_json(os.path.join(snap, "export.json"), export)
    print(f"raw snapshot -> {os.path.relpath(snap, ROOT)}")

    qrows = api_query(c, "SELECT child_id, week, payload FROM question_set ORDER BY child_id, week")
    arows = api_query(c, "SELECT child_id, week, question_id, given FROM answer")

    qsets = {}
    for r in qrows:
        try:
            qsets[(r["child_id"], r["week"])] = json.loads(r["payload"])
        except (ValueError, TypeError) as e:
            print(f"  warning: {r['child_id']} week {r['week']} question set did not parse ({e})")

    answers_by = {}
    for r in arows:
        answers_by.setdefault((r["child_id"], r["week"]), {})[r["question_id"]] = r["given"]

    manifest = {"pulledAt": datetime.now(timezone.utc).isoformat(), "api": c["api"], "children": {}}

    for child in CHILDREN:
        d = export.get(child) or {}
        base = os.path.join(DATA, "children", child)
        profile_in = d.get("profile") or {}
        cur_week = profile_in.get("current_week")

        # question sets, including the week being sat now
        qdir = os.path.join(base, "question-sets")
        for stale in sorted(os.listdir(qdir)) if os.path.isdir(qdir) else []:
            os.remove(os.path.join(qdir, stale))
        sections_by_week = {}
        for (ch, wk), payload in sorted(qsets.items()):
            if ch != child:
                continue
            sections_by_week[wk] = payload.get("sections") or []
            write_json(os.path.join(qdir, f"w{wk:02d}.json"), payload)

        current = qsets.get((child, cur_week)) if cur_week else None
        if current:
            write_json(os.path.join(DATA, "current", f"{child}.json"), current)

        # weeks
        weeks = {}
        for raw in d.get("weeks") or []:
            weeks[raw["week"]] = normalise_week(
                child, raw, answers_by.get((child, raw["week"])), sections_by_week.get(raw["week"]))

        wdir = os.path.join(base, "weeks")
        for stale in sorted(os.listdir(wdir)) if os.path.isdir(wdir) else []:
            os.remove(os.path.join(wdir, stale))
        for num in sorted(weeks):
            write_json(os.path.join(wdir, f"w{num:02d}.json"), weeks[num])

        # gaps. The API reports an observation as 1, 0 or null; keep it that way
        # on disk so one representation travels end to end.
        gaps = []
        for g in d.get("gaps") or []:
            gaps.append({
                "topic": g.get("topic"),
                "detail": g.get("detail") or "",
                "status": g.get("status"),
                "slot": g.get("slot"),
                "rung": g.get("rung"),
                "parkedUntil": g.get("parkedUntil"),
                "weeks": g.get("weeks") or [],
            })
        write_json(os.path.join(base, "gaps.json"), gaps)

        if d.get("position"):
            allpos = read_json(POSITION, {"schemaVersion": 1, "children": {}})
            allpos.setdefault("children", {})[child] = d["position"]
            write_json(POSITION, allpos)

        profile = {
            "child": child,
            "displayName": profile_in.get("display_name") or child.capitalize(),
            "kumonLevel": {k: v for k, v in (
                ("maths", profile_in.get("kumon_maths")),
                ("english", profile_in.get("kumon_english")),
            ) if v},
            "currentWeek": cur_week,
            "marksOutOf": profile_in.get("marks_total"),
        }
        write_json(os.path.join(base, "profile.json"), profile)

        active = [g for g in gaps if g.get("status") in ("new", "persists", "improving")]
        manifest["children"][child] = {
            "weeks": len(weeks),
            "weekRange": [min(weeks), max(weeks)] if weeks else None,
            "weeksWithAnswers": sum(1 for w in weeks.values() if w["answers"]),
            "questionSets": sorted(wk for (ch, wk) in qsets if ch == child),
            "gaps": {"total": len(gaps), "active": len(active),
                     "resolved": sum(1 for g in gaps if g.get("status") == "resolved")},
            "openDecisions": len(d.get("decisions") or []),
            "currentWeek": cur_week,
        }
        info = manifest["children"][child]
        print(f"  {child:7s} weeks {info['weekRange']} ({info['weeks']}), "
              f"answers for {info['weeksWithAnswers']}, gaps {info['gaps']['active']} active / "
              f"{info['gaps']['resolved']} resolved, question sets {info['questionSets']}, "
              f"{info['openDecisions']} open decision(s)")

    write_json(os.path.join(DATA, "index.json"), manifest)
    print("done")


# --------------------------------------------------------------------------
# push
# --------------------------------------------------------------------------

def load_local():
    out = {}
    for child in CHILDREN:
        base = os.path.join(DATA, "children", child)
        wdir = os.path.join(base, "weeks")
        if not os.path.isdir(wdir):
            die(f"no local data for {child}. Run: kh.py pull")
        weeks = [read_json(os.path.join(wdir, f)) for f in sorted(os.listdir(wdir)) if f.endswith(".json")]
        qdir = os.path.join(base, "question-sets")
        qsets = {}
        if os.path.isdir(qdir):
            for f in sorted(os.listdir(qdir)):
                if f.endswith(".json"):
                    qsets[int(f[1:-5])] = read_json(os.path.join(qdir, f))
        out[child] = {
            "weeks": sorted(weeks, key=lambda w: w["week"]),
            "gaps": read_json(os.path.join(base, "gaps.json"), []),
            "profile": read_json(os.path.join(base, "profile.json"), {}),
            "current": read_json(os.path.join(DATA, "current", f"{child}.json")),
            "questionSets": qsets,
        }
    return out


def build_statements(local, include_scores=False):
    """The statements push will run, in an order that is safe to stop part way.

    Question sets and the week rows they need come first, so the current_week
    pointer is never moved onto a week whose questions have not landed."""
    position = read_json(POSITION, {"children": {}})
    plan = {"question_set": [], "week": [], "gap": [], "position": [], "pointer": []}

    for child in CHILDREN:
        d = local[child]
        cur = d["current"]

        sets = dict(d["questionSets"])
        if cur:
            sets[cur["weekNum"]] = cur
        for wk, payload in sorted(sets.items()):
            plan["question_set"].append(st(
                "INSERT INTO question_set (child_id, week, payload) VALUES (?, ?, ?) "
                "ON CONFLICT(child_id, week) DO UPDATE SET payload = excluded.payload",
                child, wk, json.dumps(payload, ensure_ascii=False, separators=(",", ":"))))

        for w in d["weeks"]:
            wk = w["week"]
            # The write up only. An UPDATE, not an upsert: a week the Worker has
            # no row for has not been sat, and inventing one here is how a local
            # copy comes to disagree with what actually happened.
            plan["week"].append(st(
                "UPDATE week SET notes = ?, summary = ?, verdict = ?, wins = ?, errors = ?, "
                "design_issues = ?, hinted_sections = ? WHERE child_id = ? AND week = ?",
                w.get("notes") or None, w.get("summary") or None, w.get("verdict"),
                jdump(w.get("wins")), jdump(w.get("errors")), jdump(w.get("designIssues")),
                jdump(w.get("hintedSections")), child, wk))

            if include_scores:
                s = w["score"]
                plan["week"].append(st(
                    "INSERT INTO week (child_id, week, total, out_of, submitted_at) "
                    "VALUES (?, ?, ?, ?, ?) ON CONFLICT(child_id, week) DO UPDATE SET "
                    "total = excluded.total, out_of = excluded.out_of",
                    child, wk, s["total"], s["outOf"], w.get("submittedAt")))
                for sid, marks in (w.get("sectionMarks") or {}).items():
                    out_of = 0
                    qs = sets.get(wk)
                    if qs:
                        out_of = next((x.get("totalMarks", 0) for x in qs.get("sections", [])
                                       if x["id"] == sid), 0)
                    plan["week"].append(st(
                        "INSERT INTO section_mark (child_id, week, section_id, marks, out_of) "
                        "VALUES (?, ?, ?, ?, ?) ON CONFLICT(child_id, week, section_id) "
                        "DO UPDATE SET marks = excluded.marks",
                        child, wk, sid, marks, out_of))

        # Gaps have no stable id in the local copy, only their topic, so they are
        # rebuilt per child rather than matched. Cheap, and always correct.
        plan["gap"].append(st(
            "DELETE FROM gap_observation WHERE gap_id IN (SELECT id FROM gap WHERE child_id = ?)",
            child))
        plan["gap"].append(st("DELETE FROM gap WHERE child_id = ?", child))
        recorded = [w["week"] for w in d["weeks"]]
        last = recorded[-1] if recorded else 0
        for g in d["gaps"]:
            obs = g.get("weeks") or []
            start = last - len(obs) + 1
            plan["gap"].append(st(
                "INSERT INTO gap (child_id, topic, detail, status, slot, rung, parked_until, "
                "opened_week) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                child, g.get("topic"), g.get("detail") or "", g.get("status"),
                g.get("slot"), g.get("rung"), g.get("parkedUntil"), start))
            for i, result in enumerate(obs):
                val = None if result is None else (1 if result else 0)
                plan["gap"].append(st(
                    "INSERT INTO gap_observation (gap_id, week, result) SELECT id, ?, ? FROM gap "
                    "WHERE child_id = ? AND topic = ? "
                    "ON CONFLICT(gap_id, week) DO UPDATE SET result = excluded.result",
                    start + i, val, child, g.get("topic")))

        here = ((position.get("children") or {}).get(child) or {}).get("slots") or {}
        for slot, info in here.items():
            plan["position"].append(st(
                "INSERT INTO position (child_id, slot, rung, since_week, note) VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(child_id, slot) DO UPDATE SET rung = excluded.rung, "
                "since_week = excluded.since_week, note = excluded.note",
                child, slot, info.get("rung"), info.get("since"), info.get("note")))

        if cur:
            plan["pointer"].append(st(
                "UPDATE child SET current_week = ?, marks_total = ? WHERE id = ?",
                cur["weekNum"],
                sum(s.get("totalMarks", 0) for s in cur.get("sections", [])) or None,
                child))
        if d["profile"].get("kumonLevel"):
            k = d["profile"]["kumonLevel"]
            plan["pointer"].append(st(
                "UPDATE child SET kumon_maths = ?, kumon_english = ? WHERE id = ?",
                k.get("maths"), k.get("english"), child))

    return plan


def cmd_push(args):
    local = load_local()
    problems = validate(local)
    if os.path.exists(SPINE):
        spine = load_spine()
        problems += check_curriculum(local, spine)
        problems += check_coverage(local, spine)
        problems += check_nsw_alignment(spine, local)
    if problems:
        for p in problems:
            print(f"  {p}")
        die(f"{len(problems)} validation problem(s). Nothing pushed.")

    plan = build_statements(local, include_scores=args.include_scores)
    order = ["question_set", "week", "gap", "position", "pointer"]
    total = sum(len(plan[k]) for k in order)

    print("about to write:")
    for k in order:
        if plan[k]:
            print(f"  {k:14s} {len(plan[k]):>5} statement(s)")
    for child in CHILDREN:
        cur = local[child]["current"]
        if cur:
            print(f"  {child:7s} current week -> W{cur['weekNum']}, "
                  f"{sum(s.get('totalMarks', 0) for s in cur.get('sections', []))} marks")
    if args.include_scores:
        print("  --include-scores is ON: scores and section marks will be overwritten "
              "from the local copy")
    print("\n  marks, per question answers and the decision queue are NOT written: "
          "the Worker owns those.")

    if not args.yes:
        if input(f"\npush {total} statement(s) to the API? type yes: ").strip().lower() != "yes":
            print("cancelled, nothing written")
            return

    c = creds()
    snap = os.path.join(DATA, "snapshots", now_stamp() + "-prepush")
    write_json(os.path.join(snap, "export.json"), api_export(c))
    print(f"pre-push snapshot -> {os.path.relpath(snap, ROOT)}")

    for k in order:
        if plan[k]:
            api_sql(c, plan[k], label=k)
            print(f"  {k:14s} {len(plan[k]):>5} written")

    # Read back the things that are cheap to verify and expensive to get wrong.
    after = api_export(c)
    for child in CHILDREN:
        cur = local[child]["current"]
        got = ((after.get(child) or {}).get("profile") or {}).get("current_week")
        if cur and got != cur["weekNum"]:
            die(f"{child}: current week reads back as {got}, expected {cur['weekNum']}")
        want_gaps = len(local[child]["gaps"])
        got_gaps = len((after.get(child) or {}).get("gaps") or [])
        if got_gaps != want_gaps:
            die(f"{child}: {got_gaps} gaps read back, expected {want_gaps}")
    print("read back: current week and gap counts match for both children")
    print("done")


# --------------------------------------------------------------------------
# validate
# --------------------------------------------------------------------------

def validate(local=None):
    local = local or load_local()
    problems = []
    # validate runs with or without the spine present, so the gap slot check
    # falls back to the old 1A..3C grid when there is none
    spine_slots = load_spine()["slots"] if os.path.exists(SPINE) else {}
    for child in CHILDREN:
        d = local[child]
        seen = set()
        for w in d["weeks"]:
            tag = f"{child} w{w.get('week')}"
            if w.get("schemaVersion") != 2:
                problems.append(f"{tag}: schemaVersion is {w.get('schemaVersion')}, expected 2")
            if w.get("week") in seen:
                problems.append(f"{tag}: duplicate week number")
            seen.add(w.get("week"))
            score = w.get("score") or {}
            if not isinstance(score.get("total"), int) or not isinstance(score.get("outOf"), int):
                problems.append(f"{tag}: score.total and score.outOf must both be whole numbers")
                continue
            if score["total"] > score["outOf"]:
                problems.append(f"{tag}: total {score['total']} is above outOf {score['outOf']}")
            if score["total"] < 0:
                problems.append(f"{tag}: total is negative")
            sm = w.get("sectionMarks") or {}
            if sm and sum(sm.values()) != score["total"]:
                problems.append(f"{tag}: sectionMarks sum to {sum(sm.values())} but total says {score['total']}")
            for subj, vals in (w.get("subjects") or {}).items():
                if vals.get("outOf") and vals.get("marks") is not None and vals["marks"] > vals["outOf"]:
                    problems.append(f"{tag}: {subj} {vals['marks']} is above its max {vals['outOf']}")
        weeks = sorted(seen)
        for a, b in zip(weeks, weeks[1:]):
            if b != a + 1:
                problems.append(f"{child}: gap in week numbers between {a} and {b}")
        for g in d["gaps"]:
            known = list(spine_slots) if spine_slots else [f"{a}{b}" for a in "123" for b in "ABC"]
            if g.get("slot") and g["slot"] not in known:
                problems.append(f"{child} gap '{str(g.get('topic'))[:40]}': slot {g['slot']!r} is "
                                f"not one of {', '.join(known)}")
            if g.get("status") not in ("new", "persists", "improving", "resolved", "parked"):
                problems.append(f"{child} gap '{str(g.get('topic'))[:40]}': bad status {g.get('status')!r}")
            if not g.get("topic") or not isinstance(g.get("weeks"), list):
                problems.append(f"{child} gap '{str(g.get('topic'))[:40]}': needs a topic and a weeks list")
        cur = d["current"]
        if cur:
            for sec in cur.get("sections", []):
                qsum = sum(q.get("marks", 0) for q in sec.get("questions", []))
                if not sec.get("scoreBand") and qsum != sec.get("totalMarks"):
                    problems.append(f"{child} current section {sec.get('id')}: question marks sum to "
                                    f"{qsum} but totalMarks says {sec.get('totalMarks')}")
                for q in sec.get("questions", []):
                    if q.get("autoMark") and not q.get("accepted"):
                        problems.append(f"{child} {q.get('id')}: autoMark is on but accepted[] is empty")
                    if q.get("inputType") not in ("text", "number", "letter", "multiline", "none"):
                        problems.append(f"{child} {q.get('id')}: unknown inputType {q.get('inputType')!r}")
    return problems



# --------------------------------------------------------------------------
# curriculum
# --------------------------------------------------------------------------

def load_spine():
    spine = read_json(SPINE)
    if not spine:
        die(f"curriculum/spine.json not found at {SPINE}")
    return spine


def current_term(spine, when=None):
    """The school half term that today falls in, for slot 2C.

    Falls back to the last row when the table has run out, which is why
    `check_nsw_alignment` refuses a push once today is past it. The table used
    to end at Summer 2 2027: from 23 July 2027 every plan would have claimed
    statistics and properties of shape for ever, and nothing would have said so."""
    when = when or today()
    for t in spine["schoolSync"]["terms"]:
        if when <= t["ends"]:
            return t
    return spine["schoolSync"]["terms"][-1]


def term_table_exhausted(spine, when=None):
    when = when or today()
    return when > spine["schoolSync"]["terms"][-1]["ends"]


def nsw_routes(spine, child):
    """Every exam item family this child has a route to, and where it is.

    A route is a rung that declares the family, or a school term that does for
    slot 2C. A family with NO route is the plan quietly saying the child will
    never meet it: on 11 Oct 2026 Mason had one (probability) and Elysia had
    thirteen, including all five writing families and four of the maths ones the
    OC paper assumes. The ladders were extended at the top rather than reset."""
    routes = {}
    for sid, ladder in (spine["ladders"].get(child) or {}).items():
        for rung in ladder["rungs"]:
            for fid in rung.get("nswFamilies") or []:
                routes.setdefault(fid, f"{sid} rung {rung['id']}")
    for t in spine["schoolSync"]["terms"]:
        for fid in (t.get("families") or {}).get(child) or []:
            routes.setdefault(fid, f"2C in {t['term']}")
    return routes


def components_for(spine, child):
    """The test components this child actually sits, across all their tests."""
    out = set()
    for t in spine["goals"][child].get("tests") or []:
        out.update(t.get("components") or [])
    return out


def slot_of(qid_or_section):
    """Section ids look like 1A or 1D and question ids like 1A-Q3, so the slot is
    the first two characters."""
    return str(qid_or_section)[:2]


def nsw_families(slot, child):
    """The exam item families a slot serves for this child.

    Declared either as one list for both children, or as an object keyed by
    child when they differ: Mason's 2B is the working backwards item type and
    Elysia's is still column arithmetic, so one list could not describe both."""
    ids = slot.get("nswFamilies")
    if isinstance(ids, dict):
        return list(ids.get(child) or [])
    return list(ids or [])


def slots_for(spine, child, week=None):
    """The slots that apply to this child, in spine order.

    A slot may carry `children`, naming the only children it applies to, and
    `from`, the first week number it is expected in. Slot 1D, writing, is
    Mason only and starts at week 25: without the week guard, adding it would
    have made the already published week 24 fail validation, and `push` refuses
    on a failed validation, so the whole CLI would have been stuck behind a
    change to a future week."""
    out = {}
    for sid, slot in spine["slots"].items():
        only = slot.get("children")
        if only and child not in only:
            continue
        start = slot.get("from")
        if isinstance(start, dict):
            start = start.get(child)
        if start is not None and week is not None and week < start:
            continue
        # A slot may instead open on a DATE, which is the honest trigger when the
        # week number it lands on cannot be known. Elysia's writing slot opens in
        # September 2029, once the OC test is behind her: guessing a week number
        # that far out would have been false precision, and leaving the slot off
        # her ladders entirely read as a plan that she would never write.
        on = slot.get("fromDate")
        if isinstance(on, dict):
            on = on.get(child)
        if on is not None and today() < on:
            continue
        out[sid] = slot
    return out


def nsw_state(spine, child, week, position, when=None):
    """Which exam item families this child is ACTUALLY working on right now.

    Derived, never stored, from three things only: which slots are live for the
    child this week, the rung each slot is recorded at, and the school term for
    slot 2C. It returns (current, reachable, owner), where `current` is the
    families the live rung delivers, `reachable` maps every family to the first
    rung that delivers it, and `owner` maps a family to the slots that can.

    This exists because `assets/roadmap.json` used to hand-write which families
    were current, and on 11 Oct 2026 that map claimed 21 of them for Mason when
    five were true. It said writing to a brief was in the weekly homework while
    slot 1D did not exist until week 25 and he had never typed a response, and
    it claimed measurement and area while their own reasons said Autumn 2 and
    Spring 1. A map that records where each slot is heading, under a label that
    reads "in the weekly homework now", reports work that is not happening."""
    live = slots_for(spine, child, week)
    pos = ((position.get("children") or {}).get(child) or {}).get("slots") or {}
    current, reachable, owner = set(), {}, {}

    for sid, slot in sorted(spine["slots"].items()):
        for fid in nsw_families(slot, child):
            owner.setdefault(fid, []).append(sid)

    for sid, slot in sorted(live.items()):
        if slot.get("familiesFrom") == "schoolSync":
            # 2C follows the school's half term, so the term decides, not a rung.
            term = current_term(spine, when)
            for fid in (term.get("families") or {}).get(child) or []:
                current.add(fid)
                reachable.setdefault(fid, f"{sid} in {term['term']}")
            continue
        ladder = (spine["ladders"].get(child) or {}).get(sid)
        if not ladder:
            continue
        rungs = ladder["rungs"]
        at = pos.get(sid, {}).get("rung")
        idx = next((i for i, r in enumerate(rungs) if r["id"] == at), None)
        for i, r in enumerate(rungs):
            for fid in r.get("nswFamilies") or []:
                if fid not in reachable:
                    reachable[fid] = r["id"]
                if idx is not None and i <= idx:
                    current.add(fid)
    return current, reachable, owner

def cmd_curriculum(args):
    """Print the brief: the map, where the child stands on it, what is blocking
    each slot, and what next week must therefore contain."""
    spine = load_spine()
    position = read_json(POSITION, {"children": {}})
    local = load_local()
    children = [args.child] if args.child else list(CHILDREN)
    term = current_term(spine)

    for child in children:
        goal = spine["goals"][child]
        pos = (position.get("children") or {}).get(child, {})
        slots = pos.get("slots", {})
        gaps = [g for g in local[child]["gaps"] if g.get("status") != "resolved"]
        cur = local[child]["current"] or {}
        weeks = local[child]["weeks"]
        latest = weeks[-1] if weeks else None

        print("=" * 78)
        print(f"{child.upper()}  target: {goal['target']}")
        print("=" * 78)
        print(f"  end state : {goal['endState']}")
        print(f"  posture   : {goal['currentPosture']}")
        m = goal["weeklyMarks"]
        print(f"  marks     : {m['total']} total, English {m['english']}, "
              f"Maths {m['maths']}, Thinking {m['thinking']}")
        if latest:
            print(f"  last week : W{latest['week']} {latest['score']['total']}/"
                  f"{latest['score']['outOf']} ({latest['score']['pct']}%)")
        print(f"  next week : W{(cur.get('weekNum') or 0)} is loaded now; "
              f"position recorded as of W{pos.get('asOfWeek', '?')}")
        print(f"  school    : {term['term']} to {term['ends']}, "
              f"2C topic is \"{term[child]}\""
              + ("  (PLANNED, not the school's published topic)"
                 if term.get("source") == "planned" else ""))
        for t in goal.get("tests") or []:
            print(f"  sits      : {t['name']}, {t['when']}, "
                  f"{', '.join(t['components'])}, {t['weightEach']} each")

        # Progress against the papers, which is the only scoreboard that matters.
        # Counted per component so a strong week in one cannot hide a component at
        # zero: that is how Thinking Skills sat at nothing for both children while
        # they scored near full marks on the weekly Thinking sections.
        roadmap = read_json(ROADMAP) or {}
        nsw = ((roadmap.get("tracks") or {}).get("nsw") or {})
        week_now = cur.get("weekNum")
        live, reachable, _ = nsw_state(spine, child, week_now, position)
        routes = nsw_routes(spine, child)
        if nsw:
            print("  NSW PAPERS, families in the week now / with a route / on the paper:")
            for sec in nsw["sections"]:
                ids = [i["id"] for i in sec["items"]]
                inweek = [f for f in ids if f in live]
                routed = [f for f in ids if f in routes]
                flag = "  <- nothing in the week" if not inweek else ""
                print(f"    {sec['label']:26s} {len(inweek)} / {len(routed)} / {len(ids)}{flag}")
                if inweek:
                    print(f"      in the week: {', '.join(inweek)}")
            noroute = sorted(set(f for sec in nsw["sections"] for f in [i['id'] for i in sec['items']])
                             - set(routes))
            if noroute:
                print(f"    NO ROUTE AT ALL: {', '.join(noroute)}")
        for lim in expiring_limits(spine, child):
            print(f"  BAN LIFTS : {lim['until']}, {lim['rule'][:70]}")
        print()

        for slot_id, slot in sorted(slots_for(spine, child).items()):
            ladder = spine["ladders"][child][slot_id]
            here = slots.get(slot_id, {})
            rungs = ladder["rungs"]
            idx = next((i for i, r in enumerate(rungs) if r["id"] == here.get("rung")), None)

            # A gap can name its slot explicitly. Older gaps do not, so fall back to
            # looking for the slot id in the text, which is how they were written up.
            slot_gaps = [g for g in gaps if (g.get("slot") == slot_id)
                         or (not g.get("slot") and (slot_id in (g.get("detail") or "")
                                                    or slot_id in (g.get("topic") or "")))]
            blocking = [g for g in slot_gaps if g["status"] in ("new", "persists")]

            section = next((x for x in cur.get("sections", []) if x["id"] == slot_id), None)
            marks = f"{section['totalMarks']}m" if section else "?"

            print(f"  [{slot_id}] {slot['purpose']}  ({marks}, {slot['subject']})")
            print(f"       goal   : {ladder['endGoal']}")
            if idx is None:
                print("       RUNG   : not recorded. Set it in data/curriculum/position.json.")
            else:
                r = rungs[idx]
                print(f"       rung   : {r['id']} {r['skill']}")
                print(f"       advance: {r['advanceWhen']}")
                nxt = rungs[idx + 1] if idx + 1 < len(rungs) else None
                print(f"       next   : {nxt['id'] + ' ' + nxt['skill'] if nxt else 'top of the ladder, keep sustaining'}")
            if here.get("note"):
                print(f"       note   : {here['note']}")
            if blocking:
                print(f"       HOLD   : {len(blocking)} open gap(s) attached, re-test this rung, do not advance")
                for g in blocking:
                    print(f"                - [{g['status']}] {g['topic'][:70]}")
            if section and slot.get("fixed"):
                fams = nsw_families(slot, child)
            if fams:
                rung_now = rungs[idx] if idx is not None else None
                delivering = sorted(set(rung_now.get("nswFamilies") or []) if rung_now else [])
                if slot.get("familiesFrom") == "schoolSync":
                    delivering = (term.get("families") or {}).get(child) or []
                print(f"       serves : {', '.join(fams)}")
                print(f"       now    : {', '.join(delivering) if delivering else 'nothing yet, a step on the way'}")
            print(f"       fixed  : {slot['fixed']}")
            print()

        unattached = [g for g in gaps
                      if not g.get("slot")
                      and not any(s in (g.get("detail") or "") + (g.get("topic") or "")
                                  for s in spine["slots"])]
        if unattached:
            print(f"  gaps not tied to a slot ({len(unattached)}), decide where each is tested:")
            for g in unattached:
                print(f"    [{g['status']:9s}] {g['topic'][:68]}")
            print()

        limits = spine["hardLimits"].get(child, []) + spine["hardLimits"]["both"]
        print(f"  HARD LIMITS ({len(limits)}), a week that breaks one is wrong:")
        for lim in limits:
            print(f"    - {lim['rule']}")
            if lim.get("note"):
                print(f"      NOTE: {lim['note']}")
        print()
        # A retired entry is an object: {shape, example, why, retiredOn}. This
        # printed it as if it were a string, so `curriculum <child>` crashed
        # with a TypeError the moment the first shape was retired on 11 Oct.
        retired = spine["retired"].get(child) or []
        print(f"  retired item shapes, never generate again ({len(retired)}):")
        if not retired:
            print("    none yet")
        for r in retired:
            print(f"    - {r['shape']}")
            if r.get("why"):
                print(f"      why: {r['why']}")
        print()


# --------------------------------------------------------------------------
# automated curriculum checks, run as part of validate
# --------------------------------------------------------------------------

ELYSIA_BANNED_TABLES = (7, 8, 9, 11, 12)


def live_limits(spine, child, when=None):
    """The hard limits that still apply to this child today.

    A limit may carry `until`, an ISO date after which it stops applying, and
    Elysia's three bans are the reason the field exists. The 7, 8, 9, 11 and 12
    tables, written multiplication and division, and time to the minute are all
    correct for her UK school year and all assumed by the OC paper in 2029. A
    ban with no expiry date is how a protective rule becomes the reason a child
    is not ready, so the dates are in the spine and enforcement stops on them."""
    when = when or today()
    out = []
    for lim in list(spine["hardLimits"].get(child, [])) + list(spine["hardLimits"]["both"]):
        if lim.get("until") and when >= lim["until"]:
            continue
        out.append(lim)
    return out


def expiring_limits(spine, child, when=None, within_days=120):
    """Limits whose expiry date is close, so `plan` can count down to it."""
    when = when or today()
    soon = (date.fromisoformat(when) + timedelta(days=within_days)).isoformat()
    out = []
    for lim in list(spine["hardLimits"].get(child, [])) + list(spine["hardLimits"]["both"]):
        if lim.get("until") and when < lim["until"] <= soon:
            out.append(lim)
    return out


def check_curriculum(local, spine):
    """The hardLimits marked check: automated. These are the rules that have
    actually been broken in the past, so they are machine checked rather than
    trusted to a reading."""
    problems = []

    for child in CHILDREN:
        cur = local[child]["current"]
        if not cur:
            continue
        ladder = spine["ladders"][child]
        week = cur.get("weekNum")

        for sec in cur.get("sections", []):
            sid = sec.get("id")
            if sid not in spine["slots"]:
                problems.append(f"{child} W{week}: section {sid} is not a slot in the spine")
                continue
            want = spine["slots"][sid]["subject"]
            if sec.get("subject") != want:
                problems.append(f"{child} W{week} {sid}: subject is {sec.get('subject')!r}, "
                                f"the spine says this slot is always {want!r}")
            if sid not in ladder:
                problems.append(f"{child} W{week} {sid}: no ladder for this slot")

            texts = " ".join(str(q.get("text", "")) for q in sec.get("questions", []))

            # no more than 2 identical short answers in one section
            if not sec.get("scoreBand"):
                firsts = [str(q["accepted"][0]).strip().lower()
                          for q in sec.get("questions", [])
                          if q.get("autoMark") and q.get("accepted")]
                for val in set(firsts):
                    if firsts.count(val) > 2:
                        problems.append(f"{child} W{week} {sid}: the answer {val!r} appears "
                                        f"{firsts.count(val)} times, the limit is 2")

            # no em dashes in child facing text
            facing = texts + " " + str(sec.get("passage", "")) + " " + str(sec.get("title", ""))
            if "\u2014" in facing:
                problems.append(f"{child} W{week} {sid}: contains an em dash in child facing text")

            if child != "elysia":
                continue

            live = {lim["id"] for lim in live_limits(spine, child)}

            # Elysia only: the three limits that have been broken before. Each
            # stops being enforced on its `until` date in the spine.
            if "ely.tables" not in live and "ely.written-muldiv" not in live:
                continue
            for a, b in re.findall(r"(\d{1,3})\s*(?:x|\u00d7|\*)\s*(\d{1,3})", texts):
                for n in (int(a), int(b)):
                    if n in ELYSIA_BANNED_TABLES and "ely.tables" in live:
                        problems.append(f"{child} W{week} {sid}: uses the {n} times table "
                                        f"({a} x {b}), which is banned until school teaches it")
                if int(a) > 12 and int(b) > 12 and "ely.written-muldiv" in live:
                    problems.append(f"{child} W{week} {sid}: {a} x {b} is written multiplication, "
                                    "which is not taught yet")
            for a, b in re.findall(r"(\d{1,4})\s*(?:\u00f7|/)\s*(\d{1,3})", texts):
                if int(b) in ELYSIA_BANNED_TABLES and "ely.tables" in live:
                    problems.append(f"{child} W{week} {sid}: divides by {b}, a banned table")
                if int(a) > 100 and "ely.written-muldiv" in live:
                    problems.append(f"{child} W{week} {sid}: {a} divided by {b} is written "
                                    "division, which is not taught yet")

            # Time to the minute was banned here until 4 Oct 2026, when Nik confirmed
            # Elysia is already learning it at home. The spine carries it as rung
            # 2C.3b instead of as a prohibition.

    # the recorded position must point at rungs that exist
    position = read_json(POSITION, {"children": {}})
    for child, d in (position.get("children") or {}).items():
        for sid, here in (d.get("slots") or {}).items():
            if sid not in spine["ladders"].get(child, {}):
                problems.append(f"position: {child} {sid} is not a slot in the spine")
                continue
            ids = [r["id"] for r in spine["ladders"][child][sid]["rungs"]]
            if here.get("rung") not in ids:
                problems.append(f"position: {child} {sid} rung {here.get('rung')!r} "
                                f"is not on the ladder ({', '.join(ids)})")

    return problems



def cmd_plan(args):
    """The specification for the NEXT week, derived from the spine, the recorded
    position and the open gaps. Produce this BEFORE writing any questions, then
    build to it. It is what stops each week being designed from scratch."""
    spine = load_spine()
    position = read_json(POSITION, {"children": {}})
    local = load_local()
    term = current_term(spine)
    children = [args.child] if args.child else list(CHILDREN)

    for child in children:
        pos = (position.get("children") or {}).get(child, {})
        slots = pos.get("slots", {})
        gaps = [g for g in local[child]["gaps"] if g.get("status") != "resolved"]
        weeks = local[child]["weeks"]
        cur = local[child]["current"] or {}
        next_week = (cur.get("weekNum") or (weeks[-1]["week"] if weeks else 0)) + 1
        goal = spine["goals"][child]

        print("=" * 78)
        print(f"SPEC FOR {child.upper()} WEEK {next_week}")
        print("=" * 78)
        print(f"  total {goal['weeklyMarks']['total']} marks: "
              f"English {goal['weeklyMarks']['english']}, Maths {goal['weeklyMarks']['maths']}, "
              f"Thinking {goal['weeklyMarks']['thinking']}")
        print(f"  school term {term['term']} to {term['ends']}, 2C topic \"{term[child]}\"")
        if term.get("source") == "planned":
            print("  that term row is PLANNED, not the school's published topic. Replace it when "
                  "the school publishes.")

        # Why this week exists. Everything below is in service of these dates.
        for t in goal.get("tests") or []:
            print(f"  TARGET: {t['name']}, {t['when']}, "
                  f"{len(t['components'])} components at {t['weightEach']} each")
        routes = nsw_routes(spine, child)
        current, reachable, _ = nsw_state(spine, child, next_week, position)
        print(f"  exam item families: {len(current)} in the week at week {next_week}, "
              f"{len(routes)} with a route, of {len(routes)} on the papers they sit")
        quota = exam_format_quota(spine)
        first_ef = ((spine.get("examFormat") or {}).get("fromWeek") or {}).get(child)
        if first_ef is not None and next_week >= first_ef:
            print(f"  EXAM FORMAT: {quota} section(s) must be multiple choice this week, on a rung "
                  f"being CONSOLIDATED, four options or five for maths, exactly one key")
        soon = expiring_limits(spine, child)
        for lim in soon:
            print(f"  BAN LIFTS {lim['until']}: {lim['rule'][:84]}")
        print()

        # next_week, not this one: the spec is for the week being built, so a
        # slot that starts at week 25 belongs in the week 25 spec
        for sid, slot in sorted(slots_for(spine, child, next_week).items()):
            ladder = spine["ladders"][child][sid]
            rungs = ladder["rungs"]
            here = slots.get(sid, {})
            idx = next((i for i, r in enumerate(rungs) if r["id"] == here.get("rung")), None)
            rung = rungs[idx] if idx is not None else None

            # what blocks this slot
            blocking = [g for g in gaps
                        if (g.get("slot") == sid)
                        or (not g.get("slot") and sid in (g.get("detail") or "") + (g.get("topic") or ""))]
            blocking = [g for g in blocking if g["status"] in ("new", "persists")]

            # was the last attempt at this rung hinted, or inconclusive?
            last_marks = None
            if weeks and weeks[-1].get("sectionMarks"):
                last_marks = weeks[-1]["sectionMarks"].get(sid)
            last_section = next((x for x in cur.get("sections", []) if x["id"] == sid), None)
            # Hinted two ways: the section declared it when it was written, or the
            # weekly review found the rule printed in the questions and recorded it
            # in hintedSections afterwards. The second is the one a human notices,
            # so a spec that reads only the flag asks for evidence that cannot exist.
            last_hinted_list = (weeks[-1].get("hintedSections") or []) if weeks else []
            was_hinted = bool(last_section and last_section.get("hinted")) or sid in last_hinted_list
            # the spine wins when it fixes a slot's marks for this child: that
            # is how a re-split reaches the spec instead of last week's numbers
            # being copied forward for ever
            fixed = (slot.get("marks") or {}).get(child)
            out_of = fixed if fixed is not None else (
                last_section.get("totalMarks") if last_section else None)
            # The percentage must divide last week's marks by what last week was
            # OUT OF, not by what next week will be out of. Mason's English was
            # re-split on 11 Oct 2026, so 1B went from 6 marks to 5: his clean
            # 6 out of 6 then read as 120 percent and the spec offered to advance
            # the rung off it. A score over 100 is the signal that the two came
            # from different weeks.
            scored_out_of = None
            if weeks:
                qset = read_json(os.path.join(
                    DATA, "children", child, "question-sets", f"w{weeks[-1]['week']}.json"))
                if qset:
                    hit = next((x for x in qset.get("sections", []) if x["id"] == sid), None)
                    if hit:
                        scored_out_of = hit.get("totalMarks")
            denom = scored_out_of if scored_out_of else out_of
            pct = round(last_marks / denom * 100) if last_marks is not None and denom else None

            print(f"  [{sid}] {slot['purpose']}")
            print(f"       marks   : {out_of if out_of else '?'}   subject {slot['subject']}")
            if rung:
                print(f"       BUILD AT: {rung['id']} {rung['skill']}")
                print(f"       evidence: {rung['advanceWhen']}")
            else:
                print("       BUILD AT: rung not recorded. Set it before generating.")
            print(f"       format  : {slot['fixed']}")
            # The point of the slot, in the test's own terms. A section that
            # cannot name the item family it builds towards is the drift this
            # whole file exists to stop.
            fams = nsw_families(slot, child)
            if fams:
                here_now = sorted(set(rung.get("nswFamilies") or []) if rung else [])
                ahead = [f for f in fams if f not in here_now]
                print(f"       serves  : {', '.join(fams)}")
                if here_now:
                    print(f"       THIS RUNG DELIVERS: {', '.join(here_now)}")
                elif slot.get("familiesFrom") == "schoolSync":
                    tf = (term.get("families") or {}).get(child) or []
                    print(f"       THIS TERM DELIVERS: {', '.join(tf) if tf else 'nothing, which is a gap'}")
                else:
                    print("       THIS RUNG DELIVERS: nothing yet, it is a step on the way")
                if ahead:
                    print(f"       still ahead on this slot: {', '.join(ahead)}")
            else:
                print(f"       serves  : no exam family directly. {slot.get('nswRole','support')[:70]}")

            must = []
            if blocking:
                for g in blocking:
                    must.append(f"re-test the open gap: {g['topic'][:66]}")
            if was_hinted:
                must.append("last week was HINTED, so this week must be UNHINTED or the rung "
                            "still cannot be evidenced")
            if pct is not None and pct < 95:
                must.append(f"last score {pct}%, so open with a worked example box, then drill "
                            "at the same level")
            # A rung recorded as starting next week has never been sat, so last
            # week's score belongs to the rung BELOW it and says nothing about
            # advancing again. Without this the spec tells you to skip a rung the
            # child has not been tested on once.
            just_advanced = (here.get("since") or 0) >= next_week
            if just_advanced:
                must.append(f"rung {rung['id'] if rung else '?'} was set this week and has not "
                            "been sat yet, so build AT it and do not advance again")
            elif pct is not None and pct >= 95 and not blocking and not was_hinted:
                nxt = rungs[idx + 1] if idx is not None and idx + 1 < len(rungs) else None
                must.append(f"last score {pct}% and nothing blocking: this is a candidate to "
                            f"advance to {nxt['id'] + ' ' + nxt['skill'] if nxt else 'a harder variant'}")
            if slot.get("inferredRule"):
                must.append("the rule must be INFERRED, so do not state it in the passage")
            if sid == "2C":
                must.append(f"school topic this half term: {term[child]}")
            if sid == "2A":
                must.append("scoreBand true, scoreBandRules included, at least 30 items, "
                            "first third easy, last third harder")

            for m in must:
                print(f"       MUST    : {m}")
            print()

        unslotted = [g for g in gaps if not g.get("slot")
                     and not any(x in (g.get("detail") or "") + (g.get("topic") or "")
                                 for x in spine["slots"])]
        if unslotted:
            print("  gaps with no slot, give each one a home before generating:")
            for g in unslotted:
                print(f"    [{g['status']:9s}] {g['topic'][:66]}")
            print()

        print("  HARD LIMITS (only the ones still in force today):")
        for lim in live_limits(spine, child):
            until = f"  [lifts {lim['until']}]" if lim.get("until") else ""
            print(f"    - {lim['rule']}{until}")
        lifted = [l for l in (list(spine["hardLimits"].get(child, []))
                              + list(spine["hardLimits"]["both"]))
                  if l.get("until") and today() >= l["until"]]
        for lim in lifted:
            print(f"    - LIFTED on {lim['until']}, no longer enforced: {lim['rule'][:70]}")
        print()
        print("  When the week is written, gate it:  node scripts/check-week.mjs " + child)
        print()


def check_nsw_alignment(spine, local=None):
    """The spine and the roadmap must agree about the target.

    Every slot declares the NSW item families it serves, by the ids in
    assets/roadmap.json under tracks.nsw. Two things are checked:

      * every id a slot names actually exists in the roadmap
      * every family the roadmap claims a child is working on is named by one of
        THAT child's slots

    The second is one directional on purpose. A slot may name a family it has
    not reached yet, which is how a destination gets on the ladder before the
    child gets there. The roadmap claiming coverage that no slot delivers is the
    error: that is the map saying the work is happening when it is not."""
    problems = []
    roadmap = read_json(ROADMAP)
    if not roadmap or "tracks" not in roadmap:
        return problems
    nsw = (roadmap["tracks"] or {}).get("nsw")
    if not nsw:
        return problems

    known = {i["id"] for sec in nsw["sections"] for i in sec["items"]}
    for sid, slot in spine["slots"].items():
        for child in CHILDREN:
            for fid in nsw_families(slot, child):
                if fid not in known:
                    problems.append(f"spine slot {sid}: NSW family {fid!r} is not in "
                                    f"assets/roadmap.json")

    for child in CHILDREN:
        entry = ((roadmap.get("children") or {}).get(child)) or {}
        claimed = list((((entry.get("progress") or {}).get("nsw")) or {}).get("current") or {})
        claimed += list((((entry.get("progress") or {}).get("nsw")) or {}).get("cleared") or [])
        served = set()
        for sid, slot in slots_for(spine, child).items():
            served.update(nsw_families(slot, child))
        for fid in claimed:
            if fid not in served:
                problems.append(f"{child}: the roadmap says {fid!r} is being worked on, but no "
                                f"slot of theirs serves it")

    # And the third direction, which is the one that actually drifted: a family
    # the roadmap calls current must be one the child's LIVE rung delivers. A
    # destination several rungs up, or a slot that does not start for another
    # week, is a future family however firmly the reason is worded.
    position = read_json(POSITION, {"children": {}})
    for child in CHILDREN:
        entry = ((roadmap.get("children") or {}).get(child)) or {}
        prog = (((entry.get("progress") or {}).get("nsw")) or {})
        claimed = dict(prog.get("current") or {})
        cleared = set(prog.get("cleared") or [])
        week = (local[child]["current"] or {}).get("weekNum") if local else None
        current, reachable, _ = nsw_state(spine, child, week, position)

        for fid in sorted(set(claimed) & cleared):
            problems.append(f"{child}: the roadmap has {fid!r} both cleared and current")
        for fid in sorted(set(claimed) - current):
            at = reachable.get(fid)
            where = f"it is delivered at {at}" if at else "no rung of theirs delivers it"
            problems.append(f"{child}: the roadmap says {fid!r} is in the weekly homework now, "
                            f"but {where} and they are not there yet")
        missing = sorted(current - set(claimed) - cleared)
        for fid in missing:
            problems.append(f"{child}: {fid!r} IS in the weekly homework now, at {reachable.get(fid)}, "
                            f"and the roadmap lists it as neither current nor cleared")

    # And the fourth: every family of every component the child SITS must have a
    # route somewhere on their ladders or in the term table. Nothing in the week
    # has to reach it yet, but the plan has to say where it will be reached.
    comp_of = {sec["id"]: sec["label"] for sec in nsw["sections"]}
    fam_comp = {i["id"]: comp_of[sec["id"]] for sec in nsw["sections"] for i in sec["items"]}
    for child in CHILDREN:
        sits = components_for(spine, child)
        if not sits:
            problems.append(f"{child}: spine goals name no tests, so nothing can be checked "
                            f"against the components they sit")
            continue
        routes = nsw_routes(spine, child)
        for fid, comp in sorted(fam_comp.items()):
            if comp in sits and fid not in routes:
                problems.append(f"{child}: {fid!r} is on the {comp} paper they sit and has no route "
                                f"at all: no rung and no school term delivers it")

    # Fifth: each roadmap item names the slots that serve it, and that list is
    # what the dashboard shows as "where this happens". It must match the spine.
    owner = {}
    for sid, slot in spine["slots"].items():
        for child in CHILDREN:
            for fid in nsw_families(slot, child):
                owner.setdefault(fid, set()).add(sid)
    for sec in nsw["sections"]:
        for item in sec["items"]:
            want = sorted(owner.get(item["id"]) or [])
            got = sorted(item.get("slots") or [])
            if want != got:
                problems.append(f"roadmap item {item['id']!r} lists slots {got} but the spine has "
                                f"{want} serving it")

    if term_table_exhausted(spine):
        last = spine["schoolSync"]["terms"][-1]
        problems.append(f"schoolSync ran out on {last['ends']}, so slot 2C is pinned to "
                        f"{last['term']!r} for ever. Extend the table.")
    return problems


def exam_format_quota(spine, when=None):
    """How many sections must be in exam format this week.

    The real papers are multiple choice and nearly every homework question is
    free text, so multiple choice is an untested skill: elimination, no partial
    credit, no marks for working, about a minute an item. The standing rule from
    11 Oct 2026 was one section a week rising as 2029 approaches, and it was
    written down and then never enforced, which is exactly how writing reached
    zero coverage. The ramp lives in spine.examFormat.ramp."""
    when = when or today()
    policy = spine.get("examFormat") or {}
    n = 0
    for step in policy.get("ramp") or []:
        if when >= step["from"]:
            n = step["sections"]
    return n


def exam_format_sections(week):
    return [s for s in (week.get("sections") or []) if s.get("examFormat")]


def check_coverage(local, spine):
    """Does the generated week actually test what the child is on?

    These are the deterministic coverage rules. They are the ones that stop a
    week being plausible but pointless: a slot missing, a marks split that does
    not add up, an open gap nobody re-tests, or a rung that cannot be evidenced
    because the section hands the rule over."""
    problems = []
    position = read_json(POSITION, {"children": {}})

    for child in CHILDREN:
        cur = local[child]["current"]
        if not cur:
            continue
        week = cur.get("weekNum")
        sections = {s["id"]: s for s in cur.get("sections", [])}
        goal = spine["goals"][child]["weeklyMarks"]
        slots = (((position.get("children") or {}).get(child) or {}).get("slots")) or {}
        gaps = [g for g in local[child]["gaps"] if g.get("status") in ("new", "persists")]
        # a parked gap names a skill the child has not been taught, so it is not
        # work that is owed and must not be forced into next week

        # every slot that applies to this child, this week
        for sid in slots_for(spine, child, week):
            if sid not in sections:
                problems.append(f"{child} W{week}: slot {sid} is missing from the week")

        # the marks split must match the spine
        by_subject = {}
        for s in sections.values():
            by_subject[s["subject"]] = by_subject.get(s["subject"], 0) + s.get("totalMarks", 0)
        for subject in ("english", "maths", "thinking"):
            want = goal[subject]
            got = by_subject.get(subject, 0)
            if got != want:
                problems.append(f"{child} W{week}: {subject} is {got} marks, the spine says {want}")
        total = sum(by_subject.values())
        if total != goal["total"]:
            problems.append(f"{child} W{week}: total is {total} marks, the spine says {goal['total']}")

        # every open gap must be re-tested somewhere
        for g in gaps:
            sid = g.get("slot")
            if not sid:
                continue
            if sid not in sections:
                problems.append(f"{child} W{week}: gap '{g['topic'][:48]}' is assigned to slot "
                                f"{sid}, which is not in this week")

        # a hinted section cannot evidence its rung, unless the hint is deliberate
        #
        # Nik can decide that a gap needs teaching outright rather than testing again,
        # which is what happened to Elysia's predicate gap on 11 Oct 2026 after three
        # failures. The section then lists those gap topics in hintedGaps, and they are
        # exempt here. The rule they are exempt FROM is the gate, not the diagnosis:
        # step 5 of the weekly cycle still records a hinted pass as improving, never
        # resolved, because a hinted pass only proves the child can copy.
        for sid, s in sections.items():
            if not s.get("hinted"):
                continue
            taught = [t.lower() for t in (s.get("hintedGaps") or [])]
            if taught and not s.get("hintedWhy"):
                problems.append(f"{child} W{week} {sid}: hintedGaps is set without hintedWhy, so "
                                "there is no record of why the hint was deliberate")
            on_slot = [g for g in gaps if g.get("slot") == sid]
            for t in taught:
                if not any(t in g["topic"].lower() for g in on_slot):
                    problems.append(f"{child} W{week} {sid}: hintedGaps names '{t[:40]}', which is "
                                    f"not an open gap on slot {sid}")
            blocking = [g for g in on_slot
                        if not any(t in g["topic"].lower() for t in taught)]
            if blocking:
                problems.append(f"{child} W{week} {sid}: the section declares itself hinted, so it "
                                f"cannot resolve the open gap '{blocking[0]['topic'][:40]}'. Either "
                                "remove the hint, or list that gap in the section's hintedGaps with "
                                "a hintedWhy to say the teaching is deliberate.")

        # the drill must actually be a drill
        for sid, s in sections.items():
            if sid != "2A":
                continue
            if not s.get("scoreBand"):
                problems.append(f"{child} W{week} 2A: the fluency drill must set scoreBand true")
            elif not s.get("scoreBandRules"):
                problems.append(f"{child} W{week} 2A: scoreBand is set but scoreBandRules is missing")
            n = len([q for q in s.get("questions", []) if q.get("inputType") != "none"])
            if n < 12:
                problems.append(f"{child} W{week} 2A: only {n} drill items, the spine asks for at "
                                "least 30 for maths and 12 for an English letter drill")

        # at least N sections a week in exam format, N from the ramp. The quota
        # applies from the first week each child is expected to carry one: the
        # weeks already published when the rule was agreed are not retro-failed,
        # and without that guard the ramp's first step failed both of them and
        # `push` refuses on a failed validation, so the whole CLI would have
        # stopped on the day the date fell due.
        quota = exam_format_quota(spine)
        first = ((spine.get("examFormat") or {}).get("fromWeek") or {}).get(child)
        if first is not None and week is not None and week < first:
            quota = 0
        got = exam_format_sections(cur)
        if len(got) < quota:
            problems.append(f"{child} W{week}: {len(got)} section(s) in exam format, the spine's ramp "
                            f"asks for {quota} by today. Set examFormat true on a section built on a "
                            f"rung being CONSOLIDATED, never one being learned.")
        for sec in got:
            qs = [q for q in sec.get("questions", []) if q.get("inputType") != "none"]
            for q in qs:
                opts = q.get("options")
                if not opts:
                    problems.append(f"{child} W{week} {sec['id']} {q['id']}: examFormat is set but the "
                                    f"question has no options[]")
                    continue
                want = 5 if sec.get("subject") == "maths" else 4
                if len(opts) != want:
                    problems.append(f"{child} W{week} {sec['id']} {q['id']}: {len(opts)} options, the "
                                    f"real paper gives {want} for {sec.get('subject')}")
                keys = [o for o in opts if str(o).strip().lower() in
                        [str(a).strip().lower() for a in (q.get("accepted") or [])]]
                if len(keys) != 1:
                    problems.append(f"{child} W{week} {sec['id']} {q['id']}: {len(keys)} of the options "
                                    f"match accepted[], a multiple choice item needs exactly one")

        # a recorded rung must exist on the ladder
        for sid, here in slots.items():
            ladder = spine["ladders"].get(child, {}).get(sid)
            if not ladder:
                continue
            if here.get("rung") not in [r["id"] for r in ladder["rungs"]]:
                problems.append(f"{child}: recorded rung {here.get('rung')!r} for {sid} is not on "
                                "the ladder")

    return problems


def cmd_validate(args):
    problems = validate()
    if os.path.exists(SPINE):
        local = load_local()
        spine = load_spine()
        problems += check_curriculum(local, spine)
        problems += check_coverage(local, spine)
        problems += check_nsw_alignment(spine, local)
    if not problems:
        print("data/ is valid")
        return
    for p in problems:
        print(f"  {p}")
    die(f"{len(problems)} problem(s)")


# --------------------------------------------------------------------------
# status / backup / answers
# --------------------------------------------------------------------------

def cmd_status(args):
    manifest = read_json(os.path.join(DATA, "index.json"))
    if not manifest:
        print("no local data yet. Run: scripts/kh.py pull")
    else:
        print(f"local data pulled {manifest['pulledAt']} from {manifest.get('api', '?')}")
        for child, info in manifest["children"].items():
            rng = info["weekRange"] or ["?", "?"]
            print(f"  {child:7s} weeks {rng[0]}-{rng[1]} "
                  f"({info['weeks']} records, {info['weeksWithAnswers']} with answers)  "
                  f"current W{info['currentWeek']}  "
                  f"gaps {info['gaps']['active']} active / {info['gaps']['resolved']} resolved")

    c = creds()
    print(f"\nthe API now ({c['api']}):")
    export = api_export(c)
    for child in CHILDREN:
        d = export.get(child) or {}
        weeks = [w["week"] for w in (d.get("weeks") or []) if w.get("total") is not None]
        prof = d.get("profile") or {}
        gaps = d.get("gaps") or []
        active = sum(1 for g in gaps if g.get("status") in ("new", "persists", "improving"))
        decisions = d.get("decisions") or []
        print(f"  {child:7s} W{min(weeks) if weeks else '?'}-{max(weeks) if weeks else '?'} "
              f"({len(weeks)} scored)  current W{prof.get('current_week')}  "
              f"gaps {active} active / {len(gaps) - active} other")
        if decisions:
            print(f"          {len(decisions)} OPEN DECISION(S) waiting on you:")
            for dec in decisions[:5]:
                print(f"            W{dec.get('week')} {str(dec.get('summary'))[:64]}")
            if len(decisions) > 5:
                print(f"            ... and {len(decisions) - 5} more")

    # A week the Worker has scored but the local copy has no write up for is the
    # thing the weekly cycle exists to fix, so say it here rather than later.
    if manifest:
        local = load_local()
        for child in CHILDREN:
            missing = [w["week"] for w in local[child]["weeks"][-3:]
                       if not w.get("summary") or not w.get("notes")]
            if missing:
                print(f"  {child:7s} no summary or notes yet for week(s) "
                      f"{', '.join(str(m) for m in missing)}")

    problems = validate() if manifest else []
    print(f"\nvalidation: {'clean' if not problems else str(len(problems)) + ' problem(s), run kh.py validate'}")


def cmd_backup(args):
    c = creds()
    snap = os.path.join(DATA, "snapshots", now_stamp())
    path = os.path.join(snap, "export.json")
    write_json(path, api_export(c))
    print(f"  export   {os.path.getsize(path):>8,} bytes -> {os.path.relpath(path, ROOT)}")
    print("done")


def cmd_answers(args):
    child = args.child
    week = args.week
    base = os.path.join(DATA, "children", child)
    rec = read_json(os.path.join(base, "weeks", f"w{week:02d}.json"))
    if not rec:
        die(f"no week {week} on disk for {child}. Run kh.py pull, or check the week number.")
    qset = read_json(os.path.join(base, "question-sets", f"w{week:02d}.json"))
    if not qset and read_json(os.path.join(DATA, "current", f"{child}.json"), {}).get("weekNum") == week:
        qset = read_json(os.path.join(DATA, "current", f"{child}.json"))

    s = rec["score"]
    print(f"{child} week {week}: {s['total']}/{s['outOf']} ({s['pct']}%)")
    for subj, v in rec["subjects"].items():
        print(f"  {subj:9s} {v['marks']}/{v.get('outOf', '?')}")
    if rec.get("notes"):
        print(f"\nnotes: {rec['notes']}\n")
    if not qset:
        print("no question set saved for this week, printing raw answers")
        for qid, ans in rec["answers"].items():
            print(f"  {qid}: {ans}")
        return

    for sec in qset.get("sections", []):
        got = rec["sectionMarks"].get(sec["id"])
        print(f"\n== {sec['id']} {sec['title']} ({sec['subject']}) "
              f"{got if got is not None else '?'}/{sec['totalMarks']} ==")
        for q in sec.get("questions", []):
            if q.get("inputType") == "none":
                continue
            given = rec["answers"].get(q["id"], "")
            mark = "auto" if q.get("autoMark") else "parent"
            print(f"  [{mark}] {q['id']} ({q['marks']}m) {q['text'][:110]}")
            print(f"        given:    {given!r}")
            if q.get("autoMark"):
                print(f"        accepted: {q.get('accepted')}")
            elif q.get("markScheme"):
                print(f"        scheme:   {q['markScheme'][:160]}")


# --------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("pull", help="API -> data/").set_defaults(fn=cmd_pull)
    sub.add_parser("status", help="summary of disk and the API").set_defaults(fn=cmd_status)
    sub.add_parser("validate", help="check data/ against the rules").set_defaults(fn=cmd_validate)
    sub.add_parser("backup", help="raw snapshot of the API export").set_defaults(fn=cmd_backup)

    sp = sub.add_parser("push", help="data/ -> API, the fields a human owns")
    sp.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    sp.add_argument("--include-scores", action="store_true",
                    help="also overwrite scores and section marks from the local copy. "
                         "Only for repairing a week by hand: normally the Worker owns these.")
    sp.set_defaults(fn=cmd_push)

    spn = sub.add_parser("plan", help="the spec for NEXT week, built from the rungs and open gaps")
    spn.add_argument("child", nargs="?", choices=CHILDREN)
    spn.set_defaults(fn=cmd_plan)

    sc = sub.add_parser("curriculum", help="the weekly brief: the map plus where the child stands")
    sc.add_argument("child", nargs="?", choices=CHILDREN)
    sc.set_defaults(fn=cmd_curriculum)

    sa = sub.add_parser("answers", help="print a week's questions with the answers given")
    sa.add_argument("child", choices=CHILDREN)
    sa.add_argument("week", type=int)
    sa.set_defaults(fn=cmd_answers)

    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()

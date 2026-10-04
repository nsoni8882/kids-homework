#!/usr/bin/env python3
"""kh - homework data CLI.

The two JSONbin bins are the live store the browser talks to. Their shape is
fixed because the old Netlify site still reads them, so this tool keeps that
wire format untouched and gives you a normalised, reviewable copy on disk
under data/ instead.

  kh.py pull      bins  -> data/   (also writes a raw snapshot first)
  kh.py status    one screen summary of what is on disk and in the bins
  kh.py validate  check data/ against schema/
  kh.py push      data/ -> bins    (rebuilds both payloads, asks first)
  kh.py backup    raw snapshot of both bins, nothing else
  kh.py answers   print one week's questions next to the answers given

Credentials are read from CLAUDE.md in this folder and never printed.
Reads use the restricted access key, writes use the master key.
"""

import argparse
import base64
import gzip
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
SCHEMA = os.path.join(ROOT, "schema")
SPINE = os.path.join(ROOT, "curriculum", "spine.json")
POSITION = os.path.join(DATA, "curriculum", "position.json")
CLAUDE_MD = os.path.join(ROOT, "CLAUDE.md")

CHILDREN = ("mason", "elysia")
LIVE_WEEKS = 8          # how many weeks the live bin keeps per child
BIN_SIZE_LIMIT = 100_000
BIN_SIZE_TARGET = 92_000
QSET_KEEP = 4           # question sets kept per child in the archive
SUBJECT_BY_PREFIX = {"1": "english", "2": "maths", "3": "thinking"}
API = "https://api.jsonbin.io/v3/b"
# JSONbin sits behind Cloudflare, which rejects urllib's default User-Agent with a 403.
UA = "kids-homework-cli/1.0"


# --------------------------------------------------------------------------
# credentials
# --------------------------------------------------------------------------

def creds():
    if not os.path.exists(CLAUDE_MD):
        die(f"CLAUDE.md not found at {CLAUDE_MD}. It holds the keys and is never committed.")
    txt = open(CLAUDE_MD, encoding="utf-8").read()

    def grab(pattern, label):
        m = re.search(pattern, txt)
        if not m:
            die(f"could not find {label} in CLAUDE.md")
        return m.group(1).strip()

    return {
        "master": grab(r"JSONbin\.io Master Key:\s*`([^`]+)`", "the master key"),
        "access": grab(r"JSONbin Access Key `kids-homework-site`:\s*`([^`]+)`", "the browser access key"),
        "live": grab(r"Live bin ID:\s*`([^`]+)`", "the live bin ID"),
        "archive": grab(r"Archive bin ID:\s*`([^`]+)`", "the archive bin ID"),
        "current": grab(r"Current week bin ID:\s*`([^`]+)`", "the current week bin ID"),
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


def api_get(bin_id, key, header):
    req = urllib.request.Request(
        f"{API}/{bin_id}/latest",
        headers={header: key, "X-Bin-Meta": "false", "User-Agent": UA},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        die(f"GET bin {bin_id} failed: HTTP {e.code} {e.read().decode()[:200]}")


def api_put(bin_id, key, payload):
    body = json.dumps(payload, ensure_ascii=False).encode()
    req = urllib.request.Request(
        f"{API}/{bin_id}",
        data=body,
        method="PUT",
        headers={"Content-Type": "application/json", "X-Master-Key": key, "User-Agent": UA},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode()), len(body)
    except urllib.error.HTTPError as e:
        die(f"PUT bin {bin_id} failed: HTTP {e.code} {e.read().decode()[:200]}")


def gunzip_b64(blob):
    if isinstance(blob, dict) and blob.get("enc") == "gzip+base64":
        blob = blob["data"]
    return json.loads(gzip.decompress(base64.b64decode(blob)))


def gzip_b64(obj):
    raw = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode()
    return {"enc": "gzip+base64", "data": base64.b64encode(gzip.compress(raw, 9)).decode()}


def subjects_from_section_marks(section_marks, sections=None):
    """Roll section marks up per subject. Section ids look like 1A, 2B, 3C and
    the leading digit is the subject, which is how the dashboard has always
    read them. When the week's question set is on hand we use its declared
    subject and totalMarks instead, which is exact."""
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
# normalise: bin shape -> local shape
# --------------------------------------------------------------------------

def normalise_week(child, raw, source, sections=None):
    """One week record, same fields whether it came from the live bin (rich,
    with answers) or the archive bin (older, subject totals only)."""
    total = raw.get("total")
    out_of = raw.get("outOf") or raw.get("max")
    rec = {
        "schemaVersion": 2,
        "child": child,
        "week": raw["week"],
        "source": source,
        "score": {
            "total": total,
            "outOf": out_of,
            "pct": round(total / out_of * 100) if total is not None and out_of else None,
        },
        "subjects": {},
        "sectionMarks": raw.get("sectionMarks") or {},
        "answers": raw.get("archive") or {},
        "submittedAt": raw.get("submittedAt"),
        "adjustedAt": raw.get("adjustedAt"),
        "notes": raw.get("notes") or "",
        # The headline fields the dashboard leads with. The notes paragraph stays
        # as the full record behind a disclosure.
        "summary": raw.get("summary") or "",
        "verdict": raw.get("verdict"),
        "wins": raw.get("wins") or [],
        "errors": raw.get("errors") or [],
        "designIssues": raw.get("designIssues") or [],
        "hintedSections": raw.get("hintedSections") or [],
    }

    # Anything the bin carries that this schema does not name is kept verbatim so a
    # pull/push round trip never silently drops a field.
    known = {"week", "total", "outOf", "max", "sectionMarks", "archive", "submittedAt",
             "adjustedAt", "notes", "english", "englishMax", "maths", "mathsMax",
             "thinking", "thinkingMax", "summary", "verdict", "wins", "errors",
             "designIssues", "hintedSections"}
    extra = {k: v for k, v in raw.items() if k not in known}
    if extra:
        rec["extra"] = extra

    if raw.get("sectionMarks"):
        rec["subjects"] = subjects_from_section_marks(raw["sectionMarks"], sections)
        for subj, declared in (("english", "englishMax"), ("maths", "mathsMax"), ("thinking", "thinkingMax")):
            if subj in rec["subjects"] and not rec["subjects"][subj]["outOf"] and raw.get(declared):
                rec["subjects"][subj]["outOf"] = raw[declared]
    else:
        for subj, mk, mx in (
            ("english", "english", "englishMax"),
            ("maths", "maths", "mathsMax"),
            ("thinking", "thinking", "thinkingMax"),
        ):
            if raw.get(mk) is not None:
                rec["subjects"][subj] = {"marks": raw[mk], "outOf": raw.get(mx)}
    return rec


def denormalise_week(rec):
    """Local shape -> the exact field set the browser and old site expect."""
    if rec["source"] == "archive" and not rec["sectionMarks"]:
        out = {"week": rec["week"], "total": rec["score"]["total"], "max": rec["score"]["outOf"]}
        for subj in ("english", "maths", "thinking"):
            if subj in rec["subjects"]:
                out[subj] = rec["subjects"][subj]["marks"]
                out[subj + "Max"] = rec["subjects"][subj]["outOf"]
        for field in ("notes", "summary", "verdict", "wins", "errors",
                      "designIssues", "hintedSections"):
            if rec.get(field):
                out[field] = rec[field]
        out.update(rec.get("extra") or {})
        return out

    out = {
        "week": rec["week"],
        "total": rec["score"]["total"],
        "outOf": rec["score"]["outOf"],
        "sectionMarks": rec["sectionMarks"],
        "archive": rec["answers"],
    }
    for field in ("submittedAt", "notes", "adjustedAt", "summary", "verdict",
                  "wins", "errors", "designIssues", "hintedSections"):
        if rec.get(field):
            out[field] = rec[field]
    out.update(rec.get("extra") or {})
    return out


# --------------------------------------------------------------------------
# pull
# --------------------------------------------------------------------------

def cmd_pull(args):
    c = creds()
    print(f"reading bins with access key {mask(c['access'])}")
    live = api_get(c["live"], c["access"], "X-Access-Key")
    archive = api_get(c["archive"], c["access"], "X-Access-Key")
    current = api_get(c["current"], c["access"], "X-Access-Key")

    snap = os.path.join(DATA, "snapshots", now_stamp())
    write_json(os.path.join(snap, "live.json"), live)
    write_json(os.path.join(snap, "archive.json"), archive)
    write_json(os.path.join(snap, "current.json"), current)
    print(f"raw snapshot -> {os.path.relpath(snap, ROOT)}")

    manifest = {"pulledAt": datetime.now(timezone.utc).isoformat(), "children": {}}

    for child in CHILDREN:
        lk = live.get(child) or {}
        ak = archive.get(child) or {}
        base = os.path.join(DATA, "children", child)

        # question sets first, so week records can use their exact section totals
        sections_by_week = {}
        qsets = ((archive.get("questionSets") or {}).get(child)) or {}
        for week_str, blob in qsets.items():
            try:
                decoded = gunzip_b64(blob)
            except Exception as e:                      # noqa: BLE001
                print(f"  warning: {child} week {week_str} question set did not decode ({e})")
                continue
            sections_by_week[int(week_str)] = decoded.get("sections") or []
            write_json(os.path.join(base, "question-sets", f"w{int(week_str):02d}.json"), decoded)

        current = (current.get(child) or {}).get("currentWeek") or lk.get("currentWeek")
        if current:
            sections_by_week.setdefault(current["weekNum"], current.get("sections") or [])
            write_json(os.path.join(DATA, "current", f"{child}.json"), current)

        # weeks: archive first, then live, so live wins on any overlap
        weeks = {}
        for raw in ak.get("weeks") or []:
            weeks[raw["week"]] = normalise_week(child, raw, "archive", sections_by_week.get(raw["week"]))
        for raw in lk.get("weeks") or []:
            weeks[raw["week"]] = normalise_week(child, raw, "live", sections_by_week.get(raw["week"]))

        wdir = os.path.join(base, "weeks")
        for stale in sorted(os.listdir(wdir)) if os.path.isdir(wdir) else []:
            os.remove(os.path.join(wdir, stale))
        for num in sorted(weeks):
            write_json(os.path.join(wdir, f"w{num:02d}.json"), weeks[num])

        gaps = [dict(g, source="live") for g in (lk.get("gaps") or [])]
        gaps += [dict(g, source="archive") for g in (ak.get("resolvedGaps") or [])]
        write_json(os.path.join(base, "gaps.json"), gaps)

        if lk.get("position"):
            os.makedirs(os.path.join(DATA, "curriculum"), exist_ok=True)
            allpos = read_json(POSITION, {"schemaVersion": 1, "children": {}})
            allpos.setdefault("children", {})[child] = lk["position"]
            write_json(POSITION, allpos)

        profile = {
            "child": child,
            "displayName": child.capitalize(),
            "kumonLevel": lk.get("kumonLevel") or {},
            "currentWeek": current["weekNum"] if current else None,
            "marksOutOf": (current and sum(s.get("totalMarks", 0) for s in current.get("sections", []))) or None,
        }
        write_json(os.path.join(base, "profile.json"), profile)

        active = [g for g in gaps if g.get("status") in ("new", "persists", "improving")]
        manifest["children"][child] = {
            "weeks": len(weeks),
            "weekRange": [min(weeks), max(weeks)] if weeks else None,
            "weeksWithAnswers": sum(1 for w in weeks.values() if w["answers"]),
            "questionSets": sorted(int(f[1:-5]) for f in os.listdir(os.path.join(base, "question-sets"))
                                   if f.endswith(".json")) if os.path.isdir(os.path.join(base, "question-sets")) else [],
            "gaps": {"total": len(gaps), "active": len(active),
                     "resolved": sum(1 for g in gaps if g.get("status") == "resolved")},
            "currentWeek": profile["currentWeek"],
        }
        info = manifest["children"][child]
        print(f"  {child:7s} weeks {info['weekRange']} ({info['weeks']}), "
              f"answers for {info['weeksWithAnswers']}, gaps {info['gaps']['active']} active / "
              f"{info['gaps']['resolved']} resolved, question sets {info['questionSets']}")

    manifest["binSizes"] = {
        "live": len(json.dumps(live)),
        "archive": len(json.dumps(archive)),
        "current": len(json.dumps(current)),
        "limit": BIN_SIZE_LIMIT,
    }
    write_json(os.path.join(DATA, "index.json"), manifest)
    print(f"bins: live {manifest['binSizes']['live']:,}, archive {manifest['binSizes']['archive']:,}, "
          f"current week {manifest['binSizes']['current']:,}, limit {BIN_SIZE_LIMIT:,} each")
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


def build_payloads(local):
    """Split the local data back into the two bins: the live bin carries the
    last 8 weeks, the active gaps and this week's questions; everything older
    goes to the archive bin."""
    live, archive, current = {}, {}, {}
    qs_note = ("Full question sets per child per week, saved BEFORE currentWeek is overwritten, "
               "so any week can be re-marked. Each entry is {enc:'gzip+base64', data:...}. "
               "Decode: json.loads(gzip.decompress(base64.b64decode(data)))")
    archive["questionSets"] = {"note": qs_note}

    for child in CHILDREN:
        d = local[child]
        recent = d["weeks"][-LIVE_WEEKS:]
        older = d["weeks"][:-LIVE_WEEKS]

        live[child] = {
            "weeks": [denormalise_week(dict(w, source="live")) for w in recent],
            "gaps": [{k: v for k, v in g.items() if k != "source"}
                     for g in d["gaps"] if g.get("status") != "resolved"],
        }
        # currentWeek lives in its own bin: it is 35KB of question text that the
        # dashboard never reads and that pushed the live bin over its 100KB cap.
        if d["current"]:
            current[child] = {"currentWeek": d["current"]}
        if d["profile"].get("kumonLevel"):
            live[child]["kumonLevel"] = d["profile"]["kumonLevel"]
        pos = read_json(POSITION, {"children": {}})
        here = (pos.get("children") or {}).get(child)
        if here:
            live[child]["position"] = here

        archive[child] = {
            "weeks": [denormalise_week(dict(w, source="archive")) for w in older],
            "resolvedGaps": [{k: v for k, v in g.items() if k != "source"}
                             for g in d["gaps"] if g.get("status") == "resolved"],
        }
        keep = sorted(d["questionSets"])[-QSET_KEEP:]
        archive["questionSets"][child] = {str(w): gzip_b64(d["questionSets"][w]) for w in keep}

    return live, archive, current


def cmd_push(args):
    local = load_local()
    problems = validate(local)
    if os.path.exists(SPINE):
        spine = load_spine()
        problems += check_curriculum(local, spine)
        problems += check_coverage(local, spine)
    if problems:
        for p in problems:
            print(f"  {p}")
        die(f"{len(problems)} validation problem(s). Nothing pushed.")

    live, archive, current = build_payloads(local)
    sizes = {k: len(json.dumps(v)) for k, v in
             (("live", live), ("archive", archive), ("current", current))}

    print("about to write:")
    for name in ("live", "archive"):
        payload = live if name == "live" else archive
        print(f"  {name:8s} {sizes[name]:>7,} bytes  " + "  ".join(
            f"{c}: {len(payload[c]['weeks'])}w" for c in CHILDREN))
    print(f"  current  {sizes['current']:>7,} bytes  " + "  ".join(
        f"{c}: W{current[c]['currentWeek']['weekNum']}" for c in CHILDREN if c in current))
    for name, size in sizes.items():
        if size > BIN_SIZE_LIMIT:
            die(f"{name} payload is {size} bytes, over the {BIN_SIZE_LIMIT} byte bin limit. "
                "Condense the oldest notes or raise QSET_KEEP down, then try again.")
        if size > BIN_SIZE_TARGET:
            print(f"  warning: {name} is {size} bytes, close to the {BIN_SIZE_LIMIT} limit")

    if not args.yes:
        if input("push these to JSONbin? type yes: ").strip().lower() != "yes":
            print("cancelled, nothing written")
            return

    c = creds()
    snap = os.path.join(DATA, "snapshots", now_stamp() + "-prepush")
    write_json(os.path.join(snap, "live.json"),
               api_get(c["live"], c["access"], "X-Access-Key"))
    write_json(os.path.join(snap, "archive.json"),
               api_get(c["archive"], c["access"], "X-Access-Key"))
    write_json(os.path.join(snap, "current.json"),
               api_get(c["current"], c["access"], "X-Access-Key"))
    print(f"pre-push snapshot -> {os.path.relpath(snap, ROOT)}")

    for name, bin_id, payload in (("live", c["live"], live), ("archive", c["archive"], archive),
                                  ("current", c["current"], current)):
        _, written = api_put(bin_id, c["master"], payload)
        back = api_get(bin_id, c["access"], "X-Access-Key")
        ok = json.dumps(back, sort_keys=True) == json.dumps(payload, sort_keys=True)
        print(f"  {name:8s} wrote {written:,} bytes, read back identical: {'yes' if ok else 'NO'}")
        if not ok:
            die(f"{name} bin did not read back identical. The snapshot above has the previous contents.")
    print("done")


# --------------------------------------------------------------------------
# validate
# --------------------------------------------------------------------------

def validate(local=None):
    local = local or load_local()
    problems = []
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
            if g.get("slot") and g["slot"] not in [f"{a}{b}" for a in "123" for b in "ABC"]:
                problems.append(f"{child} gap '{str(g.get('topic'))[:40]}': slot {g['slot']!r} is not 1A to 3C")
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
    when = when or today()
    for t in spine["schoolSync"]["terms"]:
        if when <= t["ends"]:
            return t
    return spine["schoolSync"]["terms"][-1]


def slot_of(qid_or_section):
    """Section ids are 1A..3C and question ids are 1A-Q3, so the slot is the first two."""
    return str(qid_or_section)[:2]


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
              f"2C topic is \"{term[child]}\"")
        print()

        for slot_id in sorted(spine["slots"]):
            slot = spine["slots"][slot_id]
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
        retired = spine["retired"].get(child) or []
        print(f"  retired item shapes, never generate again: "
              f"{len(retired) and chr(10) + chr(10).join('    - ' + r for r in retired) or 'none yet'}")
        print()


# --------------------------------------------------------------------------
# automated curriculum checks, run as part of validate
# --------------------------------------------------------------------------

ELYSIA_BANNED_TABLES = (7, 8, 9, 11, 12)


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

            # Elysia only: the three limits that have been broken before
            for a, b in re.findall(r"(\d{1,3})\s*(?:x|\u00d7|\*)\s*(\d{1,3})", texts):
                for n in (int(a), int(b)):
                    if n in ELYSIA_BANNED_TABLES:
                        problems.append(f"{child} W{week} {sid}: uses the {n} times table "
                                        f"({a} x {b}), which is banned until school teaches it")
                if int(a) > 12 and int(b) > 12:
                    problems.append(f"{child} W{week} {sid}: {a} x {b} is written multiplication, "
                                    "which is not taught yet")
            for a, b in re.findall(r"(\d{1,4})\s*(?:\u00f7|/)\s*(\d{1,3})", texts):
                if int(b) in ELYSIA_BANNED_TABLES:
                    problems.append(f"{child} W{week} {sid}: divides by {b}, a banned table")
                if int(a) > 100:
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
        print()

        for sid in sorted(spine["slots"]):
            slot = spine["slots"][sid]
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
            was_hinted = bool(last_section and last_section.get("hinted"))
            out_of = last_section.get("totalMarks") if last_section else None
            pct = round(last_marks / out_of * 100) if last_marks is not None and out_of else None

            print(f"  [{sid}] {slot['purpose']}")
            print(f"       marks   : {out_of if out_of else '?'}   subject {slot['subject']}")
            if rung:
                print(f"       BUILD AT: {rung['id']} {rung['skill']}")
                print(f"       evidence: {rung['advanceWhen']}")
            else:
                print("       BUILD AT: rung not recorded. Set it before generating.")
            print(f"       format  : {slot['fixed']}")

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
            if pct is not None and pct >= 95 and not blocking and not was_hinted:
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

        limits = spine["hardLimits"].get(child, []) + spine["hardLimits"]["both"]
        print("  HARD LIMITS:")
        for lim in limits:
            print(f"    - {lim['rule']}")
        print()
        print("  When the week is written, gate it:  node scripts/check-week.mjs " + child)
        print()


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

        # every slot present
        for sid in spine["slots"]:
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

        # a hinted section cannot evidence its rung
        for sid, s in sections.items():
            if not s.get("hinted"):
                continue
            blocking = [g for g in gaps if g.get("slot") == sid]
            if blocking:
                problems.append(f"{child} W{week} {sid}: the section declares itself hinted, so it "
                                f"cannot resolve the open gap '{blocking[0]['topic'][:40]}'. Either "
                                "remove the hint or accept the gap stays open.")

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
        print(f"local data pulled {manifest['pulledAt']}")
        for child, info in manifest["children"].items():
            print(f"  {child:7s} weeks {info['weekRange'][0]}-{info['weekRange'][1]} "
                  f"({info['weeks']} records, {info['weeksWithAnswers']} with answers)  "
                  f"current W{info['currentWeek']}  "
                  f"gaps {info['gaps']['active']} active / {info['gaps']['resolved']} resolved")
        b = manifest["binSizes"]
        print(f"  bins at last pull: live {b['live']:,} / archive {b['archive']:,} "
              f"(limit {b['limit']:,} each)")

    c = creds()
    print("\nlive bins now:")
    for name, bin_id in (("live", c["live"]), ("archive", c["archive"]), ("current", c["current"])):
        payload = api_get(bin_id, c["access"], "X-Access-Key")
        size = len(json.dumps(payload))
        bits = []
        for child in CHILDREN:
            k = payload.get(child) or {}
            if k.get("weeks"):
                nums = [w["week"] for w in k["weeks"]]
                bits.append(f"{child} W{min(nums)}-{max(nums)}")
        pct = size / BIN_SIZE_LIMIT * 100
        print(f"  {name:8s} {size:>7,} bytes ({pct:.0f}% of limit)  {', '.join(bits)}")

    problems = validate() if manifest else []
    print(f"\nvalidation: {'clean' if not problems else str(len(problems)) + ' problem(s), run kh.py validate'}")


def cmd_backup(args):
    c = creds()
    snap = os.path.join(DATA, "snapshots", now_stamp())
    for name, bin_id in (("live", c["live"]), ("archive", c["archive"]), ("current", c["current"])):
        payload = api_get(bin_id, c["access"], "X-Access-Key")
        path = os.path.join(snap, f"{name}.json")
        write_json(path, payload)
        print(f"  {name:8s} {os.path.getsize(path):>7,} bytes -> {os.path.relpath(path, ROOT)}")
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

    sub.add_parser("pull", help="bins -> data/").set_defaults(fn=cmd_pull)
    sub.add_parser("status", help="summary of disk and bins").set_defaults(fn=cmd_status)
    sub.add_parser("validate", help="check data/ against the rules").set_defaults(fn=cmd_validate)
    sub.add_parser("backup", help="raw snapshot of both bins").set_defaults(fn=cmd_backup)

    sp = sub.add_parser("push", help="data/ -> bins")
    sp.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
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

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
    }

    # Anything the bin carries that this schema does not name is kept verbatim so a
    # pull/push round trip never silently drops a field.
    known = {"week", "total", "outOf", "max", "sectionMarks", "archive", "submittedAt",
             "adjustedAt", "notes", "english", "englishMax", "maths", "mathsMax",
             "thinking", "thinkingMax"}
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
        if rec.get("notes"):
            out["notes"] = rec["notes"]
        out.update(rec.get("extra") or {})
        return out

    out = {
        "week": rec["week"],
        "total": rec["score"]["total"],
        "outOf": rec["score"]["outOf"],
        "sectionMarks": rec["sectionMarks"],
        "archive": rec["answers"],
    }
    for field in ("submittedAt", "notes", "adjustedAt"):
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

    snap = os.path.join(DATA, "snapshots", now_stamp())
    write_json(os.path.join(snap, "live.json"), live)
    write_json(os.path.join(snap, "archive.json"), archive)
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

        current = lk.get("currentWeek")
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
        "limit": BIN_SIZE_LIMIT,
    }
    write_json(os.path.join(DATA, "index.json"), manifest)
    print(f"live bin {manifest['binSizes']['live']} bytes, "
          f"archive {manifest['binSizes']['archive']} bytes, limit {BIN_SIZE_LIMIT}")
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
    live, archive = {}, {}
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
        if d["current"]:
            live[child]["currentWeek"] = d["current"]
        if d["profile"].get("kumonLevel"):
            live[child]["kumonLevel"] = d["profile"]["kumonLevel"]

        archive[child] = {
            "weeks": [denormalise_week(dict(w, source="archive")) for w in older],
            "resolvedGaps": [{k: v for k, v in g.items() if k != "source"}
                             for g in d["gaps"] if g.get("status") == "resolved"],
        }
        keep = sorted(d["questionSets"])[-QSET_KEEP:]
        archive["questionSets"][child] = {str(w): gzip_b64(d["questionSets"][w]) for w in keep}

    return live, archive


def cmd_push(args):
    local = load_local()
    problems = validate(local)
    if problems:
        for p in problems:
            print(f"  {p}")
        die(f"{len(problems)} validation problem(s). Nothing pushed.")

    live, archive = build_payloads(local)
    live_size, arch_size = len(json.dumps(live)), len(json.dumps(archive))

    print("about to write:")
    for name, payload, size in (("live", live, live_size), ("archive", archive, arch_size)):
        print(f"  {name:8s} {size:>7,} bytes  " + "  ".join(
            f"{c}: {len(payload[c]['weeks'])}w" for c in CHILDREN))
    for name, size in (("live", live_size), ("archive", arch_size)):
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
    print(f"pre-push snapshot -> {os.path.relpath(snap, ROOT)}")

    for name, bin_id, payload in (("live", c["live"], live), ("archive", c["archive"], archive)):
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
            if g.get("status") not in ("new", "persists", "improving", "resolved"):
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


def cmd_validate(args):
    problems = validate()
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
    for name, bin_id in (("live", c["live"]), ("archive", c["archive"])):
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
    for name, bin_id in (("live", c["live"]), ("archive", c["archive"])):
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

    sa = sub.add_parser("answers", help="print a week's questions with the answers given")
    sa.add_argument("child", choices=CHILDREN)
    sa.add_argument("week", type=int)
    sa.set_defaults(fn=cmd_answers)

    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()

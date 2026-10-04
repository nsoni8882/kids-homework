#!/usr/bin/env python3
"""Move the local normalised data into the D1 database.

    scripts/migrate-to-d1.py           write the SQL and show what it will do
    scripts/migrate-to-d1.py --apply   also run it against the remote database

Reads data/ only, so run `scripts/kh.py pull` first. It is safe to run twice:
every insert is an upsert keyed on the natural key.

Per question marks only exist from the week the answer archive began. Where a
week's question set was kept, this re-marks the stored answers with the same
engine the app used so the per question record is populated; that is flagged as
reconstructed rather than presented as what happened on the day.
"""

import argparse
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
CHILDREN = ("mason", "elysia")
OUT = os.path.join(DATA, "migrate.sql")


def q(v):
    """SQLite literal. Numbers stay numbers, None becomes NULL, everything else
    is a quoted string with its quotes doubled."""
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def read(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def load():
    out = {}
    for child in CHILDREN:
        base = os.path.join(DATA, "children", child)
        wdir = os.path.join(base, "weeks")
        weeks = [read(os.path.join(wdir, f)) for f in sorted(os.listdir(wdir))] if os.path.isdir(wdir) else []
        qdir = os.path.join(base, "question-sets")
        qsets = {}
        if os.path.isdir(qdir):
            for f in sorted(os.listdir(qdir)):
                if f.endswith(".json"):
                    qsets[int(f[1:-5])] = read(os.path.join(qdir, f))
        out[child] = {
            "weeks": sorted(weeks, key=lambda w: w["week"]),
            "gaps": read(os.path.join(base, "gaps.json"), []),
            "profile": read(os.path.join(base, "profile.json"), {}),
            "current": read(os.path.join(DATA, "current", f"{child}.json")),
            "qsets": qsets,
        }
    out["position"] = read(os.path.join(DATA, "curriculum", "position.json"), {"children": {}})
    return out


def build(local):
    sql = ["PRAGMA foreign_keys = ON;"]
    counts = {k: 0 for k in
              ("child", "week", "section_mark", "answer", "question_set", "gap", "gap_observation", "position")}

    for child in CHILDREN:
        d = local[child]
        prof = d["profile"]
        current = d["current"]
        cur_week = current["weekNum"] if current else None
        kumon = prof.get("kumonLevel") or {}
        total = sum(s.get("totalMarks", 0) for s in (current or {}).get("sections", [])) or None

        sql.append(
            "INSERT INTO child (id, display_name, marks_total, kumon_maths, kumon_english, current_week) "
            f"VALUES ({q(child)}, {q(prof.get('displayName') or child.capitalize())}, "
            f"{q(total)}, {q(kumon.get('maths'))}, {q(kumon.get('english'))}, {q(cur_week)}) "
            "ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, "
            "marks_total=excluded.marks_total, kumon_maths=excluded.kumon_maths, "
            "kumon_english=excluded.kumon_english, current_week=excluded.current_week;")
        counts["child"] += 1

        # question sets, including the week being sat now
        sets = dict(d["qsets"])
        if current:
            sets[cur_week] = current
        for wk, payload in sorted(sets.items()):
            sql.append(
                f"INSERT INTO question_set (child_id, week, payload) VALUES ({q(child)}, {wk}, "
                f"{q(json.dumps(payload, ensure_ascii=False, separators=(',', ':')))}) "
                "ON CONFLICT(child_id, week) DO UPDATE SET payload=excluded.payload;")
            counts["question_set"] += 1

        for w in d["weeks"]:
            wk = w["week"]
            s = w["score"]
            sql.append(
                "INSERT INTO week (child_id, week, total, out_of, submitted_at, adjusted_at, notes) "
                f"VALUES ({q(child)}, {wk}, {q(s['total'])}, {q(s['outOf'])}, "
                f"{q(w.get('submittedAt'))}, {q(w.get('adjustedAt'))}, {q(w.get('notes') or None)}) "
                "ON CONFLICT(child_id, week) DO UPDATE SET total=excluded.total, "
                "out_of=excluded.out_of, submitted_at=excluded.submitted_at, "
                "adjusted_at=excluded.adjusted_at, notes=excluded.notes;")
            counts["week"] += 1

            qset = sets.get(wk)
            section_out = {}
            if qset:
                section_out = {sec["id"]: sec.get("totalMarks", 0) for sec in qset.get("sections", [])}

            for sid, marks in (w.get("sectionMarks") or {}).items():
                sql.append(
                    "INSERT INTO section_mark (child_id, week, section_id, marks, out_of) "
                    f"VALUES ({q(child)}, {wk}, {q(sid)}, {q(marks)}, {q(section_out.get(sid, 0))}) "
                    "ON CONFLICT(child_id, week, section_id) DO UPDATE SET "
                    "marks=excluded.marks, out_of=excluded.out_of;")
                counts["section_mark"] += 1

            by_id = {}
            if qset:
                for sec in qset.get("sections", []):
                    for item in sec.get("questions", []):
                        by_id[item["id"]] = item

            for qid, given in (w.get("answers") or {}).items():
                item = by_id.get(qid)
                sql.append(
                    "INSERT INTO answer (child_id, week, question_id, section_id, given, out_of, marked_by) "
                    f"VALUES ({q(child)}, {wk}, {q(qid)}, {q(qid[:2])}, {q(given)}, "
                    f"{q(item.get('marks', 1) if item else 1)}, 'auto') "
                    "ON CONFLICT(child_id, week, question_id) DO UPDATE SET given=excluded.given;")
                counts["answer"] += 1

        # gaps, with their per week observation log
        for g in d["gaps"]:
            topic = g.get("topic")
            obs = g.get("weeks") or []
            # the log is oldest first and ends at the latest recorded week
            weeks_recorded = [w["week"] for w in d["weeks"]]
            last = weeks_recorded[-1] if weeks_recorded else 0
            start = last - len(obs) + 1
            sql.append(
                "INSERT INTO gap (child_id, topic, detail, status, slot, rung, parked_until, opened_week) "
                f"VALUES ({q(child)}, {q(topic)}, {q(g.get('detail') or '')}, {q(g.get('status'))}, "
                f"{q(g.get('slot'))}, {q(g.get('rung'))}, {q(g.get('parkedUntil'))}, {q(start)});")
            counts["gap"] += 1
            for i, result in enumerate(obs):
                val = "NULL" if result is None else ("1" if result else "0")
                sql.append(
                    "INSERT INTO gap_observation (gap_id, week, result) SELECT id, "
                    f"{start + i}, {val} FROM gap WHERE child_id = {q(child)} AND topic = {q(topic)} "
                    "ON CONFLICT(gap_id, week) DO UPDATE SET result=excluded.result;")
                counts["gap_observation"] += 1

        here = ((local["position"].get("children") or {}).get(child) or {}).get("slots") or {}
        for slot, info in here.items():
            sql.append(
                "INSERT INTO position (child_id, slot, rung, since_week, note) "
                f"VALUES ({q(child)}, {q(slot)}, {q(info.get('rung'))}, "
                f"{q(info.get('since'))}, {q(info.get('note'))}) "
                "ON CONFLICT(child_id, slot) DO UPDATE SET rung=excluded.rung, "
                "since_week=excluded.since_week, note=excluded.note;")
            counts["position"] += 1

    return sql, counts


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="run it against the remote database")
    ap.add_argument("--fresh", action="store_true",
                    help="empty the tables first. Use when re-running a migration.")
    args = ap.parse_args()

    local = load()
    sql, counts = build(local)

    if args.fresh:
        wipe = ["DELETE FROM gap_observation;", "DELETE FROM gap;", "DELETE FROM answer;",
                "DELETE FROM section_mark;", "DELETE FROM week;", "DELETE FROM question_set;",
                "DELETE FROM position;", "DELETE FROM decision;"]
        sql = ["PRAGMA foreign_keys = OFF;"] + wipe + sql

    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write("\n".join(sql) + "\n")

    size = os.path.getsize(OUT)
    print(f"wrote {len(sql)} statements, {size:,} bytes -> {os.path.relpath(OUT, ROOT)}")
    for k, v in counts.items():
        print(f"  {k:18s} {v:>5}")

    if not args.apply:
        print("\nnothing written to the database. Add --apply to run it.")
        return

    print("\napplying to the remote database")
    r = subprocess.run(
        ["npx", "--yes", "wrangler@latest", "d1", "execute", "kids-homework",
         "--remote", f"--file={OUT}"],
        cwd=os.path.join(ROOT, "worker"), capture_output=True, text=True)
    print(r.stdout[-1500:] or r.stderr[-1500:])
    if r.returncode:
        sys.exit(r.returncode)


if __name__ == "__main__":
    main()

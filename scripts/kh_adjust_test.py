#!/usr/bin/env python3
"""Tests for `kh.py adjust` against a real SQLite built from worker/schema.sql.

No network and no real data: the API calls are replaced with an in-memory
database holding one synthetic week. Run: python3 scripts/kh_adjust_test.py
"""

import importlib.util
import os
import sqlite3
import sys
import tempfile
import types

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("kh", os.path.join(HERE, "kh.py"))
kh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kh)


def fresh_db():
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript(open(os.path.join(HERE, "..", "worker", "schema.sql")).read())
    db.executescript("""
      INSERT INTO child (id, display_name, marks_total) VALUES ('mason', 'Test', 55);
      INSERT INTO week (child_id, week, total, out_of, submitted_at, notes)
        VALUES ('mason', 5, 9, 12, '2026-01-01T00:00:00Z', 'n');
      INSERT INTO section_mark VALUES ('mason', 5, '1B', 5, 5, NULL, NULL);
      INSERT INTO section_mark VALUES ('mason', 5, '2A', 4, 7, NULL, NULL);
      INSERT INTO answer (child_id, week, question_id, section_id, given, marks, out_of, marked_by)
        VALUES ('mason', 5, '1B-Q1', '1B', 'x', 1, 1, 'auto'),
               ('mason', 5, '1B-Q3', '1B', 'x', 2, 2, 'parent'),
               ('mason', 5, '1B-Q4', '1B', 'x', 2, 2, 'jev'),
               ('mason', 5, '2A-Q1', '2A', 'x', 1, 1, 'auto');
      INSERT INTO decision (child_id, week, kind, question_id, summary, status)
        VALUES ('mason', 5, 'mark', '1B-Q4', 's', 'accepted');
    """)
    return db


def wire(db):
    kh.creds = lambda: {"api": "test", "token": "test"}
    kh.api_query = lambda c, sql, params=None: [dict(r) for r in db.execute(sql, params or [])]

    def api_sql(c, statements, label=""):
        with db:  # one transaction, as a D1 batch is
            for s in statements:
                db.execute(s["sql"], s["params"])
        return len(statements)
    kh.api_sql = api_sql
    kh.api_export = lambda c: {"stub": True}
    kh.DATA = tempfile.mkdtemp()


def run(db, *argv, expect_exit=False):
    wire(db)
    a = types.SimpleNamespace(child="mason", week=5, question=argv[0], marks=argv[1],
                              reason="scheme line 2", approved_by="Nik",
                              dry_run="--dry-run" in argv, yes=True)
    try:
        kh.cmd_adjust(a)
    except SystemExit as e:
        assert expect_exit, f"unexpected exit {e}"
        return False
    assert not expect_exit, "expected a refusal"
    return True


def one(db, sql, *p):
    return db.execute(sql, p).fetchone()[0]


passed = 0


def test(name, fn):
    global passed
    fn()
    passed += 1
    print(f"  ok  {name}")


def t_happy():
    db = fresh_db()
    run(db, "1b-q3", 1)
    assert one(db, "SELECT marks FROM answer WHERE question_id='1B-Q3'") == 1
    assert one(db, "SELECT correct FROM answer WHERE question_id='1B-Q3'") == 0
    assert one(db, "SELECT marks FROM section_mark WHERE section_id='1B'") == 4
    assert one(db, "SELECT marks FROM section_mark WHERE section_id='2A'") == 4
    assert one(db, "SELECT total FROM week") == 8
    assert one(db, "SELECT adjusted_at FROM week").endswith("Z")
    assert one(db, "SELECT COUNT(*) FROM audit WHERE action='adjust'") == 1
    assert one(db, "SELECT notes FROM week") == "n"
    assert one(db, "SELECT COUNT(*) FROM decision") == 1


def t_dry_run():
    db = fresh_db()
    run(db, "1B-Q3", 1, "--dry-run")
    assert one(db, "SELECT total FROM week") == 9
    assert one(db, "SELECT COUNT(*) FROM audit") == 0


def t_noop():
    db = fresh_db()
    run(db, "1B-Q3", 2)
    assert one(db, "SELECT COUNT(*) FROM audit") == 0


def t_out_of_range():
    db = fresh_db()
    run(db, "1B-Q3", 3, expect_exit=True)
    run(db, "1B-Q3", -1, expect_exit=True)
    assert one(db, "SELECT total FROM week") == 9


def t_unknown_question():
    run(fresh_db(), "1B-Q9", 1, expect_exit=True)


def t_banded_section_refused():
    db = fresh_db()  # 2A reads 4 but its one question sums to 1, as a banded drill does
    run(db, "2A-Q1", 0, expect_exit=True)
    assert one(db, "SELECT total FROM week") == 9


def t_unmarked_refused():
    db = fresh_db()
    db.execute("UPDATE answer SET marks = NULL WHERE question_id = '1B-Q1'")
    run(db, "1B-Q1", 1, expect_exit=True)


def t_open_decision_refused():
    db = fresh_db()
    db.execute("UPDATE decision SET status = 'open'")
    run(db, "1B-Q4", 1, expect_exit=True)


def t_total_mismatch_refused():
    db = fresh_db()
    db.execute("UPDATE week SET total = 10")
    run(db, "1B-Q3", 1, expect_exit=True)
    assert one(db, "SELECT marks FROM answer WHERE question_id='1B-Q3'") == 2


def t_missing_reason_refused():
    db = fresh_db()
    wire(db)
    a = types.SimpleNamespace(child="mason", week=5, question="1B-Q3", marks=1, reason=" ",
                              approved_by="Nik", dry_run=False, yes=True)
    try:
        kh.cmd_adjust(a)
        raise AssertionError("expected a refusal")
    except SystemExit:
        pass


def t_raise():
    db = fresh_db()
    db.execute("UPDATE answer SET marks = 1 WHERE question_id = '1B-Q3'")
    db.execute("UPDATE section_mark SET marks = 4 WHERE section_id = '1B'")
    db.execute("UPDATE week SET total = 8")
    run(db, "1B-Q3", 2)
    assert one(db, "SELECT correct FROM answer WHERE question_id='1B-Q3'") == 1
    assert one(db, "SELECT total FROM week") == 9


print("kh.py adjust")
for name, fn in list(globals().items()):
    if name.startswith("t_"):
        test(name[2:].replace("_", " "), fn)
print(f"{passed} passed")

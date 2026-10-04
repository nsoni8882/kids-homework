-- Kids homework database.
--
-- Replaces the two JSONbin documents. The point is not just capacity: because
-- rows are written independently, two children submitting at the same moment
-- can no longer overwrite each other, which the single shared document made
-- possible and which the old app papered over with retry and verify.
--
-- Everything the browser touches goes through the Worker, so no secret and no
-- blanket write access ever reaches the page.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- children

CREATE TABLE IF NOT EXISTS child (
  id            TEXT PRIMARY KEY,              -- 'mason' | 'elysia'
  display_name  TEXT NOT NULL,
  marks_total   INTEGER NOT NULL,
  kumon_maths   TEXT,
  kumon_english TEXT,
  current_week  INTEGER,                       -- the week they are sitting now
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------------- weeks

CREATE TABLE IF NOT EXISTS week (
  child_id      TEXT NOT NULL REFERENCES child(id) ON DELETE CASCADE,
  week          INTEGER NOT NULL,
  total         INTEGER,
  out_of        INTEGER,
  submitted_at  TEXT,
  adjusted_at   TEXT,                          -- set when a mark was changed by hand
  notes         TEXT,
  -- Pace. The old app ran a timer per section and threw the number away, so
  -- "leaves the last question blank" could only ever be a guess.
  elapsed_secs  INTEGER,
  unanswered    INTEGER,
  PRIMARY KEY (child_id, week)
);

CREATE TABLE IF NOT EXISTS section_mark (
  child_id      TEXT NOT NULL,
  week          INTEGER NOT NULL,
  section_id    TEXT NOT NULL,                 -- '1A'..'3C'
  marks         INTEGER NOT NULL,
  out_of        INTEGER NOT NULL,
  elapsed_secs  INTEGER,
  target_secs   INTEGER,
  PRIMARY KEY (child_id, week, section_id),
  FOREIGN KEY (child_id, week) REFERENCES week(child_id, week) ON DELETE CASCADE
);

-- One row per question answered. The old store kept only section totals, so
-- "which skill failed" could not be asked without re-marking everything.
CREATE TABLE IF NOT EXISTS answer (
  child_id      TEXT NOT NULL,
  week          INTEGER NOT NULL,
  question_id   TEXT NOT NULL,                 -- '1A-Q3'
  section_id    TEXT NOT NULL,
  given         TEXT NOT NULL DEFAULT '',
  marks         INTEGER,                       -- awarded, once known
  out_of        INTEGER NOT NULL DEFAULT 1,
  marked_by     TEXT NOT NULL DEFAULT 'auto',  -- auto | jev | parent
  correct       INTEGER,                       -- 1 | 0 | NULL when not yet marked
  confidence    REAL,                          -- jev only
  jev_reason    TEXT,                          -- jev only, the band it landed in
  PRIMARY KEY (child_id, week, question_id),
  FOREIGN KEY (child_id, week) REFERENCES week(child_id, week) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS answer_by_section ON answer (child_id, section_id, week);

-- --------------------------------------------------------------- questions

-- The week the child is sitting, plus every past week's questions. Stored as
-- JSON because the shape is a document and is only ever read whole.
CREATE TABLE IF NOT EXISTS question_set (
  child_id      TEXT NOT NULL REFERENCES child(id) ON DELETE CASCADE,
  week          INTEGER NOT NULL,
  payload       TEXT NOT NULL,                 -- JSON {weekNum, sections[]}
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (child_id, week)
);

-- -------------------------------------------------------------------- gaps

CREATE TABLE IF NOT EXISTS gap (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id      TEXT NOT NULL REFERENCES child(id) ON DELETE CASCADE,
  topic         TEXT NOT NULL,
  detail        TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL CHECK (status IN ('new','persists','improving','resolved','parked')),
  slot          TEXT,                          -- which section re-tests it
  rung          TEXT,                          -- which curriculum rung it blocks
  parked_until  TEXT,                          -- a skill not yet taught at school
  opened_week   INTEGER,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS gap_by_child ON gap (child_id, status);

-- The per week log that used to be the weeks[] array of true/false/null.
CREATE TABLE IF NOT EXISTS gap_observation (
  gap_id        INTEGER NOT NULL REFERENCES gap(id) ON DELETE CASCADE,
  week          INTEGER NOT NULL,
  result        INTEGER,                       -- 1 correct, 0 wrong, NULL not tested
  note          TEXT,
  PRIMARY KEY (gap_id, week)
);

-- ------------------------------------------------------------- curriculum

CREATE TABLE IF NOT EXISTS position (
  child_id      TEXT NOT NULL REFERENCES child(id) ON DELETE CASCADE,
  slot          TEXT NOT NULL,                 -- '1A'..'3C' or 'WR' for writing
  rung          TEXT NOT NULL,                 -- '2B.2'
  since_week    INTEGER,
  note          TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (child_id, slot)
);

-- Every rung the child has cleared, which is what the child's own progress
-- page shows. Appended to, never rewritten, so the history survives.
CREATE TABLE IF NOT EXISTS rung_cleared (
  child_id      TEXT NOT NULL REFERENCES child(id) ON DELETE CASCADE,
  rung          TEXT NOT NULL,
  slot          TEXT NOT NULL,
  cleared_week  INTEGER NOT NULL,
  cleared_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (child_id, rung)
);

-- ----------------------------------------------------------------- writing

CREATE TABLE IF NOT EXISTS writing (
  child_id      TEXT NOT NULL REFERENCES child(id) ON DELETE CASCADE,
  week          INTEGER NOT NULL,
  prompt        TEXT NOT NULL,
  genre         TEXT,                          -- narrative | persuasive | recount | description
  minutes       INTEGER NOT NULL DEFAULT 15,
  text          TEXT,                          -- what the child wrote
  words         INTEGER,
  elapsed_secs  INTEGER,
  -- scored against the rubric, out of 10
  ideas         INTEGER,
  structure     INTEGER,
  vocabulary    INTEGER,
  accuracy      INTEGER,
  total         INTEGER,
  scored_by     TEXT,                          -- jev | parent
  confidence    REAL,
  feedback      TEXT,
  submitted_at  TEXT,
  PRIMARY KEY (child_id, week)
);

-- -------------------------------------------------------- parent decisions

-- The queue that used to live in chat: things waiting on a human.
CREATE TABLE IF NOT EXISTS decision (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id      TEXT NOT NULL REFERENCES child(id) ON DELETE CASCADE,
  week          INTEGER,
  kind          TEXT NOT NULL,                 -- mark | gap | advance | design
  question_id   TEXT,
  summary       TEXT NOT NULL,
  detail        TEXT NOT NULL DEFAULT '',
  recommend     TEXT,                          -- accept | reject | hold | advance
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','rejected')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at   TEXT
);

CREATE INDEX IF NOT EXISTS decision_open ON decision (child_id, status);

-- --------------------------------------------------------------- integrity

-- Every write the Worker makes, so a bad change can be traced and undone.
CREATE TABLE IF NOT EXISTS audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            TEXT NOT NULL DEFAULT (datetime('now')),
  actor         TEXT NOT NULL,                 -- browser | cli | cron
  action        TEXT NOT NULL,
  child_id      TEXT,
  week          INTEGER,
  detail        TEXT
);

CREATE INDEX IF NOT EXISTS audit_recent ON audit (at DESC);

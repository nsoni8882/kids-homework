# Worker

The homework API, and the store behind it. Cloudflare Worker over a D1 database.

| | State |
|---|---|
| `schema.sql` | applied, 13 tables, database `kids-homework` in WEUR |
| `src/jev.js` | TypeSafe Jev: marking, partial credit, diagnosis, the question gate, writing |
| | `diagnose()` is used by `scripts/jev-check.mjs --diagnose`, not by any route |
| `src/index.js` | the HTTP API |

## Why it exists

Three things a static page could not do:

- **No secret reaches the browser.** It gets endpoints that read this week and submit this
  week, and nothing else.
- **Marking happens on the server**, so Jev can be used. The child's browser no longer decides
  the marks.
- **Writes are per row**, so two children submitting at the same moment cannot clobber each
  other, and there is no read, modify, write loop to retry.

## Marking order

1. `answersMatch`, deterministic, free and instant. Correct, done.
2. Everything it rejects, and every question that used to go straight to the parent, goes to Jev.
3. Only what Jev is genuinely unsure about reaches the parent.

Letter drills and blanks skip Jev: a closed set and an empty answer have no meaning to judge.
**If Jev is unavailable the answer is referred to the parent, never guessed.** That path is
exercised by the tests and has been verified against a rejected key.

A one mark question asks Jev for the probability only. The credit score is never read for one
mark, so asking for it doubled the judgments on the commonest case for nothing.

## Who owns what

The Worker owns marks, per question answers and the decision queue. It marks each submission,
records who decided every question, and recomputes totals from its own rows on every award, so
a page cannot inflate a score.

`scripts/kh.py push` writes only what a human authors: the week write up, gaps, the curriculum
position and next week's questions. This boundary is not cosmetic. The migration script that
preceded it rebuilt every table from the local copy, and a single run destroyed a submitted
week along with the parent's unanswered marking queue. `audit` is never cleared, which is the
only reason that was detectable afterwards.

## Routes

| | |
|---|---|
| `GET /api/week/:child` | the questions, plus whether this week was already submitted |
| `POST /api/week/:child/submit` | mark server side and write the rows |
| `POST /api/week/:child/award` | the marks a grown up awarded for the referred questions |
| `GET /api/dashboard` | the parent payload for both children, including open decisions |
| `GET /api/progress/:child` | the child's own page: weeks done, streak, best, rungs cleared |
| `POST /api/writing/:child` | the writing task, scored against a rubric |
| `/admin/export`, `/admin/query`, `/admin/sql` | behind `ADMIN_TOKEN`, for `scripts/kh.py` |

Anti-abuse on the open routes: CORS origin allowlist, submissions accepted only for the current
week, a 60 second repeat guard, answer count and length caps, and every write recorded in
`audit`.

## Two traps worth knowing

**Timestamps.** Everything the Worker writes is ISO 8601. SQLite's `datetime('now')` is space
separated, and a space sorts below `T`, so an ISO stamp always compares greater than a
`datetime('now')` string for the same instant. The repeat guard was written that way and so
matched every past submission instead of a 60 second window: it looked like a working guard and
was the exact opposite. Never mix the two formats in a comparison.

**Handlers must be awaited.** `return handleX(...)` hands the promise back to the runtime, so a
rejection inside the handler escapes the router's try/catch and the caller gets Cloudflare's
bare `error code: 1101` instead of a JSON 500. Every route uses `return await`.

## Commands

```sh
npx wrangler deploy                                    # ship it
npx wrangler dev --local                               # local, against a local D1
npx wrangler d1 execute kids-homework --local --file=schema.sql    # seed the local DB
npx wrangler tail                                      # live logs
```

`schema.sql` is all `CREATE TABLE IF NOT EXISTS`, so re-running it never adds a column to an
existing table. Adding one means writing the `ALTER TABLE` by hand against local and remote,
then editing the `CREATE` to match. See the note at the top of the file.

Secrets are set with `wrangler secret put` and never live in `wrangler.toml`:
`JEV_API_KEY`, `ADMIN_TOKEN`. Local runs read `.dev.vars`, which is gitignored.

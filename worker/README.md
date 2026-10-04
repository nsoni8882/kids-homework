# Worker

The homework API. Cloudflare Worker over a D1 database.

| | State |
|---|---|
| `schema.sql` | applied, 13 tables, database `kids-homework` in WEUR |
| `src/jev.js` | TypeSafe Jev: marking, partial credit, diagnosis, the question gate, writing |
| `src/index.js` | the HTTP API |

## Why it exists

Three things the static page could not do:

- **No secret reaches the browser.** It gets endpoints that read this week and submit this
  week, and nothing else. Before, the page carried a key that could overwrite both bins.
- **Marking happens on the server**, so Jev can be used. The child's browser no longer decides
  the marks.
- **Writes are per row**, so two children submitting at the same moment cannot clobber each
  other. The read, modify, write dance and its retry loop are gone.

## Marking order

1. `answersMatch`, deterministic, free and instant. Correct, done.
2. Everything it rejects, and every question that used to go straight to the parent, goes to Jev.
3. Only what Jev is genuinely unsure about reaches the parent.

Letter drills and blanks skip Jev: a closed set and an empty answer have no meaning to judge.
If Jev is unavailable the answer is referred to the parent, never guessed.

## Routes

| | |
|---|---|
| `GET /api/week/:child` | the questions, plus whether this week was already submitted |
| `POST /api/week/:child/submit` | mark server side and write the rows |
| `GET /api/dashboard` | the parent payload for both children |
| `GET /api/progress/:child` | the child's own page: streak, best, rungs cleared |
| `POST /api/writing/:child` | the writing task, scored against a rubric |
| `/admin/*` | behind `ADMIN_TOKEN`, for `scripts/kh.py` |

Anti-abuse on the open routes: CORS origin allowlist, submissions accepted only for the current
week, a 60 second repeat guard, payload caps, and every write recorded in `audit`.

## Commands

```sh
npx wrangler deploy                                    # ship it
npx wrangler dev                                       # local, against a local D1
npx wrangler d1 execute kids-homework --local --file=schema.sql    # seed the local DB
npx wrangler tail                                      # live logs
```

Secrets are set with `wrangler secret put` and never live in `wrangler.toml`:
`JEV_API_KEY`, `ADMIN_TOKEN`. Local runs read `.dev.vars`, which is gitignored.

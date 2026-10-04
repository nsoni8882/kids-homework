# Worker

Not deployed yet. This folder holds two finished pieces and one that is not:

| | State |
|---|---|
| `schema.sql` | applied to the D1 database `kids-homework` (13 tables, region WEUR) |
| `src/jev.js` | finished and in use, imported by `scripts/check-week.mjs` and `scripts/jev-check.mjs` |
| `src/index.js` | **not written yet.** The HTTP API that will replace the JSONbin reads and writes. |

Until `index.js` exists, `wrangler deploy` will fail, which is why `main` is commented out of
`wrangler.toml` rather than pointing at a missing file.

`jev.js` runs perfectly well outside a Worker: it takes a `fetchImpl` and is used today from Node
by the weekly gate. Nothing depends on the Worker being deployed.

## What index.js needs to do

- `GET  /api/week/:child` the questions, plus whether this week was already submitted
- `POST /api/week/:child/submit` mark server side, including Jev for written answers, and write rows
- `GET  /api/dashboard` the parent payload for both children
- `GET  /api/progress/:child` the child's own skills page
- `POST /api/writing/:child` the writing task
- admin routes behind `ADMIN_TOKEN` so `scripts/kh.py` can write

Secrets are set with `wrangler secret put` and never live in `wrangler.toml`:
`JEV_API_KEY`, `ADMIN_TOKEN`.

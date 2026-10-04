# Practice worksheets

Static weekly practice worksheets and a progress dashboard, served from GitHub Pages.

No learning data, answers or personal records are stored in this repository. Scores live in a
hosted JSON store and are read in the browser with a key that can only read and update, never
delete or create.

## Layout

| Path | What it is |
|---|---|
| `index.html` | parent progress dashboard |
| `mason/`, `elysia/` | one weekly worksheet per child |
| `assets/` | design system, data client, marking engine, charts |
| `curriculum/spine.json` | the fixed map each week is generated against |
| `schema/` | JSON Schema for the data shapes |
| `scripts/` | the data CLI and the checks below |
| `worker/` | Cloudflare Worker and D1 schema. Not deployed yet, see `worker/README.md`. |
| `.claude/skills/homework/` | the `/homework` command that runs the weekly cycle |

## Running it locally

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

The pages are ES modules, so they need serving over HTTP rather than opening as files.

## Commands

```sh
scripts/kh.py pull              # fetch the three bins into a normalised local copy
scripts/kh.py status            # what is on disk, what is live, bin sizes
scripts/kh.py curriculum mason  # where the child is on the curriculum map
scripts/kh.py plan mason        # the spec for next week, before writing any questions
scripts/kh.py answers mason 21  # one week's questions beside the answers given
scripts/kh.py validate          # structure, coverage and the hard limits
scripts/kh.py push              # write back, with snapshots, size guards and read back
```

## Checks

```sh
node scripts/test.mjs                   # 59 cases over the marking rules
node scripts/test.mjs --check-accepted   # every accepted answer must match itself
node scripts/check-week.mjs              # THE GATE: run before any week goes out
node scripts/check-week.mjs --no-ai      # the deterministic half only, free and instant
node scripts/jev-calibrate.mjs           # 12 labelled cases that keep the quality gate honest
```

`check-week.mjs` separates BLOCK (deterministic facts) from REVIEW (model judgments). A
judgment near its threshold can differ between runs, so it is raised for a human rather than
treated as a fact.

Credentials and the full operating notes are in `CLAUDE.md`, which is not committed.

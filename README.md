# Practice worksheets

Weekly practice worksheets and a progress dashboard, served from GitHub Pages and backed by a
Cloudflare Worker.

No learning data, answers or personal records are stored in this repository, and no credential
appears in any file here. The pages call an API that holds the only secrets; the browser can
read the current week and submit the current week, and nothing else.

## Layout

| Path | What it is |
|---|---|
| `index.html` | parent progress dashboard |
| `mason/`, `elysia/` | one weekly worksheet per child |
| `assets/` | design system, API client, marking engine, charts |
| `curriculum/spine.json` | the fixed map each week is generated against |
| `schema/` | JSON Schema for the data shapes |
| `scripts/` | the data CLI and the checks below |
| `worker/` | the Cloudflare Worker and D1 schema. This is the store. |
| `.claude/skills/homework/` | the `/homework` command that runs the weekly cycle |

## How it fits together

```
browser  ──►  Worker (kids-homework-api)  ──►  D1 database
   │              │
   │              └──►  TypeSafe Jev, for the marking it cannot do with string rules
   │
   └── no key, no write access beyond "submit this week"

scripts/kh.py  ──►  Worker /admin/*  ──►  D1      and a reviewable copy under data/
```

The Worker marks every submission and owns every total. `kh.py` keeps a normalised local copy
for reading, planning and diffing, and pushes back only the fields a human authors.

## Running it locally

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

The pages are ES modules, so they need serving over HTTP rather than opening as files. They talk
to the deployed Worker. To run the API locally too, see `worker/README.md`.

## Commands

```sh
scripts/kh.py pull              # API -> a normalised local copy under data/
scripts/kh.py status            # what is on disk, what the API holds, open decisions
scripts/kh.py curriculum mason  # where the child is on the curriculum map
scripts/kh.py plan mason        # the spec for next week, before writing any questions
scripts/kh.py answers mason 21  # one week's questions beside the answers given
scripts/kh.py validate          # structure, coverage and the hard limits
scripts/kh.py push              # write the week up, gaps, position and next week's questions
```

`push` deliberately does not write marks, per question answers or the decision queue. The
Worker owns those: it marked them, and a local copy is always the older story. Pass
`--include-scores` only to repair a week by hand.

## Checks

```sh
node scripts/test.mjs                   # 97 cases over the marking rules and the server marking
node scripts/test.mjs --check-accepted  # every accepted answer must match itself
node scripts/check-week.mjs             # THE GATE: run before any week goes out
node scripts/check-week.mjs --no-ai     # the deterministic half only, free and instant
node scripts/jev-check.mjs mason 21     # the quality pass on its own, including a past week
node scripts/jev-check.mjs mason 21 --diagnose   # classify each wrong answer: child or question
node scripts/jev-calibrate.mjs          # 12 labelled cases that keep the quality gate honest
```

`check-week.mjs` separates BLOCK (deterministic facts) from REVIEW (model judgments). A
judgment near its threshold can differ between runs, so it is raised for a human rather than
treated as a fact. A check that cannot run counts as a BLOCK: a gate that skipped its own
checks once reported PASSED while verifying nothing.

Credentials and the full operating notes are in `CLAUDE.md`, which is not committed.

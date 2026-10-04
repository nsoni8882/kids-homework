---
name: homework
description: Run the weekly homework cycle after one or both children submit. Marks the week properly, diagnoses gaps, updates the dashboard, and builds next week against the curriculum spine. Use when Nik says the kids have finished, or types /homework.
trigger: /homework
---

# /homework

One command for the whole weekly cycle. Run it when either child has submitted.

```
/homework                 both children, whoever has new work
/homework mason           one child only
/homework --dry           read and report, change nothing
/homework --next          resume at step 8 after Nik has answered
```

## The one rule

**Stop after step 7 and wait.** Steps 0 to 7 read, mark and diagnose. Step 8 writes next
week's questions. Never cross that line without Nik's answers, because step 8 depends on
decisions only he can make.

If `--next` is passed, skip to step 8 and apply the answers he has just given.

## Before anything

Read `CLAUDE.md` in this folder. It is the source of truth for credentials, the data shapes,
the validation rules and the design system. Everything below assumes it.

Never print a key. Mask as the first 6 characters plus `...`.

---

## Step 0. Pull and guard

```bash
scripts/kh.py pull
scripts/kh.py status
```

For each child, find the latest week with a `submittedAt`. If `currentWeek.weekNum` is GREATER
than that week, there is nothing new for that child: say so and skip them. If both skip, stop
and say so. **Never process a week twice and never regenerate an unsubmitted week.**

Check the last three weeks of each child have `notes` and `summary`. Missing ones get written
in step 5.

## Step 1. Load the map

```bash
scripts/kh.py curriculum <child>
```

That is the brief: the rung each slot is on, the open gaps attached to it, the school term, and
the hard limits. Use it. Do not re-derive the pathway from the history.

## Step 2. Read what they actually did

```bash
scripts/kh.py answers <child> <N>
```

Every question, the accepted answers, the mark scheme and what the child typed, in one place.

## Step 3. Confirm the questions are saved

`pull` already decoded every stored question set. Confirm week N's set is on disk before
anything overwrites `currentWeek`, and that every answer id in the week's `answers` exists in
it. `push` keeps the last 4 weeks per child automatically.

## Step 4. Mark it for real

```bash
node scripts/test.mjs --mark <child> <N>
```

That re-marks from the saved answers using the same engine the app used, and explains every
difference from the stored marks. A difference is only acceptable when parent marking or a
recorded `adjustedAt` accounts for it.

Then, for each wrong answer, decide: **real child error, or question fault?** Verify every key
by arithmetic or fact. Use Jev to check the ones you are unsure about rather than guessing:

```bash
node scripts/jev-check.mjs <child> <N>
```

Rules that do not bend:
- `autoMark:false` questions are not re-marked. Infer partial credit from the section total.
- Drill sections report the correct count and the band, plus any slip inside the top band.
- Two submissions inside 48 hours count as ONE data point for advancement. Check `submittedAt`.
- Record each error as section, question, topic, the child's answer, the correct answer.

## Step 5. Diagnose gaps and write the week up

Statuses: NEW, PERSISTS, IMPROVING, RESOLVED. Append `true`, `false` or `null` to each gap's
`weeks[]`.

- **Never resolve on one good week.** RESOLVED needs two clean appearances on unhinted,
  unambiguous items.
- A section marked `hinted: true` records `true` but stays IMPROVING. A hinted pass proves only
  that the child can copy.
- An item that cannot separate the skill from a shortcut does not count: record `null` and say
  why in the detail.
- An ambiguous question is inconclusive: record `null` and retire the item into
  `curriculum/spine.json` under `retired`.
- A gap untested for 6 or more weeks: flag it in step 7 and ask to retest or close.
- Give every new gap a `slot`, and a `rung` where you can. That is what makes the dashboard and
  the coverage checks work.

**Write the week up.** Required on every week entry:

| Field | What |
|---|---|
| `summary` | ONE or TWO sentences, the single most important thing. Not a list of scores. |
| `verdict` | `strong`, `steady`, `dip` or `concern` |
| `wins[]` | short lines, what went well |
| `errors[]` | `{where, what}` real child errors |
| `designIssues[]` | `{where, what, decision}` question faults |
| `hintedSections[]` | section ids whose passage gave the rule away |
| `notes` | the full prose record, as detailed as you like |

See CLAUDE.md section 10b for what a good summary reads like. The dashboard leads with it.

Then push:

```bash
scripts/kh.py push
```

It does the 8 week trim, moves resolved gaps to the archive, checks both bins against the
100,000 byte limit, snapshots first and reads back after.

## Step 6. Advancement

Work slot by slot against `curriculum/spine.json`. For each: name the current rung id, say
whether its `advanceWhen` condition is met, and state the rung it moves to or holds at. Write
the result into `data/curriculum/position.json`.

Be the devil's advocate. Flag weak evidence and recommend hold:
- submitted within 48 hours of the previous week
- the section was hinted
- several items in a set shared the same answer, so a pattern guess would score
- a known gap on that rung is still open

## Step 7. Report, then STOP

Give Nik:

1. Scores per child and section as saved, plus corrected totals if his decisions are taken.
2. Question faults table: item, the child's answer, the key, recommend accept or reject.
3. Real errors.
4. Gaps table: topic, status, note.
5. Slots that trigger advancement, with the rung ids and your recommendation.
6. What next week will contain per child.
7. **Decisions he must make, numbered, each answerable yes or no.**

**Wait for his reply.** Do not continue.

---

## Step 8. Build next week (only after he replies)

Apply his accepted mark changes and gap closures first, then:

```bash
scripts/kh.py plan <child>
```

That prints the spec: the rung to build each slot at, the evidence that rung needs, the gaps
that must be re-tested, whether last week was hinted, the school topic for 2C, and the drill
rules. **Build to that spec.** Do not design a week and check it afterwards.

Write the questions into `data/current/<child>.json`.

Compute every sum, key and cipher with a script, never by hand.

Then gate it:

```bash
node scripts/check-week.mjs <child>
```

BLOCK failures are facts and must be fixed. REVIEW items are Jev's judgment: look at each and
decide. Only then:

```bash
scripts/kh.py push
```

`push` validates again on its own and refuses a bad week even if the gate was skipped.

## Step 9. Deploy, only if app code changed

Question changes never need a deploy: they live in the bins.

```bash
git add -A && git commit -m "..." && git push
gh api repos/nsoni8882/kids-homework/pages/builds/latest --jq .status   # wait for "built"
```

Then check the three live URLs. If a Kumon level changed and Nik confirmed it, edit
`assets/roadmap.json` and include it in the same commit.

## Finish

Say what is done, what is left, and ONE next action for Nik.

---

## Checklist

Create a todo per line and tick them off.

- [ ] `kh.py pull` and `status`, guard against reprocessing
- [ ] `kh.py curriculum` read for each active child
- [ ] `kh.py answers` read for each active child
- [ ] `test.mjs --mark` run, every difference explained
- [ ] each wrong answer classified: child error or question fault
- [ ] gaps updated, `null` recorded where an item could not test the skill
- [ ] `summary` and `verdict` written for every processed week
- [ ] `kh.py push` succeeded and read back identical
- [ ] advancement decided per slot, `position.json` updated
- [ ] report delivered with numbered yes or no decisions
- [ ] **STOPPED and waited**
- [ ] (after reply) `kh.py plan`, questions built to spec
- [ ] (after reply) `check-week.mjs` passed, then `kh.py push`
- [ ] (if code changed) pushed and the Pages build confirmed built

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

For each child, find the latest week that has a score AND per question answers. If
`current_week` is GREATER than that, there is nothing new for that child: say so and skip them.
If both skip, stop and say so. **Never process a week twice and never regenerate an unsubmitted
week.**

Do NOT use `submittedAt` as the test of whether a week happened. Weeks 1 to 9 have none, for
both children, and no timestamp is to be invented for them.

`status` prints **OPEN DECISIONS**: questions Jev referred that nobody has marked yet. The
week's total is incomplete until they are answered, so resolve them before scoring. It also
names any of the last three weeks missing `notes` or `summary`; those get written in step 5.

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

`pull` writes every question set the database holds to
`data/children/<child>/question-sets/`. Confirm week N's set is there, and that every answer id
in the week's `answers` exists in it. Nothing is trimmed or overwritten now: the database keeps
every week's questions, and `current_week` just points at the one being sat.

## Step 4. Mark it for real

```bash
node scripts/test.mjs --mark <child> <N>
```

That re-marks from the saved answers using the same engine the app used, and explains every
difference from the stored marks. A difference is only acceptable when parent marking or a
recorded `adjustedAt` accounts for it.

Note that the per question record already says who decided each mark and why: `marked_by` is
`auto`, `jev` or `parent`, and `jev_reason` carries the band it landed in. Read that before
re-deriving anything.

Then, for each wrong answer, decide: **real child error, or question fault?** Verify every key
by arithmetic or fact. Check `answersMatch` before assuming an answer was judged semantically:
the engine is tolerant enough that "about 0" matches a key of "0". Use Jev on the ones you are
unsure about rather than guessing:

```bash
node scripts/jev-check.mjs <child> <N> --diagnose   # every wrong answer, classified
node scripts/jev-check.mjs <child> <N>              # the question quality pass
```

`--diagnose` puts each wrong answer to Jev with the question, the key and what the child typed,
and returns a cause (misread, slip, wrong method, incomplete, spelling, blank, bad question)
plus a separate probability that the QUESTION is at fault. Use it as evidence, not as the
verdict: it reports and changes nothing.

**Jev sees one question at a time.** A question that carries its context in the question above
it, "Every student must have a seat. How many minibuses are needed?", reads as unanswerable
alone and comes back as a question fault at 60 or 70 percent. It is clear on screen. Check
whether the context sits in the section before believing the flag, and write the item so it
reads alone next time.

Rules that do not bend:
- `autoMark:false` questions are not re-marked, but the award IS checked against the mark
  scheme. `--mark` only knows the ceiling, so it prints "+2 from parent marking, up to 2
  available" and calls that explained even when the scheme says 1 mark each and the child gave
  one of the two things. Read the scheme next to the answer and flag an over award in step 7.
- A `--mark` difference that is genuinely old and settled still prints every week. Write the
  explanation into that week's `notes` once, so the next run is not re-investigating it.
- Drill sections report the correct count and the band, plus any slip inside the top band.
- Two submissions inside 48 hours count as ONE data point for advancement. Check `submittedAt`.
- Record each error as section, question, topic, the child's answer, the correct answer.

## Step 5. Diagnose gaps and write the week up

Statuses: NEW, PERSISTS, IMPROVING, RESOLVED, PARKED. Append one observation to each gap's
`weeks[]`: `1` the child got it right, `0` the child got it wrong, `null` it was not tested.

**EVERY active gap gets EXACTLY ONE observation, every cycle. No exceptions.** `weeks[]` carries
no week numbers. `kh.py push` aligns it by length alone, with
`start = last_recorded_week - len(weeks) + 1`, so the final entry is always read as THIS week.
Skip a gap and every one of its past observations silently shifts a week earlier, which is wrong
history that nothing will ever flag. Not tested is `null`, never a missing entry. A parked gap is
not active and takes no observation.

Count them before pushing: active gaps in, observations appended, same number out.

- **Never resolve on one good week.** RESOLVED needs two clean appearances on unhinted,
  unambiguous items.
- A section marked `hinted: true` records `true` but stays IMPROVING. A hinted pass proves only
  that the child can copy.
- An item that cannot separate the skill from a shortcut does not count: record `null` and say
  why in the detail.
- An ambiguous question is inconclusive: record `null` and retire the item into
  `curriculum/spine.json` under `retired`.
- A gap untested for 6 or more weeks: flag it in step 7 and ask to retest or close.
- **A resolved gap that comes back is re-opened, not re-created.** Set its status to `persists`,
  append the `0`, and say in the detail which week closed it and which week broke it. A second
  gap with the same topic splits the history in two.
- **PARKED is for a skill the child has not been taught yet.** It is a real status: `kh.py`
  accepts it, the dashboard shows it, and `check-week.mjs` leaves parked gaps out of the
  must-retest list, so parking is how a gap stops being work that is owed. Park only on Nik's
  say so, and set `parkedUntil` to the condition that un-parks it.
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

It validates first and refuses to write anything if validation fails, snapshots the API export,
then writes the week write up, the gaps, the position and next week's questions, and reads back
the current week and gap counts.

**It deliberately cannot write a mark.** The Worker owns marks, answers and the decision queue:
it marked the week, and the local copy is always the older story. If a mark genuinely needs
changing by hand, that is `push --include-scores`, and it needs Nik's explicit yes.

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

**The worked example trap, which comes up nearly every week.** A slot under 95 percent gets
"open with a worked example box", and that same slot usually has a gap that MUST be re-tested
there. A box that states the rule the section tests makes the section hinted, and
`check-week.mjs` blocks a hinted section that is the only evidence for a gap it is meant to
close. So the box has to teach without stating the thing being tested. Three ways that work:

- **Anchor the half that is secure.** Elysia confuses subject and predicate, so the box labels
  the SUBJECT of one sentence and every question asks for the PREDICATE.
- **Demonstrate the format, not the rule.** For analogies, work one example of a DIFFERENT
  relationship type: the layout is shown and the part to whole rule is still inferred.
- **Teach the check, not the method.** For a drill losing marks to slips, show one solved item
  checked by taking it back off. That is the actual remedy and it hints nothing.

If none of those fit, hint it deliberately, set `hinted` and `hintedWhy`, and say in step 7 that
the gap cannot close this week.

Write the questions into `data/current/<child>.json`.

Compute every sum, key and cipher with a script, never by hand. Assert the properties in that
script, and assert the right one:

- **Odd one out: no number may be the only odd or the only even one in the SET.** It is not
  enough that the three that belong mix parity. In `4, 6, 9, 10` the three that belong are 4, 6
  and 9, which do mix, and yet 9 is the only odd number in the row, so parity alone names it and
  the item has two defensible answers. Jev caught exactly that at 86 percent after a generator
  assertion tested the weaker rule. At least two odd and at least two even, every time.

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

## Step 9. Deploy, only if code changed

Question changes never need a deploy: they live in the database, so `kh.py push` is enough.

Pages changed (`index.html`, `mason/`, `elysia/`, `assets/`):

```bash
git add -A && git commit -m "..." && git push
gh api repos/nsoni8882/kids-homework/pages/builds/latest --jq .status   # wait for "built"
```

API changed (anything under `worker/`):

```bash
cd worker && npx wrangler deploy
```

`assets/marking.js` changed: **both**, or the pages and the Worker will disagree about what
counts as correct.

Then check the three live URLs and that `#error` is hidden on the dashboard, per CLAUDE.md
section 13. If a Kumon level changed and Nik confirmed it, edit `assets/roadmap.json` and
include it in the same commit.

## Finish

Say what is done, what is left, and ONE next action for Nik.

---

## Checklist

Create a todo per line and tick them off.

- [ ] `kh.py pull` and `status`, guard against reprocessing
- [ ] open decisions from `status` resolved, or carried into the step 7 report
- [ ] `kh.py curriculum` read for each active child
- [ ] `kh.py answers` read for each active child
- [ ] `test.mjs --mark` run, every difference explained
- [ ] each wrong answer classified: child error or question fault
- [ ] gaps updated: EXACTLY ONE observation appended per active gap, `null` where it was not
      tested or the item could not test the skill
- [ ] `summary` and `verdict` written for every processed week
- [ ] `node scripts/test.mjs` passes
- [ ] `kh.py push` succeeded and read back the expected current week and gap counts
- [ ] advancement decided per slot, `position.json` updated
- [ ] report delivered with numbered yes or no decisions
- [ ] **STOPPED and waited**
- [ ] (after reply) `kh.py plan`, questions built to spec
- [ ] (after reply) `check-week.mjs` passed, then `kh.py push`
- [ ] (if pages changed) pushed and the Pages build confirmed built
- [ ] (if worker/ changed) `wrangler deploy` run

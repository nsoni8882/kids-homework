---
name: homework
description: Run the weekly homework cycle after one or both children submit. Marks the week properly, diagnoses gaps, updates the dashboard, and builds next week against the NSW placement test plan. Use when Nik says the kids have finished, or types /homework.
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

## What this is for

**Every week built by this skill is preparation for an NSW placement test. That is the goal, and
nothing else is.**

- **Mason** sits the **Selective High School Placement Test** in NSW Year 6, May 2029, for
  Normanhurst Boys. Reading, Mathematical Reasoning, Thinking Skills, Writing, 25 percent each.
- **Elysia** sits the **Opportunity Class test** in NSW Year 4, 2029, for an OC place, then the
  Selective test in Year 6, 2031, for Hornsby Girls. Three components, 33.3 percent each, no
  writing paper yet.

Kumon is the engine, not the target. A section that advances a Kumon level but leads to no exam
item type is a week wasted, and from 11 Oct 2026 the gate says so out loud.

**The item families are data, not memory.** `assets/roadmap.json` under `tracks.nsw` holds all 32,
taken from the Department's own practice papers, each with what the child actually has to do.
`curriculum/spine.json` says which families each slot serves, in `slots.<id>.nswFamilies`, as one
list or as an object keyed by child where they differ. Read those two rather than recalling them.
CLAUDE.md section 1b is the research behind both.

Three consequences that bite every week:

1. **Name the family.** Every section you build serves at least one family, or it is support and
   says why. Step 7 reports which families the week covered.
2. **Never generate a retired shape.** Analogies and ciphers are in `spine.retired` for both
   children. They are not on the NSW paper and they are not coming back.
3. **The real papers are multiple choice.** Reading and Thinking Skills offer four options,
   Mathematical Reasoning five, and only the writing task is open. Free text is still the right
   format while a rung is being learned, because it shows the method and feeds the gap log. Once a
   rung is being consolidated, put it in the real format: no partial credit, no marks for working,
   about one minute an item. Aim for at least one section a week in exam format, rising as 2029
   gets closer, and say in step 7 which one it was.

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

Then read the target alongside it: `curriculum/spine.json` for each slot's `nswFamilies`, and
`assets/roadmap.json` `tracks.nsw` for what each of those families actually asks the child to do.
A rung is how far up a ladder they are. A family is what the ladder is leaning against.

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

Three Jev helpers propose, and you confirm. None of them writes anything:

```bash
node scripts/gap-observe.mjs <child> <N>      # one entry per active gap, in gap order, ? where Jev is unsure
node scripts/suggest-verdict.mjs <child> <N>  # strong / steady / dip / concern, with the facts it saw
node scripts/suggest-accepted.mjs [child] [N] # rejected-but-right answers that are safe to accept
```

`gap-observe` is the guard against the positional trap below: it prints a line per active gap,
so a skipped gap shows as a missing entry. A gap in a hinted section can take 1 but stays IMPROVING.

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

## Step 6. Advancement, and the roadmap

Work slot by slot against `curriculum/spine.json`. For each: name the current rung id, say
whether its `advanceWhen` condition is met, and state the rung it moves to or holds at. Write
the result into `data/curriculum/position.json`.

**Then update the exam roadmap in the same pass.** `assets/roadmap.json` holds, per child,
`progress.nsw.cleared` and `progress.nsw.current`, keyed by family id with the reason each is
current. When a slot's rung moves far enough to start or finish a family, move the id and rewrite
its reason to name the new slot and rung. This is the one part of the roadmap that is hand kept,
and `kh.py validate` now refuses a push where the roadmap claims a child is working on a family
that no slot of theirs serves. It is the map saying the work is happening when it is not, which is
worse than an out of date map.

```bash
node scripts/advance-evidence.mjs <child> <N>  # per slot: the facts to hold on, plus Jev on shortcuts
```

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
6. **Exam coverage**: which NSW families this week exercised, which section was in exam format,
   and the running count per child, x of 32. Name any family that has been at zero for a month.
7. What next week will contain per child, each section against the family it serves.
8. **Decisions he must make, numbered, each answerable yes or no.**

**Wait for his reply.** Do not continue.

---

## Step 8. Build next week (only after he replies)

**Standing instruction, Nik 11 Oct 2026: progression is this skill's job, not his.** Every built
week is built at the rung `kh.py plan` prints for each slot, and step 7 says per slot whether it
advanced or held and which `advanceWhen` condition decided it. A hold cites the condition. A slot
that has held three cycles running is reported as a problem to solve, not a steady state. He should
never have to ask for this again.

**A rung that waits on a Kumon level is the exception.** Those carry `advanceBy: "kumon"` in the
spine and `kh.py plan` prints HOLD BY DESIGN for them. No score in the week can satisfy the
condition, so a perfect section is not a candidate to advance and a long hold is not a stalled
slot. Do not report it and do not ask Nik to confirm the level: standing decision, 12 Oct 2026,
he raises it when Kumon raises it. A probe at the next rung is allowed where readiness is genuinely
in doubt, as its own one mark item OUTSIDE the banded drill, never inside it.

Apply his accepted mark changes and gap closures first, then:

```bash
scripts/kh.py plan <child>
```

That prints the spec: the rung to build each slot at, the evidence that rung needs, the gaps
that must be re-tested, whether last week was hinted, the school topic for 2C, and the drill
rules. **Build to that spec.** Do not design a week and check it afterwards.

For each slot, before writing a single question, say to yourself: *which NSW family does this
section serve, and would a child who aced it be better at that item type?* If the answer is no,
the section is wrong however well it fits the rung. The families are in
`spine.slots.<id>.nswFamilies` with their descriptions in `assets/roadmap.json`.

Slot 1D, Mason only, is the writing task. It names an audience and a text type, as the real paper
does: "write an advice sheet for three new students" rather than "write a story". It is always
`autoMark: false` with a `markScheme`, and the rubric in `worker/src/jev.js` is what a parent mark
should follow.

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
- [ ] `assets/roadmap.json` `progress.nsw` updated for both children, and validate still clean
- [ ] every built section names the NSW family it serves, and at least one is in exam format
- [ ] no retired shape generated: no analogies, no ciphers
- [ ] report delivered with numbered yes or no decisions
- [ ] **STOPPED and waited**
- [ ] (after reply) `kh.py plan`, questions built to spec
- [ ] (after reply) `check-week.mjs` passed, then `kh.py push`
- [ ] (if pages changed) pushed and the Pages build confirmed built
- [ ] (if worker/ changed) `wrangler deploy` run

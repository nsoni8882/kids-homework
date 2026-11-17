---
name: score
description: Check a submitted daily set's marks through Jev and the mark schemes, then write the child-facing reason behind every wrong answer, which the worksheet shows in the red cross overlay. Does not build the next set. Use after a child has submitted and the parent has marked the referred answers, or when Nik types /score.
trigger: /score
model: opus
---

# /score

Marks the set that has just been submitted, checks every lost answer, and writes the reason
behind each one. It is the step between "the child has submitted" and "/homework builds the next
daily set". It never builds questions.

Homework is daily from 17 Nov 2026 (`spine.cadence`). The set number N is still called `week` in
the database and every command, so `/score mason 31` scores Mason's Day 31.

```
/score                 both children, their latest submitted week
/score mason           one child, latest submitted week
/score mason 27        one child, one week
/score --dry           check and report, write nothing
```

## What it may and may not write

| It may | It may not |
|---|---|
| Write `answer.explanation` for lost answers, through `kh.py explain` | Change any mark. A mark is changed only by `kh.py adjust`, with Nik's OK and `--approved-by` |
| Read every table | Run `kh.py push`. Push belongs to `/homework` |
| Write its scratch file to `data/explanations/` | Touch gaps, the curriculum position, notes, summaries or next week's questions |
| | Build or regenerate any question set |

If a mark looks wrong, it goes in the report as a recommended `adjust` for Nik. It is not applied
here. CLAUDE.md is explicit that a saved mark needs his OK.

## Step 0. Pull and find the week

```bash
scripts/kh.py pull
scripts/kh.py status
```

For each child, the week is the latest one with a score and per question answers, unless a week
number was given. If there is no submitted week, say so for that child and skip them.

If `status` shows **OPEN DECISIONS** for the week, the total is incomplete. Report it and stop
for that child. Explanations for referred answers wait until they are marked, because the
referred answer is what the child will read about.

## Step 1. List the lost answers

```bash
scripts/kh.py explain <child> <N>
```

That prints every answer that did not score full marks: the question, what the child typed, the
key, how it was marked, and whether an explanation already exists. An answer with an explanation
already is re-checked, and only rewritten if it is wrong.

## Step 2. Check the marks

Run three checks. None of them changes anything.

```bash
node scripts/test.mjs --mark <child> <N>            # re-marks with the app's engine
node scripts/jev-check.mjs <child> <N> --diagnose   # Jev classifies each wrong auto marked answer
kh.py answers <child> <N>                           # the mark schemes, for parent marked items
```

- `--mark` explains every difference from the stored marks. A difference is acceptable only if a
  parent award or `adjustedAt` accounts for it.
- `--diagnose` gives a cause and a probability that the QUESTION is at fault. Treat it as
  evidence. A question-fault flag at 50 percent or more means check the key yourself.
- Verify each key by arithmetic or fact. Check the wording against `answersMatch` before deciding
  a child was wrong. `--diagnose` sends the section passage with each question (since 14 Nov
  2026), but not the questions around it, so check context held in a neighbouring question
  before believing a "question fault" flag. A flag on a too-narrow key is real: 1A-Q2 in
  Elysia W27 ("flew away" against a key of "floated away") read 76 to 79 percent.
- `autoMark:false` answers are not re-marked. Check the award against the mark scheme and flag an
  over award.

Sort each lost answer into one of three:

| Verdict | Meaning | What happens |
|---|---|---|
| **Child error** | The key is right and the answer is wrong | Explain why it is wrong |
| **Key or wording fault** | The key is wrong, or a fair answer was rejected | Explain it, and recommend an `adjust` or an `accepted` change for Nik. Do not apply it |
| **Unsure** | Evidence points both ways | Explain what is known, say it is unsure, and do not guess |

## Step 3. Write the reasons

For each child error and each key or wording fault, write one explanation. It is what the child
reads in the cross overlay, so write it for them.

Each explanation is:

- **One to three short sentences.** Plain English, aimed at a child who has just finished.
- **Specific.** Say what they wrote and why it does not fit. Name the step that went wrong, such
  as "you took away 9 instead of adding it", not "you made a mistake".
- **Concrete about the right answer.** Say what the answer is and the one idea that gets there.
  Do not restate the whole working unless it is short.
- **Free of blame, and free of filler.** No "great try", no "don't worry". No em dashes.
- **Honest about a question fault.** If the question is the problem, say so plainly: "This
  question could be read two ways, so either answer was fair."

For an answer that is blank, say that no answer was given and what the question was asking.

Write the explanations to a JSON file, keyed by question id, and check it before writing:

```json
{
  "1A-Q3": "You wrote 'happy' but the question asks for the word that means the opposite of 'brave'. Cowardly is the opposite, and it is the word that fits the sentence.",
  "2B-Q7": "You found 3 of the 4 sides, then stopped. The perimeter needs all four sides added up."
}
```

Save it to `data/explanations/<child>-wNN.json`, which is gitignored. Then write it:

```bash
scripts/kh.py explain <child> <N> --file data/explanations/<child>-wNN.json --yes
```

The command refuses an unknown question id, an empty string and an em dash, and it reads back the
count. It touches the `explanation` column and nothing else.

## Step 4. Report

Lead with the result. One short block per child:

```
Mason W27: 42 / 55 as saved, marks checked, 9 explanations written.
  Jev agrees with every auto mark except 2B-Q4, a question fault at 70 percent. Key checked by hand: correct.
  Recommend: none to the marks.
  Open decisions: none.
```

Then, only if there is something to act on:

| Item | Finding | Recommended action |
|---|---|---|
| 2B-Q4 | Question reads two ways | `kh.py adjust` 1 mark, once Nik approves |

Say which explanations were written and which answers are unsure. Do not restate the whole week.

Then stop. Do not build the next set, and do not run `/homework`. The end of this skill is a
written report and the explanations in the database.

## Rules that do not bend

- Never change a saved mark. Recommend it, and let `kh.py adjust` apply it after Nik's OK.
- Never write an explanation you have not checked against the key. A confident wrong reason is
  worse than none, because the child will believe it.
- If Jev is unavailable, say so. The checks that do not need Jev still run, and the report says
  which verdicts rest on the arithmetic alone.
- The explanation is a child-facing string. Keep it in the child's reading level, and never put a
  key, a credential, or a parent's private note in it.

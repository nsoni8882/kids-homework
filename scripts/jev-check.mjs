#!/usr/bin/env node
/* Run the Jev question quality gate over a week before it goes to the children.
 *
 *   node scripts/jev-check.mjs                 both children's current week
 *   node scripts/jev-check.mjs mason           one child
 *   node scripts/jev-check.mjs mason 21        a past week from the archive
 *   node scripts/jev-check.mjs mason 21 --diagnose   why each wrong answer went wrong
 *   node scripts/jev-check.mjs --concurrency 6
 *
 * This checks the hard limits in curriculum/spine.json that are marked
 * "check: manual", which no string rule can test: ambiguity, a wrong key, a
 * passage that gives the rule away, a shortcut that bypasses the skill, level,
 * and an accepted list that is too narrow.
 *
 * It reports. It never changes a question. Decide each flag yourself.
 */

import { Jev, checkQuestion, checkSection, diagnose } from '../worker/src/jev.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  DATA, apiKey, loadSpine, loadWeek, pool, rungFor, questionsToCheck,
  slotsMissingRung, costLine,
} from './lib/gate.mjs';

const BAR = '='.repeat(78);

async function run(child, week, jev, spine, concurrency) {
  const set = loadWeek(child, week);
  if (!set) {
    console.log(`${child}: no question set on disk${week != null ? ` for week ${week}` : ''}. Run scripts/kh.py pull`);
    return 0;
  }

  const jobs = questionsToCheck(set);

  console.log(BAR);
  console.log(`${child.toUpperCase()}  week ${set.weekNum}  checking ${jobs.length} questions`);
  console.log(BAR);

  // Without a recorded rung the level checks have nothing to judge against, so
  // say so rather than quietly judging against a guess.
  const noRung = slotsMissingRung(spine, child, set);
  if (noRung.length) {
    console.log(`\n  NOTE: no rung recorded for ${noRung.join(', ')}. The level and`);
    console.log('  evidence checks are skipped for those slots. Set them in');
    console.log('  data/curriculum/position.json to have them judged.');
  }

  // Section level first: a section testing the wrong skill matters more than any
  // single question inside it.
  const sectionResults = await pool(set.sections, concurrency, async (section) => {
    try {
      return await checkSection(jev, {
        child, section, spineSlot: spine.slots[section.id], rung: rungFor(spine, child, section.id),
      });
    } catch (err) {
      return { sectionId: section.id, flags: [], clean: true, error: err.message };
    }
  });
  for (const r of sectionResults) {
    if (r.clean) continue;
    const sec = set.sections.find((x) => x.id === r.sectionId);
    console.log(`\n  SECTION ${r.sectionId} ${sec.title}`);
    console.log(`    rung: ${(rungFor(spine, child, r.sectionId) || {}).skill || 'not recorded'}`);
    for (const f of r.flags) {
      const bar = '#'.repeat(Math.round(f.probability * 10)).padEnd(10, '.');
      console.log(`    ${bar} ${(f.probability * 100).toFixed(0).padStart(3)}%  ${f.label}`);
    }
  }
  const sectionFlags = sectionResults.filter((r) => !r.clean).length;

  const results = await pool(jobs, concurrency, async ({ section, question }) => {
    try {
      return {
        section,
        ...(await checkQuestion(jev, {
          child,
          section,
          question,
          spineSlot: spine.slots[section.id],
          rung: rungFor(spine, child, section.id),
        })),
      };
    } catch (err) {
      return { section, questionId: question.id, error: err.message, flags: [], clean: false };
    }
  });

  let flagged = 0;
  for (const r of results) {
    if (r.error) {
      console.log(`  ${r.questionId}  could not check: ${r.error}`);
      continue;
    }
    if (r.clean) continue;
    flagged++;
    const q = jobs.find((j) => j.question.id === r.questionId).question;
    console.log(`\n  ${r.questionId}  (${r.section.id} ${r.section.title})`);
    console.log(`    ${q.text.replace(/\s+/g, ' ').slice(0, 110)}`);
    console.log(`    key: ${JSON.stringify((q.accepted || []).slice(0, 3))}`);
    for (const f of r.flags) {
      const bar = '#'.repeat(Math.round(f.probability * 10)).padEnd(10, '.');
      console.log(`    ${bar} ${(f.probability * 100).toFixed(0).padStart(3)}%  ${f.label}`);
    }
  }

  const clean = results.filter((r) => r.clean).length;
  console.log(`\n  ${sectionFlags} section(s) flagged, ${clean} questions clean, ${flagged} questions flagged`);
  return flagged + sectionFlags;
}

/**
 * Why did each wrong answer go wrong?
 *
 * This is step 4 of the weekly cycle: classifying a loss as a child error or a
 * question fault. Doing it by eye is where the diagnosis quietly becomes a
 * guess, so each one is put to Jev with the question, the key and what the
 * child actually typed.
 *
 * It reports. It changes no mark and no gap.
 */
async function runDiagnose(child, week, jev, concurrency) {
  const set = loadWeek(child, week);
  const recPath = join(DATA, 'children', child, 'weeks', `w${String(week).padStart(2, '0')}.json`);
  if (!set || !existsSync(recPath)) {
    console.log(`${child} week ${week}: need both the question set and the week record on disk. `
      + 'Run scripts/kh.py pull');
    return 0;
  }
  const rec = JSON.parse(readFileSync(recPath, 'utf8'));
  const given = rec.answers || {};
  if (!Object.keys(given).length) {
    console.log(`${child} week ${week}: no per question answers were kept for this week.`);
    return 0;
  }

  // Only the ones that actually lost a mark, judged the same way the app does.
  const { answersMatch } = await import('../assets/marking.js');
  const wrong = [];
  for (const section of set.sections) {
    for (const q of section.questions) {
      if (q.inputType === 'none' || !q.autoMark) continue;
      const a = given[q.id];
      if (a === undefined) continue;
      if (!answersMatch(a, q.accepted, q.inputType)) {
        wrong.push({ section, q, given: a });
      }
    }
  }

  console.log(BAR);
  console.log(`${child.toUpperCase()}  week ${week}  diagnosing ${wrong.length} wrong answers`);
  console.log(BAR);
  if (!wrong.length) {
    console.log('  nothing auto marked went wrong this week');
    return 0;
  }

  const out = await pool(wrong, concurrency, async ({ section, q, given: a }) => {
    try {
      return { section, q, given: a, ...(await diagnose(jev, {
        child, question: { ...q, subject: section.subject }, given: a,
        expected: (q.accepted || [])[0],
      })) };
    } catch (err) { return { section, q, given: a, error: err.message }; }
  });

  let flawed = 0;
  for (const r of out) {
    console.log(`\n  ${r.q.id}  (${r.section.id} ${r.section.title})`);
    console.log(`    ${r.q.text.replace(/\s+/g, ' ').slice(0, 104)}`);
    console.log(`    gave: ${JSON.stringify(r.given)}   key: ${JSON.stringify((r.q.accepted || [])[0])}`);
    if (r.error) { console.log(`    could not diagnose: ${r.error}`); continue; }
    console.log(`    cause: ${r.kind} (${(r.kindConfidence * 100).toFixed(0)}%) ${r.kindLabel}`);
    if (r.questionFlawed >= 0.5) {
      flawed++;
      console.log(`    QUESTION FAULT likely (${(r.questionFlawed * 100).toFixed(0)}%), `
        + 'so this may be mine to fix rather than theirs');
    }
  }
  console.log(`\n  ${out.length} diagnosed, ${flawed} look like question faults`);
  return flawed;
}

const args = process.argv.slice(2);
const diagnoseMode = args.includes('--diagnose');
if (diagnoseMode) args.splice(args.indexOf('--diagnose'), 1);
let concurrency = 4;
const ci = args.indexOf('--concurrency');
if (ci !== -1) { concurrency = Number(args[ci + 1]); args.splice(ci, 2); }
const child = args[0];
const week = args[1] != null ? Number(args[1]) : null;

const spine = loadSpine();
const jev = new Jev(apiKey());
const children = child ? [child] : ['mason', 'elysia'];

let totalFlagged = 0;
if (diagnoseMode) {
  if (week == null) {
    console.error('--diagnose needs a week: node scripts/jev-check.mjs mason 21 --diagnose');
    process.exit(1);
  }
  for (const c of children) totalFlagged += await runDiagnose(c, week, jev, concurrency);
} else {
  for (const c of children) totalFlagged += await run(c, week, jev, spine, concurrency);
}

console.log(`\n${BAR}`);
console.log(diagnoseMode
  ? `${totalFlagged} likely question fault(s) across ${children.length} child(ren)`
  : `${totalFlagged} question(s) flagged across ${children.length} child(ren)`);
console.log(`cost: ${costLine(jev)}`);
if (totalFlagged) console.log('A flag is a prompt to look, not a verdict. Decide each one yourself.');
process.exit(0);

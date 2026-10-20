#!/usr/bin/env node
/* Propose this week's observation for every active gap, for step 5 of the weekly cycle.
 *
 *   node scripts/gap-observe.mjs mason 24
 *   node scripts/gap-observe.mjs elysia 22 --concurrency 6
 *
 * Needs the week's question set and record on disk (scripts/kh.py pull).
 *
 * It PROPOSES and writes nothing: gaps.json is yours. The last line is the array
 * of entries in gap order, which is the thing that goes wrong by hand, because
 * `weeks[]` is aligned by length and one skipped gap shifts its history.
 * A gap in a hinted section can take 1 but stays IMPROVING, never RESOLVED.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Jev, observeGap } from '../worker/src/jev.js';
import { answersMatch } from '../assets/marking.js';
import { DATA, apiKey, loadWeek, pool, costLine } from './lib/gate.mjs';

const args = process.argv.slice(2);
let concurrency = 4;
const ci = args.indexOf('--concurrency');
if (ci !== -1) { concurrency = Number(args[ci + 1]); args.splice(ci, 2); }
const [child, weekArg] = args;
if (!child || !weekArg) {
  console.error('usage: node scripts/gap-observe.mjs <child> <week>');
  process.exit(1);
}
const week = Number(weekArg);

const set = loadWeek(child, week);
const recPath = join(DATA, 'children', child, 'weeks', `w${String(week).padStart(2, '0')}.json`);
const gapsPath = join(DATA, 'children', child, 'gaps.json');
if (!set || !existsSync(recPath) || !existsSync(gapsPath)) {
  console.error(`${child} week ${week}: need the question set, the week record and gaps.json. Run scripts/kh.py pull`);
  process.exit(1);
}
const given = JSON.parse(readFileSync(recPath, 'utf8')).answers || {};
const gaps = JSON.parse(readFileSync(gapsPath, 'utf8'));
const active = gaps.filter((g) => ['new', 'persists', 'improving'].includes(g.status));

const itemsFor = (section) => section.questions
  .filter((q) => q.inputType !== 'none')
  .map((q) => ({
    id: q.id,
    text: q.text,
    given: given[q.id],
    expected: (q.accepted || [])[0],
    markScheme: q.markScheme,
    engineCorrect: q.autoMark ? answersMatch(given[q.id], q.accepted, q.inputType) : undefined,
  }));

const jev = new Jev(apiKey(), { model: process.env.JEV_MODEL });
const out = await pool(active, concurrency, async (gap) => {
  const section = set.sections.find((s) => s.id === gap.slot);
  if (!gap.slot) return { gap, proposal: 'refer', reason: 'the gap has no slot recorded' };
  if (!section) return { gap, proposal: null, reason: `slot ${gap.slot} is not in week ${week}` };
  try {
    return { gap, section, ...(await observeGap(jev, { child, gap, section, items: itemsFor(section) })) };
  } catch (err) {
    return { gap, proposal: 'refer', reason: `Jev unavailable: ${err.message}` };
  }
});

console.log(`${child.toUpperCase()} week ${week}: ${active.length} active gap(s)\n`);
for (const r of out) {
  const shown = r.proposal === null ? 'null' : String(r.proposal);
  console.log(`  ${shown.padEnd(6)} ${r.gap.topic.slice(0, 62)}  [${r.gap.slot || 'no slot'}, ${r.gap.status}]`);
  console.log(`         ${r.reason}${r.hinted && r.proposal === 1 ? '  HINTED: take 1 but keep it IMPROVING' : ''}`);
}
const undecided = out.filter((r) => r.proposal === 'refer').length;
console.log(`\nentries in gap order: ${JSON.stringify(out.map((r) => (r.proposal === 'refer' ? '?' : r.proposal)))}`);
console.log(`${active.length} gaps in, ${out.length} entries out${undecided ? `, ${undecided} for you to decide (?)` : ''}`);
console.log(`cost: ${costLine(jev)}`);

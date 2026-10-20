#!/usr/bin/env node
/* Is each slot's result strong enough to advance? For step 6 of the weekly cycle.
 *
 *   node scripts/advance-evidence.mjs mason 24
 *
 * Per slot it lists the reasons to HOLD that are facts (hinted, a gap still open,
 * two weeks inside 48 hours, repeated answers) and the two things only Jev can
 * judge (a shortcut, or answers that do not show the skill).
 *
 * It recommends and decides nothing. Whether `advanceWhen` is met stays yours,
 * and a rung marked advanceBy kumon is never advanced by a score at all.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Jev, assessEvidence } from '../worker/src/jev.js';
import { DATA, apiKey, loadSpine, loadWeek, pool, rungFor, costLine } from './lib/gate.mjs';

const [child, weekArg] = process.argv.slice(2);
if (!child || !weekArg) {
  console.error('usage: node scripts/advance-evidence.mjs <child> <week>');
  process.exit(1);
}
const week = Number(weekArg);
const weeksDir = join(DATA, 'children', child, 'weeks');
const recPath = (n) => join(weeksDir, `w${String(n).padStart(2, '0')}.json`);
const set = loadWeek(child, week);
if (!set || !existsSync(recPath(week))) {
  console.error(`${child} week ${week}: need the question set and the week record. Run scripts/kh.py pull`);
  process.exit(1);
}
const rec = JSON.parse(readFileSync(recPath(week), 'utf8'));
const prev = existsSync(recPath(week - 1)) ? JSON.parse(readFileSync(recPath(week - 1), 'utf8')) : null;
const given = rec.answers || {};
const gapsPath = join(DATA, 'children', child, 'gaps.json');
const gaps = existsSync(gapsPath) ? JSON.parse(readFileSync(gapsPath, 'utf8')) : [];
const spine = loadSpine();

const hoursBetween = rec.submittedAt && prev && prev.submittedAt
  ? (Date.parse(rec.submittedAt) - Date.parse(prev.submittedAt)) / 36e5 : null;

const jev = new Jev(apiKey(), { model: process.env.JEV_MODEL });
const rows = await pool(set.sections, 4, async (section) => {
  const rung = rungFor(spine, child, section.id);
  const marks = (rec.sectionMarks || {})[section.id];
  const facts = [];
  if (!rung) return { section, marks, facts: ['no rung recorded'], rung: null };
  if (rung.advanceBy === 'kumon') facts.push('HOLD BY DESIGN: this rung moves with Kumon, not with a score');
  if (section.hinted) facts.push('the section was hinted, so it proves only that the child can copy');
  const open = gaps.filter((g) => g.slot === section.id && ['new', 'persists', 'improving'].includes(g.status));
  if (open.length) facts.push(`${open.length} open gap(s) on this slot, first: ${open[0].topic.slice(0, 50)}`);
  if (hoursBetween !== null && hoursBetween < 48) {
    facts.push(`submitted ${hoursBetween.toFixed(0)}h after the previous week: one data point, not two`);
  }
  const keys = section.questions.filter((q) => q.autoMark && q.accepted && q.accepted.length)
    .map((q) => String(q.accepted[0]).trim().toLowerCase());
  const repeats = [...new Set(keys)].filter((k) => keys.filter((x) => x === k).length > 2);
  if (repeats.length) facts.push(`answer(s) ${repeats.map((r) => JSON.stringify(r)).join(', ')} appear more than twice in the key, so a guess can score`);

  let flags = [];
  let error = null;
  try {
    const items = section.questions.filter((q) => q.inputType !== 'none').map((q) => ({
      text: q.text, given: given[q.id], expected: (q.accepted || [])[0] || q.markScheme,
    }));
    ({ flags } = await assessEvidence(jev, { child, section, rung, items }));
  } catch (err) { error = err.message; }
  return { section, marks, facts, flags, rung, error };
});

console.log(`${child.toUpperCase()} week ${week}: evidence per slot\n`);
let holds = 0;
for (const r of rows) {
  const pct = r.marks != null ? Math.round(r.marks / r.section.totalMarks * 100) : null;
  const reasons = [...r.facts, ...(r.flags || []).map((f) => `${f.label} (jev ${(f.probability * 100).toFixed(0)}%)`)];
  if (r.error) reasons.push(`Jev unavailable: ${r.error}`);
  const verdict = !r.rung ? 'no rung' : reasons.length ? 'HOLD or look' : 'evidence is clean';
  if (reasons.length) holds++;
  console.log(`  ${r.section.id}  ${r.rung ? r.rung.id : '-'}  ${pct === null ? '-' : `${pct}%`}  ${verdict}`);
  for (const x of reasons) console.log(`        - ${x}`);
}
console.log(`\n${holds} of ${rows.length} slots have a reason to hold or look. A clean slot still has to meet its advanceWhen.`);
console.log(`cost: ${costLine(jev)}`);

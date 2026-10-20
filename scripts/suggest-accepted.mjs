#!/usr/bin/env node
/* Answers the marking engine rejected but a grown up or Jev marked right, as
 * candidates for a question's accepted list.
 *
 *   node scripts/suggest-accepted.mjs            both children, every week on record
 *   node scripts/suggest-accepted.mjs mason 22   one child, one week
 *
 * Needs the admin token in CLAUDE.md, because the per question marks live in the
 * database and `kh.py pull` keeps only the answers. Jev then judges whether each
 * candidate is SAFE to accept as exact text.
 *
 * It suggests and edits nothing. A question is rarely reused, so the useful part
 * is the pattern: the phrasings the engine keeps missing.
 */
import { Jev, suggestAccepted } from '../worker/src/jev.js';
import { answersMatch } from '../assets/marking.js';
import { apiKey, adminQuery, pool, costLine } from './lib/gate.mjs';

const [child, weekArg] = process.argv.slice(2);
const where = ['marked_by IN (\'jev\', \'parent\')', 'marks > 0'];
const params = [];
if (child) { where.push('child_id = ?'); params.push(child); }
if (weekArg) { where.push('week = ?'); params.push(Number(weekArg)); }

const rows = await adminQuery(
  `SELECT child_id, week, question_id, given, marks FROM answer WHERE ${where.join(' AND ')} ORDER BY child_id, week`,
  params,
);
const sets = {};
for (const r of await adminQuery('SELECT child_id, week, payload FROM question_set')) {
  sets[`${r.child_id}:${r.week}`] = JSON.parse(r.payload);
}

const candidates = [];
for (const r of rows) {
  const set = sets[`${r.child_id}:${r.week}`];
  if (!set || !r.given || !r.given.trim()) continue;
  const q = set.sections.flatMap((s) => s.questions).find((x) => x.id === r.question_id);
  if (!q || !q.autoMark || !(q.accepted || []).length) continue;
  if (answersMatch(r.given, q.accepted, q.inputType)) continue;
  candidates.push({ child: r.child_id, week: r.week, q, given: r.given.trim() });
}

console.log(`${rows.length} answers judged right by Jev or a grown up, ${candidates.length} on auto marked questions the engine rejected\n`);
if (!candidates.length) process.exit(0);

const jev = new Jev(apiKey(), { model: process.env.JEV_MODEL });
const out = await pool(candidates, 4, async (c) => {
  try { return { ...c, ...(await suggestAccepted(jev, { child: c.child, question: c.q, candidate: c.given })) }; }
  catch (err) { return { ...c, error: err.message }; }
});

let safe = 0;
for (const r of out) {
  const verdict = r.error ? `could not judge: ${r.error}`
    : r.safe ? `SUGGEST adding (unsafe ${(r.unsafeP * 100).toFixed(0)}%)`
      : `too broad to add (unsafe ${(r.unsafeP * 100).toFixed(0)}%)`;
  if (r.safe) safe++;
  console.log(`  ${r.child} W${r.week} ${r.q.id}  ${verdict}`);
  console.log(`      ${r.q.text.replace(/\s+/g, ' ').slice(0, 90)}`);
  console.log(`      typed: ${JSON.stringify(r.given.slice(0, 100))}   key: ${JSON.stringify(r.q.accepted[0])}`);
}
console.log(`\n${safe} of ${out.length} are safe to add. Nothing was changed.`);
console.log(`cost: ${costLine(jev)}`);

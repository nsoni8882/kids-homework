#!/usr/bin/env node
/* Suggest the verdict (strong, steady, dip, concern) for a week's write-up.
 *
 *   node scripts/suggest-verdict.mjs mason 24
 *
 * Reads the week and the few before it from data/ (scripts/kh.py pull). It prints a
 * label and the facts it was given. It does not write the week, and it does not
 * write the summary: that is one or two sentences of judgment and stays yours.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Jev, suggestVerdict } from '../worker/src/jev.js';
import { DATA, apiKey, costLine } from './lib/gate.mjs';

const [child, weekArg] = process.argv.slice(2);
if (!child || !weekArg) {
  console.error('usage: node scripts/suggest-verdict.mjs <child> <week>');
  process.exit(1);
}
const week = Number(weekArg);
const load = (n) => {
  const p = join(DATA, 'children', child, 'weeks', `w${String(n).padStart(2, '0')}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};
const rec = load(week);
if (!rec || !rec.score || rec.score.total == null) {
  console.error(`${child} week ${week}: no scored record on disk. Run scripts/kh.py pull`);
  process.exit(1);
}
const pct = (r) => Math.round(r.score.total / r.score.outOf * 100);
const recent = [week - 4, week - 3, week - 2, week - 1].map(load).filter((r) => r && r.score && r.score.total != null).map(pct);

const gapsPath = join(DATA, 'children', child, 'gaps.json');
const gaps = existsSync(gapsPath) ? JSON.parse(readFileSync(gapsPath, 'utf8')) : [];
const open = gaps.filter((g) => ['new', 'persists'].includes(g.status));

const facts = {
  pct: pct(rec),
  recentPcts: recent,
  subjects: Object.fromEntries(Object.entries(rec.subjects || {}).map(([k, v]) => [k, `${v.marks}/${v.outOf}`])),
  openGaps: open.length,
  newGaps: gaps.filter((g) => g.status === 'new').length,
  errorCount: (rec.errors || []).length,
  designIssueCount: (rec.designIssues || []).length,
  hintedSections: rec.hintedSections || [],
};

const jev = new Jev(apiKey(), { model: process.env.JEV_MODEL });
const r = await suggestVerdict(jev, { child, facts });

console.log(`${child.toUpperCase()} week ${week}: ${rec.score.total}/${rec.score.outOf} (${facts.pct}%), recent ${JSON.stringify(recent)}`);
console.log(`facts: ${JSON.stringify(facts)}\n`);
console.log(`suggested verdict: ${r.verdict === 'refer' ? `? (${r.reason})` : r.verdict}`);
console.log(`recorded verdict:  ${rec.verdict || 'none yet'}`);
const probs = r.probabilities || {};
if (Object.keys(probs).length) {
  console.log(Object.entries(probs).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k.padEnd(8)} ${(v * 100).toFixed(0)}%`).join('\n'));
}
console.log(`\ncost: ${costLine(jev)}`);

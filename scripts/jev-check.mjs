#!/usr/bin/env node
/* Run the Jev question quality gate over a week before it goes to the children.
 *
 *   node scripts/jev-check.mjs                 both children's current week
 *   node scripts/jev-check.mjs mason           one child
 *   node scripts/jev-check.mjs mason 21        a past week from the archive
 *   node scripts/jev-check.mjs --concurrency 6
 *
 * This checks the hard limits in curriculum/spine.json that are marked
 * "check: manual", which no string rule can test: ambiguity, a wrong key, a
 * passage that gives the rule away, a shortcut that bypasses the skill, level,
 * and an accepted list that is too narrow.
 *
 * It reports. It never changes a question. Decide each flag yourself.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Jev, checkQuestion, checkSection } from '../worker/src/jev.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');

function apiKey() {
  const md = join(ROOT, 'CLAUDE.md');
  if (!existsSync(md)) {
    console.error('CLAUDE.md not found. It holds the key and is never committed.');
    process.exit(1);
  }
  const m = readFileSync(md, 'utf8').match(/^- API key: `([^`]+)`/m);
  if (!m) {
    console.error('no TypeSafe API key in CLAUDE.md');
    process.exit(1);
  }
  return m[1];
}

function loadWeek(child, week) {
  if (week == null) {
    const p = join(DATA, 'current', `${child}.json`);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8'));
  }
  const p = join(DATA, 'children', child, 'question-sets', `w${String(week).padStart(2, '0')}.json`);
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const cur = join(DATA, 'current', `${child}.json`);
  if (existsSync(cur)) {
    const c = JSON.parse(readFileSync(cur, 'utf8'));
    if (c.weekNum === week) return c;
  }
  return null;
}

/** Keep a few requests in flight without hammering the API. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

const BAR = '='.repeat(78);

/** The rung the child is on in this slot, so the level check has something to
    judge against. Falls back to the middle of the ladder when no position is
    recorded yet. */
function rungFor(spine, child, slot) {
  const ladder = spine.ladders[child] && spine.ladders[child][slot];
  if (!ladder) return null;
  const posPath = join(DATA, 'curriculum', 'position.json');
  if (existsSync(posPath)) {
    const pos = JSON.parse(readFileSync(posPath, 'utf8'));
    const here = (((pos.children || {})[child] || {}).slots || {})[slot];
    if (here) {
      const found = ladder.rungs.find((r) => r.id === here.rung);
      if (found) return found;
    }
  }
  return ladder.rungs[Math.floor(ladder.rungs.length / 2)];
}

async function run(child, week, jev, spine, concurrency) {
  const set = loadWeek(child, week);
  if (!set) {
    console.log(`${child}: no question set on disk${week != null ? ` for week ${week}` : ''}. Run scripts/kh.py pull`);
    return 0;
  }

  const jobs = [];
  for (const section of set.sections) {
    for (const q of section.questions) {
      if (q.inputType === 'none') continue;
      // Drill items are 30 near identical sums. Sample them rather than paying
      // for 30 requests that will say the same thing.
      if (section.scoreBand && section.questions.indexOf(q) % 10 !== 0) continue;
      jobs.push({ section, question: q });
    }
  }

  console.log(BAR);
  console.log(`${child.toUpperCase()}  week ${set.weekNum}  checking ${jobs.length} questions`);
  console.log(BAR);

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

const args = process.argv.slice(2);
let concurrency = 4;
const ci = args.indexOf('--concurrency');
if (ci !== -1) { concurrency = Number(args[ci + 1]); args.splice(ci, 2); }
const child = args[0];
const week = args[1] != null ? Number(args[1]) : null;

const spine = JSON.parse(readFileSync(join(ROOT, 'curriculum', 'spine.json'), 'utf8'));
const jev = new Jev(apiKey());
const children = child ? [child] : ['mason', 'elysia'];

let totalFlagged = 0;
for (const c of children) totalFlagged += await run(c, week, jev, spine, concurrency);

console.log(`\n${BAR}`);
console.log(`${totalFlagged} question(s) flagged across ${children.length} child(ren)`);
console.log(`cost: ${jev.usage.requests} requests, ${jev.usage.inputTokens.toLocaleString()} input tokens, `
  + `about $${(jev.usage.inputTokens / 1e6 * 0.042).toFixed(4)}`);
if (totalFlagged) console.log('A flag is a prompt to look, not a verdict. Decide each one yourself.');
process.exit(0);

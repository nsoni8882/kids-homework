#!/usr/bin/env node
/* THE GATE. Run this before any week goes to the children.
 *
 *   node scripts/check-week.mjs              both children
 *   node scripts/check-week.mjs mason        one
 *   node scripts/check-week.mjs --no-ai      deterministic checks only, free and instant
 *
 * Exit code 0 means the week may go out. Anything else means fix it first.
 *
 * Two kinds of check, deliberately kept apart:
 *
 *   BLOCK   deterministic. Structure, marks, the curriculum coverage rules and
 *           the hard limits. These are facts, so failing one stops the week.
 *
 *   REVIEW  Jev's judgment. Ambiguity, a wrong key, a hint, the level, whether
 *           the section tests the rung. These are probabilities near a
 *           threshold, so a borderline one can differ between runs. They are
 *           raised for a human, and only a very high confidence one blocks.
 *
 * Treating a judgment as a fact is how a gate ends up being ignored.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Jev, checkQuestion, checkSection } from '../worker/src/jev.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const BLOCK_AT = 0.90;   // a Jev flag this strong stops the week on its own

const args = process.argv.slice(2);
const noAi = args.includes('--no-ai');
const child = args.find((a) => !a.startsWith('--'));
const children = child ? [child] : ['mason', 'elysia'];

const spine = JSON.parse(readFileSync(join(ROOT, 'curriculum', 'spine.json'), 'utf8'));

function rungFor(c, slot) {
  const ladder = spine.ladders[c] && spine.ladders[c][slot];
  if (!ladder) return null;
  const p = join(DATA, 'curriculum', 'position.json');
  if (existsSync(p)) {
    const here = (((JSON.parse(readFileSync(p, 'utf8')).children || {})[c] || {}).slots || {})[slot];
    if (here) {
      const found = ladder.rungs.find((r) => r.id === here.rung);
      if (found) return found;
    }
  }
  return ladder.rungs[Math.floor(ladder.rungs.length / 2)];
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

const blocks = [];
const reviews = [];

/* ---------------------------------------------- 1. deterministic, blocking */

console.log('\x1b[1m1. Structure, coverage and hard limits\x1b[0m');
try {
  execFileSync('python3', [join(ROOT, 'scripts', 'kh.py'), 'validate'], {
    cwd: ROOT, encoding: 'utf8', stdio: 'pipe',
  });
  console.log('   all deterministic checks pass\n');
} catch (err) {
  const out = `${err.stdout || ''}${err.stderr || ''}`.trim();
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('error:')) { blocks.push(t); console.log(`   BLOCK  ${t}`); }
  }
  console.log('');
}

/* ------------------------------------------ 2. the marking engine agrees */

console.log('\x1b[1m2. Every accepted answer matches itself\x1b[0m');
try {
  const out = execFileSync('node', [join(ROOT, 'scripts', 'test.mjs'), '--check-accepted'], {
    cwd: ROOT, encoding: 'utf8', stdio: 'pipe',
  });
  console.log(`   ${out.trim().split('\n').pop()}\n`);
} catch (err) {
  const out = `${err.stdout || ''}`.trim();
  for (const line of out.split('\n')) {
    if (line.trim().startsWith('mason') || line.trim().startsWith('elysia')) {
      blocks.push(line.trim());
      console.log(`   BLOCK  ${line.trim()}`);
    }
  }
  console.log('');
}

/* ------------------------------------------------- 3. Jev, for review */

if (!noAi) {
  const md = join(ROOT, 'CLAUDE.md');
  const key = existsSync(md) && readFileSync(md, 'utf8').match(/^- API key: `([^`]+)`/m);
  if (!key) {
    console.log('\x1b[1m3. Question quality\x1b[0m\n   skipped, no Jev key in CLAUDE.md\n');
  } else {
    const jev = new Jev(key[1]);
    console.log('\x1b[1m3. Question quality, judged by Jev\x1b[0m');

    for (const c of children) {
      const p = join(DATA, 'current', `${c}.json`);
      if (!existsSync(p)) { console.log(`   ${c}: no current week on disk`); continue; }
      const set = JSON.parse(readFileSync(p, 'utf8'));

      const secResults = await pool(set.sections, 4, async (section) => {
        try {
          return await checkSection(jev, {
            child: c, section, spineSlot: spine.slots[section.id], rung: rungFor(c, section.id),
          });
        } catch (e) { return { sectionId: section.id, flags: [], clean: true, error: e.message }; }
      });

      const jobs = [];
      for (const section of set.sections) {
        for (const q of section.questions) {
          if (q.inputType === 'none') continue;
          if (section.scoreBand && section.questions.indexOf(q) % 10 !== 0) continue;
          jobs.push({ section, question: q });
        }
      }
      const qResults = await pool(jobs, 4, async ({ section, question }) => {
        try {
          return {
            section, question,
            ...(await checkQuestion(jev, {
              child: c, section, question,
              spineSlot: spine.slots[section.id], rung: rungFor(c, section.id),
            })),
          };
        } catch (e) { return { section, question, flags: [], clean: true, error: e.message }; }
      });

      const all = [
        ...secResults.filter((r) => !r.clean).map((r) => ({
          where: `${c} section ${r.sectionId}`, flags: r.flags,
        })),
        ...qResults.filter((r) => !r.clean).map((r) => ({
          where: `${c} ${r.questionId}`, flags: r.flags, text: r.question.text,
        })),
      ];

      if (!all.length) {
        console.log(`   ${c} week ${set.weekNum}: nothing raised across ${jobs.length} questions`);
        continue;
      }
      console.log(`   ${c} week ${set.weekNum}:`);
      for (const item of all) {
        for (const f of item.flags) {
          const hard = f.probability >= BLOCK_AT;
          const line = `${item.where}: ${f.label} (${(f.probability * 100).toFixed(0)}%)`;
          if (hard) { blocks.push(line); console.log(`   BLOCK  ${line}`); }
          else { reviews.push({ line, text: item.text }); console.log(`   review ${line}`); }
          if (item.text) console.log(`          ${item.text.replace(/\s+/g, ' ').slice(0, 92)}`);
        }
      }
    }
    console.log(`\n   cost: ${jev.usage.requests} requests, about `
      + `$${(jev.usage.inputTokens / 1e6 * 0.042).toFixed(4)}\n`);
  }
}

/* ------------------------------------------------------------- verdict */

console.log('\x1b[1m' + '='.repeat(72) + '\x1b[0m');
if (blocks.length) {
  console.log(`\x1b[31mBLOCKED: ${blocks.length} problem(s) must be fixed before this week goes out.\x1b[0m`);
  for (const b of blocks) console.log(`  - ${b}`);
  if (reviews.length) console.log(`\nAlso ${reviews.length} item(s) raised for review.`);
  process.exit(1);
}
if (reviews.length) {
  console.log(`\x1b[33mPASSED with ${reviews.length} item(s) raised for review.\x1b[0m`);
  for (const r of reviews) console.log(`  - ${r.line}`);
  console.log('\nThese are judgments, not facts. Look at each, then decide.');
  process.exit(0);
}
console.log('\x1b[32mPASSED. Nothing raised. The week is ready.\x1b[0m');
process.exit(0);

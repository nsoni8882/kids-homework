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
import { join } from 'node:path';
import { Jev, checkQuestion, checkSection } from '../worker/src/jev.js';
import {
  ROOT, apiKey, loadSpine, loadWeek, pool, rungFor, questionsToCheck,
  slotsMissingRung, costLine,
} from './lib/gate.mjs';

const BLOCK_AT = 0.90;   // a Jev flag this strong stops the week on its own

const args = process.argv.slice(2);
const noAi = args.includes('--no-ai');
const child = args.find((a) => !a.startsWith('--'));
const children = child ? [child] : ['mason', 'elysia'];

const spine = loadSpine();

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
  // A non zero exit means validate found problems and listed them on stdout.
  // Anything else means validate never ran, which must block too: a gate that
  // cannot run its own checks has not passed them. An earlier version swallowed
  // that case and printed PASSED while checking nothing.
  const out = `${err.stdout || ''}${err.stderr || ''}`.trim();
  const found = out.split('\n')
    .map((l) => l.trim())
    .filter((t) => t && !t.startsWith('error:'));
  if (err.status != null && found.length) {
    for (const t of found) { blocks.push(t); console.log(`   BLOCK  ${t}`); }
  } else {
    const why = `could not run kh.py validate: ${err.message.split('\n')[0]}`;
    blocks.push(why);
    console.log(`   BLOCK  ${why}`);
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
  const found = out.split('\n')
    .map((l) => l.trim())
    .filter((t) => t.startsWith('mason') || t.startsWith('elysia'));
  if (err.status != null && found.length) {
    for (const t of found) { blocks.push(t); console.log(`   BLOCK  ${t}`); }
  } else {
    const why = `could not run the accepted answer check: ${err.message.split('\n')[0]}`;
    blocks.push(why);
    console.log(`   BLOCK  ${why}`);
  }
  console.log('');
}

/* ------------------------------------------------- 3. Jev, for review */

if (!noAi) {
  const key = apiKey({ quiet: true });
  if (!key) {
    console.log('\x1b[1m3. Question quality\x1b[0m\n   skipped, no Jev key in CLAUDE.md\n');
  } else {
    const jev = new Jev(key);
    console.log('\x1b[1m3. Question quality, judged by Jev\x1b[0m');

    for (const c of children) {
      const set = loadWeek(c, null);
      if (!set) { console.log(`   ${c}: no current week on disk`); continue; }

      // A slot with no recorded rung cannot be judged for level or evidence.
      // Say so: silence here used to mean "judged against a guessed rung".
      const noRung = slotsMissingRung(spine, c, set);
      if (noRung.length) {
        console.log(`   ${c}: no rung recorded for ${noRung.join(', ')}, `
          + 'so the level checks are skipped there');
      }

      const secResults = await pool(set.sections, 4, async (section) => {
        try {
          return await checkSection(jev, {
            child: c, section, spineSlot: spine.slots[section.id], rung: rungFor(spine, c, section.id),
          });
        } catch (e) { return { sectionId: section.id, flags: [], clean: true, error: e.message }; }
      });

      const jobs = questionsToCheck(set);
      const qResults = await pool(jobs, 4, async ({ section, question }) => {
        try {
          return {
            section, question,
            ...(await checkQuestion(jev, {
              child: c, section, question,
              spineSlot: spine.slots[section.id], rung: rungFor(spine, c, section.id),
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
    console.log(`\n   cost: ${costLine(jev)}\n`);
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

#!/usr/bin/env node
/* Calibration set for the Jev question quality gate.
 *
 *   node scripts/jev-calibrate.mjs
 *
 * Every case below is one I can reason out by hand, so the gate can be judged
 * rather than trusted. GOOD cases must come back clean, BAD cases must raise
 * the named flag. Run this after changing any prompt or threshold in
 * worker/src/jev.js, because a gate that cries wolf gets ignored, and a gate
 * that stays quiet is worse than none.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Jev, checkQuestion } from '../worker/src/jev.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const spine = JSON.parse(readFileSync(join(ROOT, 'curriculum', 'spine.json'), 'utf8'));

const md = join(ROOT, 'CLAUDE.md');
if (!existsSync(md)) { console.error('CLAUDE.md not found'); process.exit(1); }
const key = readFileSync(md, 'utf8').match(/^- API key: `([^`]+)`/m)[1];

const CASES = [
  // ---- should be CLEAN -------------------------------------------------
  {
    name: 'analogy, both completions accepted',
    expect: null,
    why: 'butterfly and moth are both in the key, so there is nothing a child could be marked wrong for',
    slot: '3A',
    section: { id: '3A', title: 'Analogies', subject: 'thinking' },
    question: { id: 'c1', text: 'tadpole : frog :: caterpillar : ____', marks: 1, accepted: ['butterfly', 'a butterfly', 'moth'] },
  },
  {
    name: 'cipher, shift deliberately given',
    expect: null,
    why: 'stating the shift IS the task. It must not be read as a hint',
    slot: '3C',
    section: { id: '3C', title: 'Caesar Cipher: Shift 5', subject: 'thinking', passage: 'Shift each letter back 5 places in the alphabet.' },
    question: { id: 'c2', text: 'Decode (shift back 5): RTTS', marks: 1, accepted: ['moon', 'MOON'] },
  },
  {
    name: 'odd one out on words, one clean rule',
    expect: null,
    why: 'rose is the only non tree. That is the intended rule, not a shortcut past it',
    slot: '3A',
    rung: '3A.4',
    section: { id: '3A', title: 'Odd One Out', subject: 'thinking' },
    question: { id: 'c3', text: 'oak, maple, rose, pine\nOdd one out: ____', marks: 1, accepted: ['rose', 'a rose'] },
  },
  {
    name: 'number set, parity does not single one out',
    expect: null,
    why: '24, 36, 60 are multiples of 12 and 40 is not. All four are even, so parity gives nothing',
    slot: '3B',
    section: { id: '3B', title: 'Odd One Out', subject: 'thinking' },
    question: { id: 'c4', text: '24, 36, 40, 60\nOdd one out: ____', marks: 1, accepted: ['40'] },
  },
  {
    name: 'straight comprehension retrieval',
    expect: null,
    why: 'one fact, stated once, key correct',
    slot: '1A',
    section: { id: '1A', title: 'Reading Comprehension', subject: 'english', passage: 'A koala sleeps for up to 20 hours a day.' },
    question: { id: 'c5', text: 'How many hours a day can a koala sleep?', marks: 1, accepted: ['20', '20 hours', 'up to 20 hours'] },
  },

  // ---- should be FLAGGED -----------------------------------------------
  {
    name: 'number set where parity gives a rival answer',
    expect: 'parity_shortcut',
    why: '28, 42, 50 are even and 35 is the only odd, so 35 is defensible, but the key says 50',
    slot: '3B',
    section: { id: '3B', title: 'Odd One Out', subject: 'thinking' },
    question: { id: 'b1', text: '28, 35, 42, 50\nOdd one out: ____', marks: 1, accepted: ['50'] },
  },
  {
    name: 'two rival rules, neither in the key',
    expect: 'parity_shortcut',
    why: '2 is the only even number and 9 is the only non prime, so two answers are defensible',
    slot: '3B',
    section: { id: '3B', title: 'Odd One Out', subject: 'thinking' },
    question: { id: 'b2', text: '2, 3, 5, 9\nOdd one out: ____', marks: 1, accepted: ['9'] },
  },
  {
    name: 'key is arithmetically wrong',
    expect: 'key_wrong',
    why: '7 x 8 is 56, not 54',
    slot: '2A',
    section: { id: '2A', title: 'Multiplication Fluency', subject: 'maths' },
    question: { id: 'b3', text: 'What is 7 x 8?', marks: 1, accepted: ['54'] },
  },
  {
    name: 'key contradicts the passage',
    expect: 'key_wrong',
    why: 'the passage says 8 kilograms, the key says 30',
    slot: '1A',
    section: { id: '1A', title: 'Reading Comprehension', subject: 'english', passage: 'A grown koala weighs about 8 kilograms. A wombat is much heavier, at around 30 kilograms.' },
    question: { id: 'b4', text: 'About how much does a grown koala weigh?', marks: 1, accepted: ['30 kilograms'] },
  },
  {
    name: 'passage states the rule the question tests',
    expect: 'hinted',
    why: 'the passage defines a simile, so naming one proves only that the child can copy',
    slot: '3A',
    section: { id: '3A', title: 'Figurative Language', subject: 'thinking', passage: 'A simile compares two things using the words like or as. A metaphor says one thing IS another.' },
    question: { id: 'b5', text: "Is 'as brave as a lion' a simile or a metaphor?", marks: 1, accepted: ['simile'] },
  },
  {
    name: 'key omits equally correct synonyms',
    expect: 'answers_too_narrow',
    why: 'cheerful and joyful are as correct as glad, and none of them is a wording the deterministic matcher can reach',
    slot: '1C',
    section: { id: '1C', title: 'Word Knowledge', subject: 'english' },
    question: { id: 'b6', text: 'Write another word that means the same as happy.', marks: 1, accepted: ['glad'] },
  },
  {
    name: 'far above a 7 year old',
    expect: 'too_hard',
    why: 'simultaneous equations for an Elysia maths slot',
    slot: '2C',
    child: 'elysia',
    rung: '2C.3',
    section: { id: '2C', title: 'Word Problems', subject: 'maths' },
    question: { id: 'b7', text: 'If 3 pencils and 2 rubbers cost 85p, and 5 pencils and 4 rubbers cost 155p, what does one pencil cost?', marks: 1, accepted: ['15p'] },
  },
];

const jev = new Jev(key);
const rows = [];

for (const c of CASES) {
  let res;
  try {
    const child = c.child || 'mason';
    const ladder = spine.ladders[child][c.slot];
    res = await checkQuestion(jev, {
      child,
      section: c.section,
      question: c.question,
      spineSlot: spine.slots[c.slot],
      rung: c.rung ? ladder.rungs.find((r) => r.id === c.rung) : ladder.rungs[1],
    });
  } catch (err) {
    rows.push({ c, pass: false, detail: `error: ${err.message}` });
    continue;
  }
  const keys = res.flags.map((f) => f.key);
  const pass = c.expect === null ? res.clean : keys.includes(c.expect);
  const shown = res.flags.length
    ? res.flags.map((f) => `${f.key} ${(f.probability * 100).toFixed(0)}%`).join(', ')
    : 'clean';
  rows.push({ c, pass, detail: shown, raw: res.raw });
}

console.log('='.repeat(96));
console.log('Jev question quality gate, calibration');
console.log('='.repeat(96));
let failed = 0;
for (const r of rows) {
  if (!r.pass) failed++;
  const want = r.c.expect === null ? 'clean' : r.c.expect;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.c.name.padEnd(44)} want ${want.padEnd(20)} got ${r.detail}`);
  if (!r.pass) {
    console.log(`      why it matters: ${r.c.why}`);
    if (r.raw) {
      console.log(`      raw: ${Object.entries(r.raw).map(([k, v]) => `${k}=${v.noul.toFixed(2)}`).join('  ')}`);
    }
  }
}
console.log('-'.repeat(96));
console.log(`${rows.length - failed} of ${rows.length} passed`);
console.log(`cost: ${jev.usage.requests} requests, ${jev.usage.inputTokens.toLocaleString()} tokens, `
  + `about $${(jev.usage.inputTokens / 1e6 * 0.042).toFixed(4)}`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
/* Tests for the marking engine, plus two checks you run against the real data.
 *
 *   node scripts/test.mjs                   run the unit tests
 *   node scripts/test.mjs --check-accepted  every accepted answer in the current
 *                                           week must match itself
 *   node scripts/test.mjs --mark <child> <week>
 *                                           re-mark a saved week and compare with
 *                                           the marks that were stored
 *
 * The marking rules decide a child's score, so they are locked down here. If a
 * change to marking.js breaks a case below, that is the point: work out whether
 * the case or the change is wrong before touching the test.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answersMatch, markSection, countCorrect } from '../assets/marking.js';
import { markWeek } from '../worker/src/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');

let passed = 0;
const failures = [];

function ok(name, cond) {
  if (cond) { passed++; return; }
  failures.push(name);
}

const match = (kid, accepted, type) => answersMatch(kid, accepted, type);

/* ------------------------------------------------------------- unit tests */

function unitTests() {
  // exact and trivial differences
  ok('exact match', match('west', ['west']));
  ok('case insensitive', match('WeSt', ['west']));
  ok('surrounding space', match('  west  ', ['west']));
  ok('trailing full stop', match('west.', ['west']));
  ok('trailing question mark', match('west?', ['west']));
  ok('empty answer is wrong', !match('', ['west']));
  ok('whitespace only is wrong', !match('   ', ['west']));
  ok('null answer is wrong', !match(null, ['west']));
  ok('wrong word is wrong', !match('east', ['west']));
  ok('no accepted list is wrong', !match('west', []));
  ok('undefined accepted list is wrong', !match('west', undefined));

  // numbers
  ok('number exact', match('20', ['20']));
  ok('number with a unit', match('43 cm', ['43']));
  ok('number with a word unit', match('20 hours', ['20']));
  ok('number with a comma', match('1,500', ['1500']));
  ok('accepted has the comma', match('1500', ['1,500']));
  ok('different number is wrong', !match('21', ['20']));
  ok('number inside a phrase still matches the number key', match('20 hours a day', ['20']));
  ok('word form when listed', match('twenty', ['20', 'twenty']));
  ok('word form not listed is wrong', !match('twenty', ['20']));

  // leading fillers
  ok('leading "for"', match('for 2 hours', ['2 hours']));
  ok('leading "because"', match('because it was raining', ['it was raining']));
  ok('leading "the" on the key', match('wetlands of Carolina', ['the wetlands of Carolina']));
  ok('leading "the" on the answer', match('the wetlands', ['wetlands']));
  ok('leading "in the"', match('in the bank of a stream', ['bank of a stream']));
  ok('stacked fillers', match('in the bank', ['bank']));

  // spacing and punctuation
  ok('stray internal spaces', match('w e s t', ['west']));
  ok('missing space', match('atmidnight', ['at midnight']));
  ok('"and" dropped', match('tall thin', ['tall and thin']));
  ok('"and" added', match('tall and thin', ['tall thin']));
  ok('commas instead of "and"', match('tall, thin, hungry', ['tall, thin and hungry']));

  // the loose containment rule, and the guard on it
  ok('extra words around a text answer', match('On Monday morning', ['Monday']));
  ok('negated answer is wrong', !match('not Monday', ['Monday']));
  ok("contracted negation is wrong", !match("wasn't Monday", ['Monday']));
  ok('curly apostrophe negation is wrong', !match('wasn’t Monday', ['Monday']));
  ok('"never" is wrong', !match('never Monday', ['Monday']));
  ok('naming both true and false is wrong', !match('true or false', ['true']));
  ok('far too many extra words is wrong',
    !match('one two three four five Monday', ['Monday']));
  ok('containment needs the whole phrase in order',
    !match('Monday evening', ['Monday morning']));

  // letters are strict
  ok('letter exact', match('S', ['S'], 'letter'));
  ok('letter lower cased', match('s', ['S'], 'letter'));
  ok('letter with space', match(' M ', ['M'], 'letter'));
  ok('wrong letter', !match('P', ['S'], 'letter'));
  ok('letter does not use the loose rules', !match('simile', ['S'], 'letter'));
  ok('empty letter is wrong', !match('', ['S'], 'letter'));

  // several accepted answers
  ok('second accepted answer', match('shrimps', ['worms', 'shrimps']));
  ok('none of several', !match('beetles', ['worms', 'shrimps']));

  /* ---- markSection ---- */

  const plain = {
    id: '1A', subject: 'english', totalMarks: 4, questions: [
      { id: 'q1', marks: 1, inputType: 'text', autoMark: true, accepted: ['20'] },
      { id: 'q2', marks: 2, inputType: 'text', autoMark: true, accepted: ['west'] },
      { id: 'q3', marks: 1, inputType: 'multiline', autoMark: false, markScheme: 'any two reasons' },
    ],
  };
  ok('section all right', markSection(plain, { q1: '20', q2: 'west', q3: 'blah' }) === 3);
  ok('section partly right', markSection(plain, { q1: '20', q2: 'east' }) === 1);
  ok('section none right', markSection(plain, {}) === 0);
  ok('parent marked questions score nothing automatically',
    markSection(plain, { q1: '20', q2: 'west', q3: 'a perfect answer' }) === 3);

  const display = {
    id: '2A', totalMarks: 1, questions: [
      { id: 'd1', marks: 1, inputType: 'none', autoMark: true, accepted: ['ignored'] },
      { id: 'd2', marks: 1, inputType: 'text', autoMark: true, accepted: ['7'] },
    ],
  };
  ok('display only questions are skipped', markSection(display, { d1: 'x', d2: '7' }) === 1);

  const drill = {
    id: '2A', totalMarks: 8, scoreBand: true,
    scoreBandRules: [[29, 30, 8], [25, 28, 6], [20, 24, 4], [0, 19, 2]],
    questions: Array.from({ length: 30 }, (_, i) => ({
      id: `d${i}`, marks: 1, inputType: 'number', autoMark: true, accepted: [String(i)],
    })),
  };
  const allRight = Object.fromEntries(drill.questions.map((q, i) => [q.id, String(i)]));
  ok('drill top band', markSection(drill, allRight) === 8);
  ok('drill counts correct', countCorrect(drill, allRight) === 30);

  const twoWrong = { ...allRight, d0: 'x', d1: 'x' };
  ok('drill second band', markSection(drill, twoWrong) === 6);
  ok('drill bottom band', markSection(drill, {}) === 2);

  const fiveWrong = { ...allRight };
  for (let i = 0; i < 5; i++) fiveWrong[`d${i}`] = 'x';
  ok('drill 25 correct is the second band', markSection(drill, fiveWrong) === 6);
  const sixWrong = { ...fiveWrong, d5: 'x' };
  ok('drill 24 correct is the third band', markSection(drill, sixWrong) === 4);

  const noBands = { ...drill, scoreBandRules: [] };
  ok('drill with no bands scores nothing', markSection(noBands, allRight) === 0);
}

/* ------------------------------------------------- the server side marking */

/* markWeek decides every mark now, so it is tested here against a stub Jev
   rather than the real one: the point is the ORDER and the bookkeeping, which
   must not depend on a network call or on what a model happens to say today.

   The stub records what it was asked, so a test can assert that something was
   NOT sent to Jev, which is half the design. */
function stubJev(reply) {
  const asked = [];
  return {
    asked,
    ask: async (state, questions) => {
      asked.push({ state, keys: Object.keys(questions) });
      if (typeof reply === 'function') return reply(state, questions);
      return reply;
    },
    usage: { requests: 0, inputTokens: 0 },
  };
}

const CORRECT = { essentially_correct: { noul: 0.99, confidence: 0.99 } };
const WRONG = { essentially_correct: { noul: 0.01, confidence: 0.99 } };
const UNSURE = { essentially_correct: { noul: 0.5, confidence: 0.5 } };

const oneSection = (questions, extra = {}) => ({
  weekNum: 1,
  sections: [{ id: '1A', subject: 'english', title: 'T', timerMins: 5,
    totalMarks: questions.reduce((t, q) => t + q.marks, 0), questions, ...extra }],
});

const q = (over = {}) => ({
  id: '1A-Q1', text: 'q', marks: 1, inputType: 'text', autoMark: true, accepted: ['west'], ...over,
});

async function serverMarkingTests() {
  /* the deterministic pass comes first and must not reach Jev at all */
  {
    const set = oneSection([q()]);
    const jev = stubJev(CORRECT);
    const r = await markWeek('mason', set, { '1A-Q1': 'West.' }, jev);
    ok('accepted answer is marked by the engine, not Jev', r.perQuestion['1A-Q1'].markedBy === 'auto');
    ok('accepted answer scores its marks', r.sectionMarks['1A'] === 1);
    ok('accepted answer never reaches Jev', jev.asked.length === 0);
    ok('nothing is referred', r.needsParent === 0);
  }

  /* a rejected answer goes to Jev, and Jev can overturn it */
  {
    const set = oneSection([q()]);
    const jev = stubJev(CORRECT);
    const r = await markWeek('mason', set, { '1A-Q1': 'the western side' }, jev);
    ok('rejected answer is sent to Jev', jev.asked.length === 1);
    ok('Jev can mark it correct', r.perQuestion['1A-Q1'].markedBy === 'jev');
    ok('Jev correct earns the marks', r.sectionMarks['1A'] === 1);
  }
  {
    const set = oneSection([q()]);
    const r = await markWeek('mason', set, { '1A-Q1': 'east' }, stubJev(WRONG));
    ok('Jev wrong scores nothing', r.sectionMarks['1A'] === 0);
    ok('Jev wrong is still decided, not referred', r.perQuestion['1A-Q1'].marks === 0);
  }

  /* an uncertain answer is referred, never guessed */
  {
    const set = oneSection([q()]);
    // Deliberately an answer the engine rejects outright. "maybe west" would
    // NOT do: the containment rule accepts a correct phrase inside a longer
    // answer, so it never reaches Jev at all.
    const r = await markWeek('mason', set, { '1A-Q1': 'I am not sure' }, stubJev(UNSURE));
    ok('uncertain is referred to the parent', r.perQuestion['1A-Q1'].markedBy === 'parent');
    ok('a referred mark is null, not zero', r.perQuestion['1A-Q1'].marks === null);
    ok('a referral is counted', r.needsParent === 1);
    ok('a referred question scores nothing yet', r.sectionMarks['1A'] === 0);
  }

  /* a parent marked question goes to Jev rather than straight to the parent */
  {
    const set = oneSection([q({ autoMark: false, accepted: undefined, markScheme: 'any reason' })]);
    const jev = stubJev(CORRECT);
    const r = await markWeek('mason', set, { '1A-Q1': 'because it was raining' }, jev);
    ok('a parent marked question is offered to Jev first', jev.asked.length === 1);
    ok('Jev can settle it', r.perQuestion['1A-Q1'].markedBy === 'jev');
  }

  /* Jev being unavailable must refer, never guess */
  {
    const set = oneSection([q()]);
    const jev = { ask: async () => { throw new Error('down'); }, usage: {} };
    const r = await markWeek('mason', set, { '1A-Q1': 'something else' }, jev);
    ok('Jev failing refers to the parent', r.perQuestion['1A-Q1'].markedBy === 'parent');
    ok('Jev failing does not score the question', r.perQuestion['1A-Q1'].marks === null);
    ok('the reason says Jev was unavailable', /unavailable/i.test(r.perQuestion['1A-Q1'].reason));
  }

  /* blanks and letters are settled without asking */
  {
    const set = oneSection([q({ inputType: 'letter', accepted: ['S'] })]);
    const jev = stubJev(CORRECT);
    const r = await markWeek('mason', set, { '1A-Q1': 'P' }, jev);
    ok('a wrong letter is decided locally', jev.asked.length === 0);
    ok('a wrong letter scores nothing', r.perQuestion['1A-Q1'].marks === 0);
  }
  {
    const set = oneSection([q()]);
    const jev = stubJev(CORRECT);
    const r = await markWeek('mason', set, { '1A-Q1': '   ' }, jev);
    ok('a blank is never sent to Jev', jev.asked.length === 0);
    ok('a blank scores nothing', r.perQuestion['1A-Q1'].marks === 0);
    ok('a blank reason says so', r.perQuestion['1A-Q1'].reason === 'left blank');
  }
  {
    const set = oneSection([q(), q({ id: '1A-Q2' })]);
    const jev = stubJev(CORRECT);
    const r = await markWeek('mason', set, {}, jev);
    ok('a missing answer is treated as blank', r.perQuestion['1A-Q2'].marks === 0);
    ok('no answers means no Jev calls', jev.asked.length === 0);
  }

  /* a non string answer must not take the submission down */
  {
    const set = oneSection([q({ inputType: 'number', accepted: ['20'] })]);
    const r = await markWeek('mason', set, { '1A-Q1': 20 }, stubJev(CORRECT));
    ok('a numeric answer is coerced, not crashed on', r.sectionMarks['1A'] === 1);
  }
  {
    const set = oneSection([q()]);
    const r = await markWeek('mason', set, { '1A-Q1': { nope: 1 } }, stubJev(CORRECT));
    ok('an object answer is treated as blank', r.perQuestion['1A-Q1'].marks === 0);
  }

  /* display only items are not questions */
  {
    const set = oneSection([q({ id: '1A-Q1', inputType: 'none' }), q({ id: '1A-Q2' })]);
    const jev = stubJev(CORRECT);
    const r = await markWeek('mason', set, { '1A-Q1': 'x', '1A-Q2': 'west' }, jev);
    ok('a display only item gets no verdict', r.perQuestion['1A-Q1'] === undefined);
  }

  /* a drill is banded on the count correct */
  {
    const items = Array.from({ length: 30 }, (_, i) => q({
      id: `2A-Q${i}`, marks: 1, inputType: 'number', accepted: [String(i)],
    }));
    const set = {
      weekNum: 1,
      sections: [{ id: '2A', subject: 'maths', title: 'Drill', timerMins: 8, totalMarks: 8,
        scoreBand: true, scoreBandRules: [[29, 30, 8], [25, 28, 6], [20, 24, 4], [0, 19, 2]],
        questions: items }],
    };
    const all = Object.fromEntries(items.map((x, i) => [x.id, String(i)]));
    const r1 = await markWeek('mason', set, all, stubJev(CORRECT));
    ok('a full drill takes the top band', r1.sectionMarks['2A'] === 8);
    ok('the drill total is the band, not the item count', r1.total === 8);

    const three = { ...all, '2A-Q0': '', '2A-Q1': '', '2A-Q2': '' };
    const r2 = await markWeek('mason', set, three, stubJev(CORRECT));
    ok('27 of 30 is the second band', r2.sectionMarks['2A'] === 6);

    // A drill item Jev cannot settle must still be counted as waiting.
    // "about 0" would be accepted: "about " is a leading filler. Use a word
    // form, which the engine has no rule for.
    const one = { ...all, '2A-Q0': 'zero' };
    const r3 = await markWeek('mason', set, one, stubJev(UNSURE));
    ok('a referred drill item is counted as needing a parent', r3.needsParent === 1);
  }

  /* the totals are the sum of the sections, and outOf comes from the paper */
  {
    const set = {
      weekNum: 1,
      sections: [
        { id: '1A', subject: 'english', title: 'A', timerMins: 5, totalMarks: 2,
          questions: [q({ id: '1A-Q1', marks: 2, accepted: ['west'] })] },
        { id: '2B', subject: 'maths', title: 'B', timerMins: 5, totalMarks: 1,
          questions: [q({ id: '2B-Q1', accepted: ['7'] })] },
      ],
    };
    const r = await markWeek('mason', set, { '1A-Q1': 'west', '2B-Q1': '7' }, stubJev(CORRECT));
    ok('totals add the sections up', r.total === 3);
    ok('outOf comes from the question set', r.outOf === 3);
    ok('each section is reported', r.sectionMarks['1A'] === 2 && r.sectionMarks['2B'] === 1);
    ok('sectionOutOf is reported', r.sectionOutOf['1A'] === 2);
  }

  /* a multi mark question uses the credit score and must be confident */
  {
    const set = oneSection([q({ marks: 2, autoMark: false, accepted: undefined, markScheme: 'two reasons' })]);
    const confident = { essentially_correct: { noul: 0.9, confidence: 0.9 },
      credit: { score: 1, confidence: 0.95 } };
    const r = await markWeek('mason', set, { '1A-Q1': 'one reason' }, stubJev(confident));
    ok('partial credit is awarded', r.perQuestion['1A-Q1'].marks === 1);

    const shaky = { essentially_correct: { noul: 0.9, confidence: 0.9 },
      credit: { score: 1, confidence: 0.4 } };
    const r2 = await markWeek('mason', set, { '1A-Q1': 'one reason' }, stubJev(shaky));
    ok('low confidence credit is referred', r2.perQuestion['1A-Q1'].marks === null);
  }
}

/* ------------------------------------------------- checks against the data */

function latestQuestionSets() {
  const out = [];
  for (const child of ['mason', 'elysia']) {
    const cur = join(DATA, 'current', `${child}.json`);
    if (existsSync(cur)) {
      out.push({ child, label: 'current', set: JSON.parse(readFileSync(cur, 'utf8')) });
    }
  }
  return out;
}

function checkAccepted() {
  const sets = latestQuestionSets();
  if (!sets.length) {
    console.log('no data on disk. Run: scripts/kh.py pull');
    return 1;
  }
  let bad = 0;
  let checked = 0;
  for (const { child, set } of sets) {
    for (const sec of set.sections || []) {
      for (const q of sec.questions || []) {
        if (!q.autoMark) continue;
        if (!q.accepted || !q.accepted.length) {
          console.log(`  ${child} ${q.id}: autoMark is on but accepted[] is empty`);
          bad++;
          continue;
        }
        for (const a of q.accepted) {
          checked++;
          if (!answersMatch(a, q.accepted, q.inputType)) {
            console.log(`  ${child} ${q.id}: accepted answer ${JSON.stringify(a)} does not match itself`);
            bad++;
          }
        }
      }
    }
  }
  console.log(`checked ${checked} accepted answers across week ${sets.map((s) => s.set.weekNum).join(' and ')}`);
  console.log(bad ? `${bad} problem(s)` : 'every accepted answer matches itself');
  return bad ? 1 : 0;
}

function remark(child, week) {
  const wk = join(DATA, 'children', child, 'weeks', `w${String(week).padStart(2, '0')}.json`);
  if (!existsSync(wk)) {
    console.log(`no week ${week} on disk for ${child}. Run: scripts/kh.py pull`);
    return 1;
  }
  const rec = JSON.parse(readFileSync(wk, 'utf8'));

  let set = null;
  const qs = join(DATA, 'children', child, 'question-sets', `w${String(week).padStart(2, '0')}.json`);
  if (existsSync(qs)) set = JSON.parse(readFileSync(qs, 'utf8'));
  else {
    const cur = join(DATA, 'current', `${child}.json`);
    if (existsSync(cur)) {
      const c = JSON.parse(readFileSync(cur, 'utf8'));
      if (c.weekNum === week) set = c;
    }
  }
  if (!set) {
    const have = existsSync(join(DATA, 'children', child, 'question-sets'))
      ? readdirSync(join(DATA, 'children', child, 'question-sets')).join(' ') : 'none';
    console.log(`no question set saved for ${child} week ${week}. Sets on disk: ${have}`);
    return 1;
  }

  console.log(`re-marking ${child} week ${week} from the saved answers`);
  if (rec.adjustedAt) {
    console.log(`  note: this week was adjusted by hand on ${rec.adjustedAt}, so a stored mark`);
    console.log('  above the auto mark with no parent question behind it is expected. The reason');
    console.log("  should be in the week's notes.");
  }
  console.log('');
  console.log('  section                         auto   stored   note');
  let diffs = 0;
  for (const sec of set.sections) {
    const auto = markSection(sec, rec.answers);
    const stored = rec.sectionMarks[sec.id];
    const parentMarks = sec.questions
      .filter((q) => !q.autoMark && q.inputType !== 'none')
      .reduce((t, q) => t + q.marks, 0);
    let note = '';
    if (stored === undefined) note = 'not stored';
    else if (stored === auto) note = 'matches';
    else if (stored > auto && stored - auto <= parentMarks) {
      note = `+${stored - auto} from parent marking, up to ${parentMarks} available`;
    } else if (stored > auto && rec.adjustedAt) {
      note = `+${stored - auto} by hand, see notes`;
    } else {
      note = `UNEXPLAINED difference of ${stored - auto}`;
      diffs++;
    }
    console.log(`  ${sec.id} ${sec.title.slice(0, 26).padEnd(27)} ${String(auto).padStart(4)}   ${String(stored ?? '-').padStart(6)}   ${note}`);
  }
  const autoTotal = set.sections.reduce((t, s) => t + markSection(s, rec.answers), 0);
  console.log(`\n  auto marks ${autoTotal}, stored total ${rec.score.total} of ${rec.score.outOf}`);
  console.log(diffs ? `\n${diffs} section(s) need explaining` : '\nevery difference is explained by parent marking');
  return diffs ? 1 : 0;
}

/* ------------------------------------------------------------------- main */

const [flag, a, b] = process.argv.slice(2);

if (flag === '--check-accepted') {
  process.exit(checkAccepted());
} else if (flag === '--mark') {
  if (!a || !b) {
    console.log('usage: node scripts/test.mjs --mark <child> <week>');
    process.exit(1);
  }
  process.exit(remark(a, Number(b)));
} else {
  unitTests();
  await serverMarkingTests();
  if (failures.length) {
    console.log(`${passed} passed, ${failures.length} FAILED:`);
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log(`${passed} marking tests passed (engine and server)`);
}

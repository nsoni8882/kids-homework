#!/usr/bin/env node
/* Tests for the Jev decision helpers, against a stub so no network is used.
 *   node scripts/jev-helpers.test.mjs
 */
import { observeGap, reviewAward, assessEvidence, writingFeedback, scoreWriting } from '../worker/src/jev.js';
import { markWeek } from '../worker/src/index.js';

let passed = 0;
const failures = [];
const ok = (name, cond) => { if (cond) passed++; else failures.push(name); };
const stub = (reply) => ({
  asked: [],
  usage: { requests: 0, inputTokens: 0 },
  async ask(state, questions) { this.asked.push({ state, questions }); return typeof reply === 'function' ? reply(state, questions) : reply; },
});

const gap = { topic: 'Contrast sentences', detail: 'long history', slot: '1B' };
const section = { id: '1B', title: 'Sentences', questions: [] };
const items = [{ id: '1B-Q1', text: 'q', given: 'a', expected: 'b', engineCorrect: false }];
const reply = (tested, right) => ({ tests_gap: { noul: tested, confidence: 1 }, right_on_gap: { noul: right, confidence: 1 } });

{
  const r = await observeGap(stub(reply(0.99, 0.97)), { child: 'mason', gap, section, items });
  ok('right on a tested gap proposes 1', r.proposal === 1);
}
{
  const r = await observeGap(stub(reply(0.99, 0.03)), { child: 'mason', gap, section, items });
  ok('wrong on a tested gap proposes 0', r.proposal === 0);
}
{
  const r = await observeGap(stub(reply(0.1, 0.9)), { child: 'mason', gap, section, items });
  ok('an untested gap proposes null even if the answers look right', r.proposal === null);
}
{
  const r = await observeGap(stub(reply(0.9, 0.5)), { child: 'mason', gap, section, items });
  ok('an uncertain gap is referred, never guessed', r.proposal === 'refer');
}
{
  const r = await observeGap(stub(reply(0.9, 0.95)), { child: 'mason', gap, section: { ...section, hinted: true }, items });
  ok('a hinted section is flagged so the gap is not resolved', r.proposal === 1 && r.hinted === true);
}
{
  const j = stub(reply(0.9, 0.9));
  await observeGap(j, { child: 'elysia', gap, section, items });
  ok('the engine verdict is passed to Jev', j.asked[0].state.items[0].markingEngineSaysCorrect === false);
  ok('the child age is the child\'s', j.asked[0].state.childAge === 7);
}
{
  let threw = false;
  try { await observeGap(stub({}), { child: 'mason', gap, section, items }); } catch { threw = true; }
  ok('a reply missing an answer throws rather than guessing', threw);
}

/* award review */
const one = { id: 'q', text: 't', marks: 1, accepted: ['west'] };
const two = { id: 'q', text: 't', marks: 2, markScheme: 'two things' };
const yes = { essentially_correct: { noul: 0.99, confidence: 1 } };
const no = { essentially_correct: { noul: 0.01, confidence: 1 } };
{
  const r = await reviewAward(stub(no), { child: 'mason', question: one, given: 'east', awarded: 1 });
  ok('an award Jev would not give is flagged', r.flagged && r.suggested === 0);
}
{
  const r = await reviewAward(stub(yes), { child: 'mason', question: one, given: 'west', awarded: 1 });
  ok('an award Jev agrees with is not flagged', !r.flagged);
}
{
  const r = await reviewAward(stub({ essentially_correct: { noul: 0.5, confidence: 1 } }), { child: 'mason', question: one, given: 'x', awarded: 1 });
  ok('an uncertain second opinion is not a flag', !r.flagged);
}
{
  const r = await reviewAward(stub({ essentially_correct: { noul: 1, confidence: 1 }, credit: { score: 1, confidence: 0.95 } }),
    { child: 'mason', question: two, given: 'one thing', awarded: 2 });
  ok('an over award on a two mark question is flagged', r.flagged && r.suggested === 1);
}
{
  let threw = false;
  try { await reviewAward(stub({}), { child: 'mason', question: one, given: 'x', awarded: 1 }); } catch { threw = true; }
  ok('a broken reply throws so the caller can skip the review', threw);
}

/* advancement evidence */
const rung = { skill: 'a skill', advanceWhen: 'two clean weeks' };
const ev = (a, b) => ({ shortcut_possible: { noul: a, confidence: 1 }, answers_not_showing_skill: { noul: b, confidence: 1 } });
{
  const r = await assessEvidence(stub(ev(0.1, 0.1)), { child: 'mason', section, rung, items });
  ok('clean evidence raises nothing', !r.weak && r.flags.length === 0);
}
{
  const r = await assessEvidence(stub(ev(0.8, 0.1)), { child: 'mason', section, rung, items });
  ok('a possible shortcut is flagged', r.weak && r.flags[0].key === 'shortcut_possible');
}
{
  const r = await assessEvidence(stub(ev(0.7, 0.9)), { child: 'mason', section, rung, items });
  ok('flags come out strongest first', r.flags.length === 2 && r.flags[0].key === 'answers_not_showing_skill');
}
{
  let threw = false;
  try { await assessEvidence(stub({}), { child: 'mason', section, rung, items }); } catch { threw = true; }
  ok('a broken reply throws rather than reading as clean', threw);
}

/* writing feedback */
{
  const f = writingFeedback({ ideas: 3, structure: 2, vocabulary: 1, accuracy: 2 });
  ok('feedback names the strongest and the weakest dimension',
    f.strongest === 'ideas' && f.next === 'vocabulary' && f.lines.length === 2);
  ok('the next step is the level above the current one', /Varied, with some well chosen words/.test(f.lines[1]));
  const top = writingFeedback({ ideas: 3, structure: 3, vocabulary: 3, accuracy: 3 });
  ok('a top level piece has no next step', top.next === null && /top level/.test(top.lines[1]));
}
{
  const sc = (n) => ({ score: n, confidence: 0.95 });
  const reply = { ideas: sc(2), structure: sc(2), vocabulary: sc(1), accuracy: sc(3), off_prompt: { noul: 0.02, confidence: 1 } };
  const r = await scoreWriting(stub(reply), { child: 'mason', prompt: 'p', genre: 'advice', text: 'some words here' });
  ok('scoreWriting returns the raw levels and feedback', r.levels.vocabulary === 1 && r.feedback.next === 'vocabulary');
}
{
  const wset = { weekNum: 1, sections: [{ id: '1D', subject: 'english', title: 'W', timerMins: 5, totalMarks: 4,
    questions: [{ id: '1D-Q1', text: 'brief', marks: 4, inputType: 'multiline', autoMark: false, markScheme: 'x' }] }] };
  const sc = (n) => ({ score: n, confidence: 0.95 });
  const reply = { essentially_correct: { noul: 1, confidence: 1 }, credit: { score: 3, confidence: 0.95 },
    ideas: sc(2), structure: sc(2), vocabulary: sc(1), accuracy: sc(3), off_prompt: { noul: 0.02, confidence: 1 } };
  const r = await markWeek('mason', wset, { '1D-Q1': 'a paragraph of advice' }, stub(reply));
  ok('the 1D mark still comes from its mark scheme', r.perQuestion['1D-Q1'].marks === 3);
  ok('the 1D task also returns writing feedback', r.writing && r.writing.feedback.lines.length === 2);
  const blank = await markWeek('mason', wset, {}, stub(reply));
  ok('a blank 1D gets no feedback call', blank.writing === null);
}

if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED:`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log(`${passed} jev helper tests passed`);

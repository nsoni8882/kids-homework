/* Renders the worksheet's results screen in node and asserts the numbers on it
 * ADD UP.
 *
 * It exists because of a real failure. Week 24 came back 37 of 55 and the
 * "where did the marks go" panel listed 6 marks' worth of wrong answers. The
 * other 12 were sitting on seven questions the server had referred to a grown
 * up: their mark is null, the total counted them as missing, and the panel
 * skipped them because it tested for a LOW mark rather than for no mark. A
 * drill slip was the same mistake the other way round, listed as a loss when
 * the band had already given the section full marks. Nothing threw. The page
 * looked designed and lied about the arithmetic.
 *
 * So the assertions here are arithmetic, not presence: the ledger's total has
 * to equal the gap between the score and the maximum, and the strands under it
 * have to sum to the total. There is no Chromium on this machine, so this stubs
 * the DOM calls worksheet.js makes and reads back the HTML.
 *
 *   node scripts/worksheet-check.mjs                      every fixture, then both live weeks
 *   node scripts/worksheet-check.mjs mason                 one child's live week
 *   node scripts/worksheet-check.mjs mason payload.json    one saved payload
 *
 * The fixtures matter more than the live run. A live week with nothing
 * referred exercises none of this, and a week cannot be put back into the
 * state that was reported, so scripts/fixtures/week-<child>-pending.json
 * holds it: Mason's week 24 exactly as it stood before anybody marked it, and
 * Elysia's week 21 with two answers forced back to undecided, one of them
 * inside the banded drill where an undecided item is worth nothing on its own.
 * worksheet.js keeps module state from the moment it is imported, so one
 * process checks one payload and the no-argument form re-runs itself per case.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const self = fileURLToPath(import.meta.url);

if (!process.argv[2]) {
  const fixtures = readdirSync(`${root}/scripts/fixtures`)
    .filter((f) => /^week-(mason|elysia)-.*\.json$/.test(f))
    .map((f) => [f.split('-')[1], `scripts/fixtures/${f}`]);
  const cases = [...fixtures, ['mason'], ['elysia']];
  let bad = 0;
  for (const [who, file] of cases) {
    const r = spawnSync(process.execPath, [self, who, ...(file ? [file] : [])],
      { stdio: 'inherit', cwd: root });
    if (r.status !== 0) bad += 1;
  }
  console.log(bad ? `${bad} of ${cases.length} case(s) FAILED` : `all ${cases.length} cases pass`);
  process.exit(bad ? 1 : 0);
}

const child = process.argv[2];
const payloadArg = process.argv[3];
const API = 'https://kids-homework-api.nikunj-sap.workers.dev';
const payload = payloadArg
  ? JSON.parse(readFileSync(payloadArg, 'utf8'))
  : await (await fetch(`${API}/api/week/${child}`)).json();

/* ------------------------------------------------------------ the stub DOM */

const listeners = new Map();   // selector -> handler, last render wins
const mkEl = (sel) => ({
  sel,
  dataset: Object.fromEntries([...String(sel).matchAll(/data-([a-z-]+)="([^"]*)"/g)]
    .map(([, k, v]) => [k.replace(/-([a-z])/g, (m, c) => c.toUpperCase()), v])),
  value: '', readOnly: false, style: {}, classList: { add() {}, remove() {} },
  addEventListener(ev, fn) { if (ev === 'click') listeners.set(sel, fn); },
  setAttribute() {}, getAttribute: () => null, focus() {},
});

const app = {
  innerHTML: '', scrollTop: 0,
  querySelector: (sel) => mkEl(sel),
  // the mark screen wires its buttons through querySelectorAll, so give it one
  // stub per data-award actually in the rendered HTML
  querySelectorAll(sel) {
    if (sel !== '[data-award]') return [];
    return [...this.innerHTML.matchAll(/data-award="(\d+)"/g)]
      .map(([, n]) => mkEl(`[data-award="${n}"]`));
  },
};

global.document = {
  documentElement: {
    attrs: {}, dataset: { child },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k] ?? null; },
    hasAttribute(k) { return k in this.attrs; },
    removeAttribute(k) { delete this.attrs[k]; },
  },
  getElementById: (id) => (id === 'app' ? app : null),
};
global.window = { scrollTo() {} };
global.location = { hostname: 'localhost', search: '', pathname: `/${child}/` };
global.matchMedia = () => ({ matches: true, addEventListener() {} });   // calm: no animation
global.localStorage = { getItem: () => null, setItem() {} };
global.performance = { now: () => Date.now() };
global.requestAnimationFrame = (fn) => fn(0);

let awardBody = null;
let awardResult = null;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.endsWith(`/api/week/${child}`)) return { ok: true, json: async () => payload };
  if (u.endsWith(`/api/week/${child}/award`)) {
    awardBody = JSON.parse(opts.body);
    // What the Worker does: rewrite those rows, then recompute every section
    // from the rows. A banded drill is recomputed from the COUNT CORRECT, not
    // by adding the award on, which is why this is modelled rather than
    // approximated: awarding a referred drill item can leave the section's
    // marks exactly where they were, and the page must agree with that.
    const marks = { ...payload.submitted.sectionMarks };
    for (const sec of payload.questions.sections) {
      const touched = sec.questions.some((q) => q.id in awardBody.awards);
      if (!touched) continue;
      if (sec.scoreBand) {
        const n = sec.questions.filter((q) => {
          if (!q.autoMark) return false;
          if (q.id in awardBody.awards) return awardBody.awards[q.id] > 0;
          const p = payload.submitted.perQuestion[q.id];
          return p && p.correct === 1;
        }).length;
        const rule = (sec.scoreBandRules || []).find(([lo, hi]) => n >= lo && n <= hi);
        marks[sec.id] = rule ? rule[2] : 0;
      } else {
        for (const [qid, m] of Object.entries(awardBody.awards)) {
          if (sec.questions.some((q) => q.id === qid)) marks[sec.id] += m;
        }
      }
    }
    const total = Object.values(marks).reduce((a, b) => a + b, 0);
    awardResult = { child, week: payload.week, total, outOf: payload.submitted.outOf, sectionMarks: marks };
    return { ok: true, json: async () => awardResult };
  }
  throw new Error(`unexpected fetch ${u}`);
};

const click = async (sel) => {
  const fn = listeners.get(sel);
  if (!fn) throw new Error(`nothing is listening on ${sel}\n${app.innerHTML.slice(0, 600)}`);
  listeners.clear();
  await fn();
  await new Promise((r) => setTimeout(r, 20));
};

await import(`${root}/assets/worksheet.js`);
await new Promise((r) => setTimeout(r, 400));

/* ------------------------------------------------------------- the asserts */

const fail = [];
const ok = (cond, msg) => { if (!cond) fail.push(msg); };
const marksOf = (s) => [...s.matchAll(/class="ledger-marks">(\d+) marks?</g)].map((m) => Number(m[1]));

ok(!payload.submitted === false, `${child} has not submitted the current week, nothing to check`);
if (!payload.submitted) {
  if (process.env.DUMP_HTML) writeFileSync(process.env.DUMP_HTML, app.innerHTML);
console.log(`${child} week ${payload.week} is not submitted, skipping`);
  process.exit(0);
}

const byId = {};
payload.questions.sections.forEach((s) => s.questions.forEach((q) => { byId[q.id] = { q, s }; }));
const pending = Object.entries(payload.submitted.perQuestion || {})
  .filter(([, p]) => p.marks === null).map(([qid]) => qid);

// 1. the welcome screen names the unmarked answers rather than hiding them
ok(app.innerHTML.includes('already submitted'), 'the welcome banner lost the submitted score');
if (pending.length) {
  ok(/answers? still to mark/.test(app.innerHTML),
    'the welcome screen does not say any answers are still to mark');
}

// 2. walk the review path to the results screen, which is what the parent saw
await click('[data-act="review"]');
for (let i = 0; i < payload.questions.sections.length; i += 1) await click('[data-nav="next"]');
const results = app.innerHTML;
if (process.env.DUMP_HTML) writeFileSync(`${process.env.DUMP_HTML}.pending`, results);
ok(results.includes('Where did the marks go?'), 'the results screen has no marks panel');

const missing = payload.submitted.outOf - payload.submitted.total;
const nums = marksOf(results);
ok(nums.length > 0, 'the ledger printed no numbers');
if (nums.length) {
  ok(nums[0] === missing,
    `the ledger says ${nums[0]} marks not collected, the score says ${missing}`);
  const strands = nums.length > 1 ? nums.slice(1).reduce((a, b) => a + b, 0) : nums[0];
  ok(strands === missing,
    `the ledger strands sum to ${strands}, which does not match the ${missing} missing`);
}
ok(!results.includes('not traced'), 'some marks could not be accounted for');
ok(new RegExp(`${payload.submitted.total} / ${payload.submitted.outOf}`).test(results),
  'the results screen does not show the saved total');

if (pending.length) {
  ok(results.includes('Nearly marked'),
    'an unfinished week is given a verdict as though it were marked');
  ok(!results.includes('confetti'), 'confetti over a week that is not marked yet');
  ok(results.includes('Waiting for a grown up'), 'the pending answers are not listed');
  pending.forEach((qid) => ok(results.includes(`${qid} ·`), `${qid} is waiting and is not listed`));
  // The marks at stake must not count a drill item, whose marks ride on the
  // band and are already in the band's own loss. Counting both was the
  // inverse of the bug this file exists for.
  const atStake = pending.reduce((t, qid) => t + (byId[qid].s.scoreBand ? 0 : byId[qid].q.marks), 0);
  ok(results.includes(`waiting on ${pending.length} ${pending.length === 1 ? 'answer' : 'answers'}`)
     || atStake === 0,
    'the ledger does not name the answers that are waiting');
  if (atStake) {
    ok(new RegExp(`${atStake} marks?</span>\\s*<span class="ledger-what">waiting`).test(results),
      `the marks at stake should be ${atStake}, which excludes anything inside a banded drill`);
  }

  // 3. a grown up can finish the marking from here, and the page then settles
  //    on what the server recomputed rather than its own running sum.
  await click('[data-act="mark-rest"]');
  let guard = 0;
  while (listeners.has('[data-nav="next"]') && guard < 40) {
    guard += 1;
    const shown = app.innerHTML;
    if (/Award marks out of/.test(shown)) {
      const m = shown.match(/Award marks out of (\d+)/);
      await click(`[data-award="${m[1]}"]`);          // full marks, to prove the arithmetic
    }
    await click('[data-nav="next"]');
    if (app.innerHTML.includes('Where did the marks go?') || !app.innerHTML.includes('Award marks')) break;
  }
  ok(awardBody !== null, 'finishing the marking sent nothing to the server');
  if (awardBody) {
    ok(Object.keys(awardBody.awards).length === pending.length,
      `sent ${Object.keys(awardBody.awards).length} awards for ${pending.length} referred answers`);
  }
  const after = app.innerHTML;
  // The server owns the total. The page must show what came back, not its own
  // running sum, which is the whole reason the award response is re-read.
  const expect = awardResult ? awardResult.total : payload.submitted.total;
  ok(new RegExp(`${expect} / ${payload.submitted.outOf}`).test(after),
    `the screen should read what the server returned, ${expect} / ${payload.submitted.outOf}`);
  // a referred item inside a banded drill is worth nothing on its own, so
  // awarding it must not move the total unless it moves the band
  const inBand = pending.filter((qid) => byId[qid].s.scoreBand);
  if (inBand.length) {
    ok(!new RegExp(`up to \\d+ marks? still to decide`).test(
      after.slice(after.indexOf(inBand[0])) || ''),
      'a drill item is still shown as waiting after it was marked');
  }
  const afterNums = marksOf(after);
  if (afterNums.length) {
    ok(afterNums[0] === payload.submitted.outOf - expect,
      `the ledger did not follow the new total: ${afterNums[0]} against ${payload.submitted.outOf - expect}`);
    ok((afterNums.length > 1 ? afterNums.slice(1).reduce((a, b) => a + b, 0) : afterNums[0]) === afterNums[0],
      'the ledger stopped adding up after the marking was finished');
  }
  ok(!after.includes('Waiting for a grown up'), 'a marked answer is still listed as waiting');
}

// 4. a wrong item inside a banded drill must not be reported as a lost mark
const band = payload.questions.sections.find((s) => s.scoreBand);
if (band && payload.submitted.sectionMarks[band.id] === band.totalMarks) {
  const slips = band.questions.filter((q) => {
    const p = payload.submitted.perQuestion[q.id];
    return p && p.marks === 0;
  });
  if (slips.length) {
    ok(results.includes('no mark lost'),
      'a wrong drill item is reported without saying the band still gave full marks');
  }
}

if (process.env.DUMP_HTML) writeFileSync(process.env.DUMP_HTML, app.innerHTML);
console.log(`${child} week ${payload.week}: ${payload.submitted.total}/${payload.submitted.outOf}, `
  + `${pending.length} referred, ledger ${nums.join(' + ')}`);
if (fail.length) {
  console.error(`FAIL\n${fail.map((f) => ` - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('worksheet results screen: PASS');

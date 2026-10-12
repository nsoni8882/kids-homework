/* Renders the dashboard the way a browser would, in node, and asserts the
 * panels actually SAY something.
 *
 * It exists because CLAUDE.md section 13 is right: init() paints every failure
 * into #error, so a page can look designed, throw nothing, and be empty. There
 * is no Chromium on this machine for a real headless pass, so this stubs the
 * handful of DOM calls dashboard.js makes, serves it the live /api/dashboard
 * payload, and then reads the HTML it produced.
 *
 *   node scripts/dashboard-check.mjs                  the live payload
 *   node scripts/dashboard-check.mjs path/to.json     a saved payload
 *   ROADMAP_PATCH=p.json node scripts/dashboard-check.mjs
 *
 * ROADMAP_PATCH replaces Mason's roadmap child record, which is how the states
 * the committed file cannot show are still covered: a level part cleared with
 * nothing current in it, and a mistyped track id.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const payloadArg = process.argv[2];
const API = 'https://kids-homework-api.nikunj-sap.workers.dev/api/dashboard';
const dash = payloadArg
  ? JSON.parse(readFileSync(payloadArg, 'utf8'))
  : await (await fetch(API)).json();

/* ------------------------------------------------------------ the stub DOM */

const els = new Map();
const mkEl = (id) => {
  const el = {
    id, hidden: false, innerHTML: '', tabIndex: 0, dataset: {}, attrs: {},
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, focus() {},
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k] ?? null; },
    hasAttribute(k) { return k in this.attrs; },
    removeAttribute(k) { delete this.attrs[k]; },
    querySelectorAll: () => [],
    getContext: () => ({}),
  };
  els.set(id, el);
  return el;
};
const tabs = ['mason', 'elysia', 'roadmap'].map((t) => {
  const el = mkEl(`tab-${t}`);
  el.dataset.tab = t;
  if (t !== 'roadmap') el.dataset.kid = t;
  return el;
});
['loading', 'error', 'app', 'panel-mason', 'panel-elysia', 'panel-roadmap'].forEach(mkEl);

global.document = {
  documentElement: {
    dataset: {}, attrs: {}, style: { setProperty() {} },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k] ?? null; },
    hasAttribute(k) { return k in this.attrs; },
    removeAttribute(k) { delete this.attrs[k]; },
  },
  getElementById: (id) => els.get(id) || mkEl(id),
  querySelectorAll: (sel) => (sel.includes('role="tab"') ? tabs : []),
  addEventListener() {},
};
global.location = { hostname: 'localhost', search: '', pathname: '/' };
global.matchMedia = () => ({ matches: false, addEventListener() {} });
global.localStorage = { getItem: () => null, setItem() {} };
global.getComputedStyle = () => ({ getPropertyValue: () => '#000000' });
// Chart.js is a script tag in the real page. Nothing here reads a chart back.
global.Chart = class { destroy() {} update() {} };
global.fetch = async (url) => {
  const u = String(url);
  if (u.endsWith('/api/dashboard')) return { ok: true, json: async () => dash };
  const file = u.startsWith('file:') ? fileURLToPath(u) : u;
  const body = JSON.parse(readFileSync(file, 'utf8'));
  if (file.endsWith('roadmap.json') && process.env.ROADMAP_PATCH) {
    body.children.mason = JSON.parse(readFileSync(process.env.ROADMAP_PATCH, 'utf8'));
  }
  return { ok: true, json: async () => body };
};

await import(`${root}/assets/dashboard.js`);
await new Promise((r) => setTimeout(r, 300));

/* ------------------------------------------------------------- the asserts */

const fail = [];
const ok = (cond, msg) => { if (!cond) fail.push(msg); };
const patched = Boolean(process.env.ROADMAP_PATCH);
const err = els.get('error');
const html = els.get('panel-roadmap').innerHTML;
const mason = els.get('panel-mason').innerHTML;

// every element in the stub starts visible, so an empty card is the real test
ok(err.hidden || !err.innerHTML, `the error card is showing: ${err.innerHTML.slice(0, 400)}`);
ok(html.length > 2000, `the roadmap panel is thin (${html.length} chars)`);
for (const name of ['Mason', 'Elysia', 'Maths', 'English', 'Level 7A', 'Level A', 'Level C',
  'Level D', 'Level E', 'Level O', 'X levels', 'Level L', 'Pythagoras',
  'Differential equations', 'XS Statistics', 'Critique stage']) {
  ok(html.includes(name), `the roadmap panel is missing "${name}"`);
}

// one fold per Kumon level plus one per test component, for both children:
// (22 maths + 18 English + 4 NSW components) x 2
const folds = (html.match(/<details class="rm-sec"/g) || []).length;
ok(folds === (patched ? 84 : 88),
  `expected ${patched ? 84 : 88} folds, got ${folds}`);
// a child record with no exam block, as the fixture has, must still render
ok(!html.includes('undefined'), 'something rendered as "undefined"');
const open = (html.match(/<details class="rm-sec" open>/g) || []).length;
const shut = (html.match(/<details class="rm-sec">/g) || []).length;
ok(shut > open, `expected most levels folded, got ${shut} shut against ${open} open`);
ok(html.includes('Now on'), 'no "Now on" line per track');
ok(html.includes('kl-why'), 'no evidence line on a current sub-topic');
// the per child accent wash belongs to theme.css, which designs both modes
ok(!html.includes('--accent-wash'), 'the accent wash is inlined, so dark mode loses its tint');

if (!patched) {
  // the placement test is the target, so it leads and its components stay open
  for (const name of ['NSW placement test', 'Selective High School Placement Test',
    'Opportunity Class Placement Test', 'Mathematical Reasoning', 'Thinking Skills',
    'Normanhurst Boys', 'Hornsby Girls', 'Vocabulary in context', 'Missing sentences',
    'Strengthen an argument', 'Spot the mistake in reasoning', 'Writing to a brief',
    'Covered and evidenced', 'Not started yet']) {
    ok(html.includes(name), `the roadmap panel is missing "${name}"`);
  }
  ok(html.indexOf('NSW placement test') < html.indexOf('Maths'),
    'the Kumon ladder is shown above the placement test it serves');
  // The per component tally, and these numbers used to be wrong in a way worth
  // recording. They asserted Thinking Skills at 9 of 10 and Writing at 5 of 5
  // for Mason, because the roadmap's `current` map had been written as where
  // each slot is HEADING. Under a label that reads "in the weekly homework
  // now", that reported work that was not happening: slot 1D did not exist
  // until week 25 and he had never typed a response, yet all five writing
  // families were claimed. The map is now derived from the live rung, so a
  // component counts a family only once the child's recorded rung delivers it.
  ok(/Thinking Skills\s+2 of 10/.test(html),
    "Mason's Thinking Skills component does not show 2 of 10, the two re-pointed rungs he is on");
  // Mason's slot 1D opened at week 25, so his Writing is 2 of 5 from 12 Oct
  // 2026: rung 1D.1 delivers W-brief and W-type and nothing above them yet.
  // Elysia has no 1D until September 2029, so hers must still read 0 of 5.
  // Asserting a flat 0 of 5 for both was right the day it was written and
  // became wrong the moment the slot opened, which is the point of checking a
  // number rather than a shape.
  ok(/Writing\s+2 of 5/.test(html),
    "Mason's Writing component does not show 2 of 5, which rung 1D.1 delivers");
  ok((html.match(/Writing\s+0 of 5/g) || []).length === 1,
    'Elysia should still be 0 of 5 on Writing: she has no slot 1D until September 2029');
  ok((html.match(/Reading\s+0 of 5/g) || []).length === 2,
    'Reading should be 0 of 5 for both children, several rungs below every item type');
  ok(/Mathematical Reasoning\s+3 of 12/.test(html),
    "Mason's Mathematical Reasoning component does not show 3 of 12");
  ok(/Mathematical Reasoning\s+2 of 12/.test(html),
    "Elysia's Mathematical Reasoning component does not show 2 of 12");
  // a component with nothing in the week is flagged, and Elysia's Writing is one
  ok((html.match(/rm-cover-none/g) || []).length >= 1,
    'a component with nothing in the week is not flagged');
  ok(html.includes('Nothing in the week covers this yet'),
    'a test component with no coverage is not called out');
  ok(html.includes('>Not started<'),
    'an untouched test component is not badged "Not started"');
  ok(open === 13, `expected 5 Kumon levels and 8 test components open, got ${open}`);
  const current = (html.match(/kl kl-current/g) || []).length;
  ok(current === 18, `expected 18 current sub-topics (7 Kumon, 11 test), got ${current}`);
} else {
  // a level part cleared with nothing current in it must not read "To come"
  const c = html.slice(html.indexOf('>Level C<'), html.indexOf('>Level D<'));
  ok(c.includes('Part cleared') && !c.includes('To come'),
    'a part cleared level is still badged as untouched');
  // a prose sub-topic name does not carry its level, so the line must add it
  ok(html.includes('E Equivalent fractions'),
    'a prose sub-topic lost its level in the "Now on" line');
  // a mistyped track id must say so rather than drop a column silently
  ok(html.includes('is missing from roadmap.json'), 'a bad track id renders silently');
  ok(open === 9, `expected 4 Kumon levels and 4 test components open, got ${open}`);
}

// the child tabs keep the mastery ladder and no longer carry the Kumon card
ok(mason.includes('Where they are on the pathway'), "a child panel lost its ladder");
ok(!mason.includes('Level roadmap'), 'the old Kumon card is still in a child panel');

if (process.env.DUMP_HTML) writeFileSync(process.env.DUMP_HTML, html);
console.log(`roadmap panel ${html.length} chars, ${folds} level folds, ${open} open`);
if (fail.length) {
  console.error(`FAIL\n${fail.map((f) => ` - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(`dashboard renders${patched ? ' (patched roadmap)' : ''}: ${fail.length === 0 ? 'PASS' : ''}`);

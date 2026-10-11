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
import { readFileSync } from 'node:fs';
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

// one fold per Kumon level, for both children: 22 maths + 18 English, twice
const folds = (html.match(/<details class="rm-sec"/g) || []).length;
ok(folds === 80, `expected 80 level folds (22 maths + 18 English per child), got ${folds}`);
const open = (html.match(/<details class="rm-sec" open>/g) || []).length;
const shut = (html.match(/<details class="rm-sec">/g) || []).length;
ok(shut > open, `expected most levels folded, got ${shut} shut against ${open} open`);
ok(html.includes('Now on'), 'no "Now on" line per track');
ok(html.includes('kl-why'), 'no evidence line on a current sub-topic');
// the per child accent wash belongs to theme.css, which designs both modes
ok(!html.includes('--accent-wash'), 'the accent wash is inlined, so dark mode loses its tint');

if (!patched) {
  ok(open === 5, `expected the 5 levels in progress to be open, got ${open}`);
  const current = (html.match(/kl kl-current/g) || []).length;
  ok(current === 7, `expected 7 current sub-topics, got ${current}`);
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
}

// the child tabs keep the mastery ladder and no longer carry the Kumon card
ok(mason.includes('Where they are on the pathway'), "a child panel lost its ladder");
ok(!mason.includes('Level roadmap'), 'the old Kumon card is still in a child panel');

console.log(`roadmap panel ${html.length} chars, ${folds} level folds, ${open} open`);
if (fail.length) {
  console.error(`FAIL\n${fail.map((f) => ` - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(`dashboard renders${patched ? ' (patched roadmap)' : ''}: ${fail.length === 0 ? 'PASS' : ''}`);

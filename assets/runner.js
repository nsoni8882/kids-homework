/* The two run buttons at the top of the dashboard.
 *
 * The page cannot start a skill itself. It asks the Worker to queue one, and
 * scripts/runner.mjs on the Mac picks it up, runs Claude Code and writes the
 * report back. Queuing needs the run code, typed once and kept in this browser
 * only: it is a Worker secret, never in a committed file.
 *
 * Kept out of dashboard.js on purpose: the tracker renders from one payload and
 * this panel polls its own, so neither can break the other.
 */

import { API } from './config.js';
import { icon } from './icons.js';

const CODE_KEY = 'kh-run-code';
const POLL_MS = 15_000;
const ALIVE_MS = 90_000;   // the helper polls every 30s, so 90s silent means asleep or off
const KIND = { score: 'Score', homework: 'Weekly cycle' };
const STATUS = {
  queued: { label: 'Waiting for the Mac', cls: 'badge-info', icon: 'clock' },
  running: { label: 'Running', cls: 'badge-warn', icon: 'refresh' },
  done: { label: 'Done', cls: 'badge-ok', icon: 'checkCircle' },
  failed: { label: 'Failed', cls: 'badge-bad', icon: 'alert' },
};

const root = document.getElementById('run-panel');
const getCode = () => { try { return localStorage.getItem(CODE_KEY) || ''; } catch { return ''; } };
const setCode = (v) => { try { if (v) localStorage.setItem(CODE_KEY, v); else localStorage.removeItem(CODE_KEY); } catch { /* private window */ } };

let state = null;
let armed = null;        // the kind waiting for its second tap
let armTimer = null;
let message = '';

const when = (iso) => {
  const d = new Date(iso);
  const t = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? t
    : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${t}`;
};
const mins = (a, b) => Math.max(1, Math.round((new Date(b) - new Date(a)) / 60_000));

function render() {
  const jobs = state ? state.jobs : [];
  const last = jobs[0];
  const busy = last && (last.status === 'queued' || last.status === 'running');
  const alive = state && state.runnerSeenAt && Date.now() - new Date(state.runnerSeenAt) < ALIVE_MS;
  const helper = !state ? ''
    : alive ? `<span class="badge badge-ok">${icon('checkCircle')}Mac helper on</span>`
    : `<span class="badge badge-neutral">${icon('clock')}Mac helper off${state.runnerSeenAt ? `, last seen ${when(state.runnerSeenAt)}` : ''}</span>`;

  const button = (kind, cls, ico, label) => {
    const isArmed = armed === kind;
    return `<button class="btn ${cls}" type="button" data-run="${kind}" ${busy ? 'disabled' : ''}>
      ${icon(isArmed ? 'check' : ico)}${isArmed ? 'Tap again to start' : label}</button>`;
  };

  let lastHtml = '';
  if (last) {
    const s = STATUS[last.status];
    const timing = last.finished_at ? `asked ${when(last.requested_at)}, took ${mins(last.started_at || last.requested_at, last.finished_at)} min`
      : last.started_at ? `started ${when(last.started_at)}`
      : `asked ${when(last.requested_at)}${alive ? '' : ', it starts when the Mac is awake'}`;
    lastHtml = `<div class="run-last">
      <div class="row"><span class="badge ${s.cls}">${icon(s.icon)}${s.label}</span>
        <span class="run-meta">${KIND[last.kind]}, ${timing}</span></div>
      ${last.report ? `<details class="run-details"><summary>Read the report</summary><pre class="run-report"></pre></details>` : ''}
    </div>`;
  }

  /* The panel refreshes every 15 seconds. Rebuilding all of it would wipe a
     half typed run code and snap shut a report being read, so the code field is
     built once and each part is only redrawn when what it shows has changed. */
  part('top', `
    <div class="run-head"><h2 class="run-title">Run the weekly work</h2>${helper}</div>
    <p class="card-note">Score marks the latest submitted week and writes the reason behind each wrong answer.
      The weekly cycle does that, updates the gaps and builds next week. Both run on the Mac and take a few minutes.</p>
    <div class="row">
      ${button('score', 'btn-primary', 'clipboard', 'Score the latest week')}
      ${button('homework', 'btn-secondary', 'layers', 'Run the weekly cycle')}
    </div>`);
  root.querySelector('.run-code').hidden = Boolean(getCode());
  part('bottom', `<p class="run-msg" role="status" aria-live="polite">${message}</p>${lastHtml}`, () => {
    const pre = root.querySelector('.run-report');
    if (pre) pre.textContent = last.report;   // the report is text, never markup
  });
}

function part(name, html, after) {
  const el = root.querySelector(`[data-part="${name}"]`);
  if (el.dataset.html === html) return;
  el.dataset.html = html;
  el.innerHTML = html;
  if (after) after();
}

async function load() {
  try {
    const res = await fetch(`${API}/api/jobs`);
    if (res.ok) state = await res.json();
  } catch { /* offline: keep what is on screen */ }
  render();
}

async function start(kind) {
  const typed = root.querySelector('#run-code');
  const code = getCode() || (typed ? typed.value.trim() : '');
  if (!code) { message = 'Type the run code first.'; render(); return; }
  message = 'Asking the Mac';
  render();
  let res;
  let body = {};
  try {
    res = await fetch(`${API}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${code}` },
      body: JSON.stringify({ kind }),
    });
    body = await res.json().catch(() => ({}));
  } catch {
    message = 'Could not reach the homework server. Check the connection and try again.';
    render();
    return;
  }
  if (res.status === 401) setCode('');
  else if (res.ok || res.status === 409) setCode(code);
  if (res.ok) { state = body; message = ''; } else message = body.error || `HTTP ${res.status}`;
  render();
}

root.addEventListener('click', (e) => {
  const b = e.target.closest('[data-run]');
  if (!b || b.disabled) return;
  const kind = b.dataset.run;
  clearTimeout(armTimer);
  if (armed !== kind) {
    // one tap arms, a second within five seconds starts: a stray tap costs nothing
    armed = kind;
    armTimer = setTimeout(() => { armed = null; render(); }, 5000);
    render();
    return;
  }
  armed = null;
  start(kind);
});

root.innerHTML = `<div class="run-part" data-part="top"></div>
  <label class="run-code"><span>Run code</span>
    <input class="input" id="run-code" type="password" autocomplete="off" spellcheck="false"></label>
  <div class="run-part" data-part="bottom"></div>`;
root.hidden = false;
render();
load();
setInterval(() => { if (!document.hidden) load(); }, POLL_MS);

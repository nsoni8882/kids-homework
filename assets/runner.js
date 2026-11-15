/* The Run tab.
 *
 * The page cannot start a skill itself. It asks the Worker to queue one, and
 * scripts/runner.mjs on the Mac picks it up, runs Claude Code and writes the
 * steps and the final report back. This tab shows that, nothing else.
 *
 * Kept out of dashboard.js on purpose: the tracker renders from one payload and
 * this panel polls its own, so neither can break the other.
 */

import { API } from './config.js';
import { icon } from './icons.js';

const SLOW_MS = 15_000;    // nothing running
const FAST_MS = 3_000;     // a run is waiting or in progress
const ALIVE_MS = 90_000;   // the helper polls every 30s, so 90s silent means asleep or off
const KIND = { score: 'Score', homework: 'Weekly cycle' };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// an automatic run says which child and week it is scoring and why it started
const label = (j) => (j.child_id ? `${KIND[j.kind]}, ${cap(j.child_id)} week ${j.week}${j.auto ? ', automatic' : ''}` : KIND[j.kind]);
const STATUS = {
  queued: { label: 'Waiting for the Mac', cls: 'badge-info', icon: 'clock' },
  running: { label: 'Running', cls: 'badge-warn', icon: 'refresh' },
  done: { label: 'Done', cls: 'badge-ok', icon: 'checkCircle' },
  failed: { label: 'Failed', cls: 'badge-bad', icon: 'alert' },
};

const root = document.getElementById('panel-run');
const tab = document.getElementById('tab-run');

let state = null;
let armed = null;        // the kind waiting for its second tap
let armTimer = null;
let message = '';
let openReport = null;   // job id whose report is expanded
let timer = null;
let clock = null;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const when = (iso) => {
  const d = new Date(iso);
  const t = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? t
    : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${t}`;
};
const mins = (a, b) => Math.max(1, Math.round((new Date(b) - new Date(a)) / 60_000));
const clockText = (from) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(from)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const steps = (job) => { try { return JSON.parse(job.progress) || []; } catch { return []; } };
const isBusy = (j) => j && (j.status === 'queued' || j.status === 'running');

function activeHtml(job, alive) {
  const s = STATUS[job.status];
  const list = steps(job);
  const from = job.started_at || job.requested_at;
  const lead = job.status === 'queued'
    ? (alive ? 'Waiting for the Mac to pick it up' : 'The Mac helper is off, so this starts when the Mac is awake')
    : 'Working';
  return `<div class="run-active">
    <div class="row"><span class="run-spinner" aria-hidden="true"></span>
      <strong>${esc(label(job))}</strong><span class="badge ${s.cls}">${icon(s.icon)}${s.label}</span>
      <span class="run-clock" data-from="${esc(from)}">${clockText(from)}</span></div>
    <p class="run-meta">${lead}</p>
    ${list.length ? `<ol class="run-steps">${list.map((x) => {
      const st = x.percent >= 100 ? 'done' : '';
      return `<li class="${st}">${x.percent >= 100 ? icon('checkCircle') : '<span class="run-bullet" aria-hidden="true"></span>'}${esc(x.task)}</li>`;
    }).join('')}</ol>` : ''}
  </div>`;
}

function historyHtml(jobs) {
  if (!jobs.length) return '<p class="card-note">Nothing has been run yet.</p>';
  return jobs.map((j) => {
    const s = STATUS[j.status];
    const took = j.finished_at ? `, took ${mins(j.started_at || j.requested_at, j.finished_at)} min` : '';
    return `<details class="run-job" data-job="${j.id}" ${openReport === j.id ? 'open' : ''}>
      <summary><span class="badge ${s.cls}">${icon(s.icon)}${s.label}</span>
        <span>${esc(label(j))}</span><span class="run-meta">${when(j.requested_at)}${took}</span></summary>
      <pre class="run-report"></pre></details>`;
  }).join('');
}

function part(name, html, after) {
  const el = root.querySelector(`[data-part="${name}"]`);
  if (el.dataset.html === html) return;
  el.dataset.html = html;
  el.innerHTML = html;
  if (after) after();
}

function render() {
  const jobs = state ? state.jobs : [];
  const live = jobs.find(isBusy);
  const alive = state && state.runnerSeenAt && Date.now() - new Date(state.runnerSeenAt) < ALIVE_MS;
  tab.classList.toggle('is-running', Boolean(live));

  const helper = !state ? ''
    : alive ? `<span class="badge badge-ok">${icon('checkCircle')}Mac helper on</span>`
    : `<span class="badge badge-neutral">${icon('clock')}Mac helper off${state.runnerSeenAt ? `, last seen ${when(state.runnerSeenAt)}` : ''}</span>`;
  const button = (kind, cls, ico, label) => `<button class="btn ${cls}" type="button" data-run="${kind}" ${live ? 'disabled' : ''}>
    ${icon(armed === kind ? 'check' : ico)}${armed === kind ? 'Tap again to start' : label}</button>`;

  part('top', `
    <div class="run-head"><h2 class="run-title">Run the weekly work</h2>${helper}</div>
    <p class="card-note">Score marks the latest submitted week and writes the reason behind each wrong answer.
      The weekly cycle does that, updates the gaps and builds next week. Both run on the Mac and take a few minutes.
      Scoring also starts by itself once a child has submitted and every question the Mac could not mark has been marked by you.</p>
    <div class="row">
      ${button('score', 'btn-primary', 'clipboard', 'Score the latest week')}
      ${button('homework', 'btn-secondary', 'layers', 'Run the weekly cycle')}
    </div>
    <p class="run-msg" role="status" aria-live="polite">${esc(message)}</p>`);
  part('active', live ? activeHtml(live, alive) : '');
  part('history', historyHtml(jobs), () => {
    // the report is text, never markup
    root.querySelectorAll('.run-job').forEach((d) => {
      const j = jobs.find((x) => String(x.id) === d.dataset.job);
      d.querySelector('.run-report').textContent = j.report || (isBusy(j) ? 'No report yet.' : 'No report was written.');
      d.addEventListener('toggle', () => { openReport = d.open ? j.id : (openReport === j.id ? null : openReport); });
    });
  });
}

async function load() {
  clearTimeout(timer);
  try {
    const res = await fetch(`${API}/api/jobs`);
    if (res.ok) state = await res.json();
  } catch { /* offline: keep what is on screen */ }
  render();
  timer = setTimeout(load, state && state.jobs.some(isBusy) ? FAST_MS : SLOW_MS);
}

async function start(kind) {
  message = 'Asking the Mac';
  render();
  let res;
  let body = {};
  try {
    res = await fetch(`${API}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind }),
    });
    body = await res.json().catch(() => ({}));
  } catch {
    message = 'Could not reach the homework server. Check the connection and try again.';
    render();
    return;
  }
  if (res.ok) { state = body; message = ''; } else message = body.error || `HTTP ${res.status}`;
  render();
  load();
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

root.innerHTML = `<div class="card run-panel">
  <div class="run-part" data-part="top"></div>
  <div class="run-part" data-part="active"></div>
</div>
<h3 class="section-label">Recent runs</h3>
<div class="card run-history" data-part="history"></div>`;

// the clock ticks every second without redrawing anything else
clock = setInterval(() => {
  root.querySelectorAll('.run-clock').forEach((el) => { el.textContent = clockText(el.dataset.from); });
}, 1000);

render();
load();
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

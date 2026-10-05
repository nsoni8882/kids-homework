/* Parent dashboard.
 *
 * It answers two questions, in this order:
 *   1. How did this week go?        the hero line, one sentence, no scrolling
 *   2. Are they moving forward?     the mastery ladder, not the score
 *
 * Everything else is detail behind that. The long marking notes are kept, but
 * they are the last thing on the page rather than the first, because a
 * paragraph of prose is not a dashboard.
 *
 * One request fetches every week for both children. The old two bin split, and
 * the lazy "load the archive" panels it forced, existed only because a bin was
 * capped at 100KB. The database has no such cap.
 */

import { CHILDREN } from './config.js';
import { apiDashboard } from './store.js';
import { icon, iconLabelled, SUBJECT_ICON } from './icons.js';
import { trendChart, subjectChart, lossChart, sparkline,
  SUBJECTS, SUBJECT_LABEL } from './charts.js';

const KIDS = ['mason', 'elysia'];
const MAX = {
  mason: { english: 20, maths: 20, thinking: 15, total: 55 },
  elysia: { english: 15, maths: 15, thinking: 10, total: 40 },
};
const GAP_STATUS = {
  new: { label: 'New', cls: 'badge-bad', icon: 'alert' },
  persists: { label: 'Persists', cls: 'badge-warn', icon: 'alert' },
  improving: { label: 'Improving', cls: 'badge-info', icon: 'trend' },
  resolved: { label: 'Resolved', cls: 'badge-ok', icon: 'checkCircle' },
  parked: { label: 'Parked', cls: 'badge-neutral', icon: 'clock' },
};
const VERDICT = {
  strong: { label: 'Strong week', icon: 'award' },
  steady: { label: 'Steady', icon: 'flat' },
  dip: { label: 'Dipped', icon: 'trendDown' },
  concern: { label: 'Needs attention', icon: 'alert' },
};

const charts = {};
const focus = {};   // child -> the focused subject, or null
let live = null;      // the API payload, keyed by child
let roadmap = null;
let spine = null;

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const $ = (id) => document.getElementById(id);
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);

/* ------------------------------------------------------------------ theme */

const THEME_KEY = 'kh-theme';
const isDark = () => {
  const set = document.documentElement.getAttribute('data-theme');
  return set ? set === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
};

function applyTheme(mode) {
  if (mode === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
  const btn = $('theme-btn');
  if (btn) {
    btn.innerHTML = icon(isDark() ? 'sun' : 'moon');
    btn.setAttribute('aria-label', isDark() ? 'Switch to light mode' : 'Switch to dark mode');
  }
}

function initTheme() {
  let saved = 'system';
  try { saved = localStorage.getItem(THEME_KEY) || 'system'; } catch { /* blocked */ }
  applyTheme(saved);
  $('theme-btn').addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, next); } catch { /* blocked */ }
    applyTheme(next);
    redrawAll();   // charts bake the theme colours in at construction
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!document.documentElement.hasAttribute('data-theme')) { applyTheme('system'); redrawAll(); }
  });
}

/* ------------------------------------------------------------------- data */

/** Normalise one week from the API into the shape the UI uses. */
function norm(kid, raw) {
  const max = MAX[kid];
  const sm = raw.sectionMarks || {};
  const has = Object.keys(sm).length > 0;
  const sum = (...ids) => ids.reduce((t, id) => t + (sm[id] || 0), 0);
  const outOf = raw.outOf || max.total;
  const total = raw.total;
  return {
    week: raw.week,
    total,
    outOf,
    // null, not 0, where a week has no section marks: the chart then leaves a
    // gap rather than drawing a misleading zero
    english: has ? sum('1A', '1B', '1C') : null,
    maths: has ? sum('2A', '2B', '2C') : null,
    thinking: has ? sum('3A', '3B', '3C') : null,
    englishMax: max.english,
    mathsMax: max.maths,
    thinkingMax: max.thinking,
    sectionMarks: sm,
    summary: raw.summary || '',
    verdict: raw.verdict || null,
    wins: raw.wins || [],
    errors: raw.errors || [],
    design: raw.designIssues || [],
    hintedSections: raw.hintedSections || [],
    notes: raw.notes || '',
    submittedAt: raw.submittedAt || null,
    // A week is re-markable when its per question answers were kept, which is
    // what section marks being present indicates. submittedAt is NOT the test:
    // the weeks carried over from the old archive format have none, and using
    // it hid nine real weeks per child from this count.
    hasAnswers: has,
    lost: Math.max(0, outOf - total),
  };
}

async function init() {
  try {
    const [liveData, roadmapData, spineData] = await Promise.all([
      apiDashboard(),
      fetch(new URL('./roadmap.json', import.meta.url)).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(new URL('../curriculum/spine.json', import.meta.url)).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    live = liveData; roadmap = roadmapData; spine = spineData;
    $('loading').hidden = true;
    $('app').hidden = false;
    KIDS.forEach(renderKid);
    initTabs();
  } catch (err) {
    $('loading').hidden = true;
    const box = $('error');
    box.hidden = false;
    box.innerHTML = `<div class="error-card">${iconLabelled('alert', 'Error', 'i i-lg')}
      <h2>Could not load the tracker</h2><p>${esc(err.message)}</p>
      <button class="btn btn-secondary" onclick="location.reload()">${icon('refresh')} Try again</button></div>`;
  }
}

/* ------------------------------------------------------------------- tabs */

function initTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const show = (kid) => {
    tabs.forEach((t) => {
      const on = t.dataset.kid === kid;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      t.style.setProperty('--tab-ink', `var(--child-${t.dataset.kid})`);
    });
    KIDS.forEach((k) => { $(`panel-${k}`).hidden = k !== kid; });
    document.documentElement.dataset.child = kid;
    drawCharts(kid);
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => show(t.dataset.kid));
    t.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const n = tabs[(i + d + tabs.length) % tabs.length];
      n.focus(); show(n.dataset.kid);
    });
  });
  show('mason');
}

const visibleKid = () => (KIDS.find((k) => !$(`panel-${k}`).hidden) || 'mason');
function redrawAll() { if (live) drawCharts(visibleKid()); }

/* -------------------------------------------------------------- rendering */

/** The charts show the recent run; the full history panel shows everything. */
function weeksFor(kid, all = false) {
  const list = (live[kid].weeks || []).filter((w) => w.total != null).map((w) => norm(kid, w));
  return all ? list : list.slice(-8);
}

function renderKid(kid) {
  const data = live[kid] || {};
  if (!data.weeks || !data.weeks.filter((w) => w.total != null).length) {
    $(`panel-${kid}`).innerHTML = `<div class="card"><div class="empty">${icon('inbox', 'i i-lg')}
      <h2>No weeks recorded yet</h2><p>The first submitted worksheet shows up here.</p></div></div>`;
    return;
  }
  const weeks = weeksFor(kid);
  const w = weeks[weeks.length - 1];
  const prev = weeks.length > 1 ? weeks[weeks.length - 2] : null;
  const gaps = (data.gaps || []).filter((g) => g.status !== 'resolved');

  $(`panel-${kid}`).innerHTML = `
    <h1 class="sr-only">${CHILDREN[kid].name}'s progress</h1>
    ${heroHtml(kid, w, prev)}
    ${kpiHtml(kid, weeks, gaps)}
    ${decisionsHtml(kid, w, gaps, data)}

    <h2 class="section-label">Performance</h2>
    <div class="grid grid-2">
      ${chartCard(`${kid}-trend`, 'trend', 'Accuracy over time',
        `last ${weeks.length} weeks`, trendTable(kid, weeks))}
      ${chartCard(`${kid}-subject`, 'target', 'By subject', '', subjectTable(kid, weeks),
        subjectLegend(kid))}
    </div>
    <section class="card">
      <div class="chart-head">${icon('search')}<h2>Where the marks went</h2></div>
      <p class="card-note" style="margin-bottom:var(--s3)">Marks lost each week, by subject.</p>
      <div class="chart-box" style="height:200px"><canvas id="${kid}-loss-chart"></canvas></div>
      <div class="legend" role="group" aria-label="Focus one subject">
        ${SUBJECTS.map((s) => `<button type="button" class="legend-btn" data-focus="${s}"
          data-kid="${kid}" aria-pressed="false">
          <span class="legend-swatch" style="background:var(--series-${s})"></span>
          ${SUBJECT_LABEL[s]}</button>`).join('')}
        <span class="legend-hint" id="${kid}-focus-hint-loss">Tap a subject to focus it</span>
      </div>
      <p class="card-note" style="margin-top:var(--s3)">
        Week ${w.week} lost ${w.lost} mark${w.lost === 1 ? '' : 's'}.
        ${w.errors.length} were logged as real errors and ${w.design.length} as question faults,
        which are mine to fix rather than theirs. Those are counts of issues, not of marks: one
        issue can cost two marks, or none at all inside a drill band.</p>
    </section>

    <h2 class="section-label">Mastery</h2>
    <section class="card">
      <div class="chart-head">${icon('layers')}<h2>Where they are on the pathway</h2></div>
      <p class="card-note" style="margin-bottom:var(--s4)">Nine slots, each with a ladder of skills.
        A filled bar is a rung cleared, the ringed one is where they are now.</p>
      ${ladderHtml(kid, data)}
    </section>

    <h2 class="section-label">Learning gaps</h2>
    <section class="card">
      <div class="chart-head">${icon('history')}<h2>Gap history</h2>
        <span class="pill">${gaps.length} open</span></div>
      ${heatHtml(gaps)}
      ${resolvedHtml(kid, data)}
    </section>

    <h2 class="section-label">This week in detail</h2>
    ${detailHtml(w)}

    <h2 class="section-label">History</h2>
    <section class="card">
      <div class="chart-head">${icon('history')}<h2>Every week on record</h2></div>
      <p class="card-note">The charts above show the last ${weeks.length} weeks. This is all of them.</p>
      ${historyHtml(kid)}
    </section>

    <h2 class="section-label">Kumon curriculum</h2>
    <section class="card">
      <details class="disclose" style="border-top:0;margin-top:0;padding-top:0">
        <summary>${icon('chevronRight', 'i i-sm chev')} Level roadmap</summary>
        <div style="margin-top:var(--s4)">${roadmapHtml(kid)}</div>
      </details>
    </section>`;

  wireCard(`${kid}-trend`);
  wireCard(`${kid}-subject`);
  wireLegends(kid);
  // The history chart is only built when its panel is first opened, because a
  // Chart.js canvas inside a closed <details> has no size to lay out against.
  $(`${kid}-history`).addEventListener('toggle', function once() {
    this.removeEventListener('toggle', once);
    drawHistoryChart(kid);
  });
}

/* -------------------------------------------------------------- the hero */

function heroHtml(kid, w, prev) {
  const p = pct(w.total, w.outOf);
  const v = VERDICT[w.verdict] || null;
  const delta = prev ? w.total - prev.total : null;
  const deltaCls = delta == null ? 'trend-flat' : delta > 0 ? 'trend-up' : delta < 0 ? 'trend-down' : 'trend-flat';
  const deltaIcon = delta == null ? 'flat' : delta > 0 ? 'trend' : delta < 0 ? 'trendDown' : 'flat';
  const deltaText = delta == null ? 'first week recorded'
    : delta === 0 ? `level with week ${prev.week}`
    : `${delta > 0 ? 'up' : 'down'} ${Math.abs(delta)} on week ${prev.week}`;

  const tags = SUBJECTS.map((s) => `
    <span class="pill"><span style="color:var(--${s})">${icon(SUBJECT_ICON[s], 'i i-sm')}</span>
      ${SUBJECT_LABEL[s]} ${w[s] == null ? '-' : `${w[s]}/${w[`${s}Max`]}`}</span>`).join('');

  return `<section class="hero">
    <div class="hero-top">
      <div class="hero-score">${w.total}<small> / ${w.outOf}</small></div>
      <div class="hero-meta">
        <div class="hero-week">Week ${w.week} &middot; ${p}%</div>
        <div class="hero-delta ${deltaCls}">${icon(deltaIcon, 'i i-sm')} ${deltaText}</div>
      </div>
      ${v ? `<span class="verdict verdict-${w.verdict}" style="margin-left:auto">
        ${icon(v.icon)} ${v.label}</span>` : ''}
    </div>
    ${w.summary ? `<p class="hero-summary">${esc(w.summary)}</p>`
      : '<p class="hero-summary" style="color:var(--text-3)">No summary written for this week yet.</p>'}
    <div class="hero-tags">${tags}</div>
  </section>`;
}

/* --------------------------------------------------------------- the KPIs */

function kpiHtml(kid, weeks, gaps) {
  const w = weeks[weeks.length - 1];
  const active = gaps.filter((g) => g.status === 'new' || g.status === 'persists').length;
  const avg = Math.round(weeks.reduce((t, x) => t + pct(x.total, x.outOf), 0) / weeks.length);
  const best = weeks.reduce((b, x) => (pct(x.total, x.outOf) > pct(b.total, b.outOf) ? x : b), weeks[0]);

  // Mastery: rungs cleared across the nine slots, out of every rung on the map
  let cleared = 0;
  let totalRungs = 0;
  const pos = (live[kid].position || {}).slots || {};
  if (spine) {
    for (const [slot, ladder] of Object.entries(spine.ladders[kid] || {})) {
      totalRungs += ladder.rungs.length;
      const here = pos[slot];
      const i = here ? ladder.rungs.findIndex((r) => r.id === here.rung) : -1;
      if (i >= 0) cleared += i;
    }
  }

  const tile = (id, label, ic, value, sub, colour, spark) => `
    <div class="kpi">
      <div class="kpi-label">${icon(ic, 'i i-sm')} ${label}</div>
      <div class="kpi-value" style="color:${colour}">${value}</div>
      <div class="kpi-sub">${sub}</div>
      ${spark ? `<div class="kpi-spark"><canvas id="${id}"></canvas></div>` : ''}
    </div>`;

  const gapColour = active > 2 ? 'var(--bad)' : active > 0 ? 'var(--warn)' : 'var(--ok)';

  return `<div class="kpi-row">
    ${tile(`${kid}-spark-acc`, 'Accuracy', 'target', `${pct(w.total, w.outOf)}%`,
      `${avg}% average over ${weeks.length} weeks`, 'var(--accent-ink)', true)}
    ${tile('', 'Best week', 'award', `${pct(best.total, best.outOf)}%`, `week ${best.week}`, 'var(--text)')}
    ${tile('', 'Open gaps', 'alert', String(active),
      `${gaps.length - active} improving`, gapColour)}
    ${tile('', 'Skills cleared', 'layers', totalRungs ? `${cleared}/${totalRungs}` : '-',
      'across the nine slots', 'var(--text)')}
  </div>`;
}

/* ---------------------------------------------------- what needs deciding */

function decisionsHtml(kid, w, gaps, data) {
  const items = [];

  // The marking queue the server is actually holding. These are questions Jev
  // referred that nobody has answered yet, so they are the most urgent thing
  // here. They were fetched and thrown away before, which meant a referred
  // question could sit unmarked indefinitely with nothing on screen saying so.
  const open = (data.decisions || []).filter((d) => d.kind === 'mark');
  if (open.length) {
    const weeks = [...new Set(open.map((d) => d.week))].sort((a, b) => a - b);
    items.push(`${open.length} answer${open.length === 1 ? '' : 's'} still need`
      + `${open.length === 1 ? 's' : ''} a mark from you`
      + ` (week${weeks.length === 1 ? '' : 's'} ${weeks.join(', ')}).`
      + ' Reopen the worksheet to award them.');
  }
  for (const d of (data.decisions || []).filter((x) => x.kind !== 'mark')) {
    items.push(d.summary);
  }

  if (w.design && w.design.length) {
    const undecided = w.design.filter((d) => !d.decision || /decide/i.test(d.decision));
    for (const d of undecided) {
      items.push(`${d.where}: ${d.what}`);
    }
  }
  // An observation is 1, 0 or null, so "not tested" is the null, not a falsy 0.
  const untested = (v) => v === null || v === undefined;
  const stale = gaps.filter((g) => {
    const seen = (g.weeks || []).filter((v) => !untested(v)).length;
    const tail = (g.weeks || []).slice(-6);
    return g.status !== 'resolved' && g.status !== 'parked'
      && seen > 0 && tail.length >= 6 && tail.every(untested);
  });
  for (const g of stale) items.push(`"${g.topic}" has not been tested for six weeks. Retest or close it.`);
  if (w.hintedSections && w.hintedSections.length) {
    items.push(`Sections ${w.hintedSections.join(', ')} were hinted, so they are not clean evidence.`);
  }
  if (!items.length) return '';
  return `<section>
    <div class="decision">
      ${icon('clipboard')}
      <div>
        <div style="font-weight:700;margin-bottom:var(--s1)">${items.length} thing${items.length === 1 ? '' : 's'} for you to decide</div>
        <ul style="margin:0;padding-left:var(--s4);font-size:.86rem;line-height:1.6;color:var(--text-2)">
          ${items.map((i) => `<li>${esc(i)}</li>`).join('')}
        </ul>
      </div>
    </div>
  </section>`;
}

/* ------------------------------------------------------------ chart cards */

/** The legend doubles as the focus control. Buttons rather than coloured
    squares, so it is keyboard reachable and announces its state. */
function subjectLegend(kid) {
  return `<div class="legend" role="group" aria-label="Focus one subject">
    ${SUBJECTS.map((s) => `<button type="button" class="legend-btn" data-focus="${s}"
      data-kid="${kid}" aria-pressed="false">
      <span class="legend-swatch" style="background:var(--series-${s})"></span>
      ${SUBJECT_LABEL[s]}</button>`).join('')}
    <span class="legend-hint" id="${kid}-focus-hint">Tap a subject to focus it</span>
  </div>`;
}

function setFocus(kid, subject) {
  const next = focus[kid] === subject ? null : subject;   // same one again resets
  focus[kid] = next;
  drawCharts(kid);   // rebuilds with the focus baked in
  document.querySelectorAll(`[data-focus][data-kid="${kid}"]`).forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.focus === next));
  });
  document.querySelectorAll(`#${kid}-focus-hint, #${kid}-focus-hint-loss`).forEach((h) => {
    h.textContent = next
      ? `Showing ${SUBJECT_LABEL[next]}. Tap it again to show all three.`
      : 'Tap a subject to focus it';
  });
}

function wireLegends(kid) {
  document.querySelectorAll(`[data-focus][data-kid="${kid}"]`).forEach((btn) => {
    btn.addEventListener('click', () => setFocus(kid, btn.dataset.focus));
  });
}

function chartCard(id, ic, title, pill, table, legend) {
  return `<section class="card">
    <div class="chart-head">${icon(ic)}<h2>${title}</h2>
      ${pill ? `<span class="pill">${pill}</span>` : ''}
      <div class="seg" role="group" aria-label="View as">
        <button type="button" data-view="chart" data-for="${id}" aria-pressed="true">Chart</button>
        <button type="button" data-view="table" data-for="${id}" aria-pressed="false">Table</button>
      </div>
    </div>
    <div class="chart-wrap" id="${id}-chart-wrap" data-open="true">
      <div class="chart-box"><canvas id="${id}-chart"></canvas></div>
      ${legend || ''}
    </div>
    <div class="data-table table-wrap" id="${id}-table" data-open="false">${table}</div>
  </section>`;
}

function wireCard(id) {
  document.querySelectorAll(`[data-for="${id}"]`).forEach((btn) => {
    btn.addEventListener('click', () => {
      const wantTable = btn.dataset.view === 'table';
      document.querySelectorAll(`[data-for="${id}"]`).forEach((b) => {
        b.setAttribute('aria-pressed', String((b.dataset.view === 'table') === wantTable));
      });
      $(`${id}-chart-wrap`).dataset.open = String(!wantTable);
      $(`${id}-table`).dataset.open = String(wantTable);
    });
  });
}

function trendTable(kid, weeks) {
  return `<table><caption class="sr-only">Accuracy by week for ${CHILDREN[kid].name}</caption>
    <thead><tr><th>Week</th><th>Marks</th><th>Accuracy</th></tr></thead><tbody>
    ${weeks.slice().reverse().map((w) => `<tr><td>W${w.week}</td>
      <td class="n">${w.total} / ${w.outOf}</td><td class="n">${pct(w.total, w.outOf)}%</td></tr>`).join('')}
    </tbody></table>`;
}

function subjectTable(kid, weeks) {
  return `<table><caption class="sr-only">Score by subject for ${CHILDREN[kid].name}</caption>
    <thead><tr><th>Week</th>${SUBJECTS.map((s) => `<th>${SUBJECT_LABEL[s]}</th>`).join('')}</tr></thead>
    <tbody>${weeks.slice().reverse().map((w) => `<tr><td>W${w.week}</td>
      ${SUBJECTS.map((s) => `<td class="n">${w[s] == null ? 'not recorded' : `${w[s]} / ${w[`${s}Max`]}`}</td>`).join('')}
    </tr>`).join('')}</tbody></table>`;
}

/* ---------------------------------------------------------- the ladder */

function ladderHtml(kid, data) {
  if (!spine || !spine.ladders[kid]) {
    return '<p class="card-note">The curriculum map did not load.</p>';
  }
  const pos = (data.position || {}).slots || {};
  return `<div class="ladder">${Object.keys(spine.slots).sort().map((slot) => {
    const ladder = spine.ladders[kid][slot];
    if (!ladder) return '';
    const here = pos[slot];
    const i = here ? ladder.rungs.findIndex((r) => r.id === here.rung) : -1;
    const rung = i >= 0 ? ladder.rungs[i] : null;
    const track = ladder.rungs.map((r, n) => `<span class="rung ${n < i ? 'rung-done' : n === i ? 'rung-now' : ''}"
      title="${esc(r.id)} ${esc(r.skill)}"></span>`).join('');
    return `<div class="ladder-row">
      <div class="ladder-slot">${slot}</div>
      <div class="ladder-main">
        <div class="ladder-head">
          <span class="ladder-skill">${rung ? esc(rung.skill) : 'Not recorded'}</span>
          <span class="ladder-purpose">${esc(spine.slots[slot].purpose)}</span>
        </div>
        <div class="ladder-track" role="img"
          aria-label="${i + 1} of ${ladder.rungs.length} rungs reached">${track}</div>
        <div class="ladder-foot">
          <span class="badge badge-neutral">${rung ? esc(rung.id) : '-'}</span>
          <span>${i >= 0 ? `${i} cleared of ${ladder.rungs.length}` : ''}</span>
          ${rung ? `<span>&middot; advances when ${esc(rung.advanceWhen)}</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('')}</div>
  <p class="card-note" style="margin-top:var(--s4)">Goal: ${esc(spine.goals[kid].endState)}</p>`;
}

/* ---------------------------------------------------------- gap heatmap */

function heatHtml(gaps) {
  if (!gaps.length) {
    return `<div class="empty">${icon('checkCircle', 'i i-lg')}<h3>No open gaps</h3>
      <p>Nothing is currently flagged.</p></div>`;
  }
  const order = { new: 0, persists: 1, improving: 2, parked: 3, resolved: 4 };
  const sorted = [...gaps].sort((a, b) => (order[a.status] ?? 5) - (order[b.status] ?? 5));
  const rows = sorted.map((g) => {
    const st = GAP_STATUS[g.status] || GAP_STATUS.new;
    const recent = (g.weeks || []).slice(-8);
    const cells = recent.map((v, i) => {
      const last = i === recent.length - 1;
      // The observation log is 1, 0 or null. It used to be true/false/null in
      // the old store, and this compared with === true, so after the move every
      // cell fell through to "not tested" and the whole card read as empty.
      const tested = v !== null && v !== undefined;
      const right = tested && Number(v) === 1;
      const bg = !tested ? 'var(--surface-3)' : right ? 'var(--ok-wash)' : 'var(--bad-wash)';
      const fg = !tested ? 'var(--text-3)' : right ? 'var(--ok)' : 'var(--bad)';
      const mark = !tested ? '–' : right ? '✓' : '✗';
      const label = !tested ? 'not tested' : right ? 'correct' : 'wrong';
      return `<span class="heat-cell" role="img" aria-label="${label}${last ? ', latest' : ''}"
        style="background:${bg};color:${fg};${last ? 'outline:2px solid var(--accent);outline-offset:1px' : ''}">${mark}</span>`;
    }).join('');
    return `<div class="heat-row">
      <div class="heat-topic"><strong>${esc(g.topic)}</strong>
        <span class="badge ${st.cls}" style="margin-left:var(--s2)">${icon(st.icon)} ${st.label}</span>
        <span class="td-detail">${esc((g.detail || '').slice(0, 150))}</span></div>
      <div class="heat-cells">${cells}</div>
    </div>`;
  }).join('');
  return `<div class="heat">${rows}</div>
    <p class="card-note" style="margin-top:var(--s3)">Last 8 weeks, oldest first. The ringed cell is
      the latest. A dash means not tested that week.</p>`;
}

/* ------------------------------------------------------------ the detail */

function detailHtml(w) {
  const list = (items, ic, colour) => items.map((it) => `<li class="detail-item">
    <span style="color:${colour}">${icon(ic, 'i i-sm')}</span>
    ${it.where ? `<span class="detail-where">${esc(it.where)}</span>` : ''}
    <span>${esc(it.what || it)}</span>
    ${it.decision ? `<span class="badge badge-neutral">${esc(it.decision)}</span>` : ''}
  </li>`).join('');

  const cards = [];
  if (w.wins.length) {
    cards.push(`<div class="card"><div class="detail-head">${icon('checkCircle', 'i i-sm')} What went well</div>
      <ul class="detail-list">${list(w.wins.map((x) => ({ what: x })), 'check', 'var(--ok)')}</ul></div>`);
  }
  if (w.errors.length) {
    cards.push(`<div class="card"><div class="detail-head">${icon('cross', 'i i-sm')} Real errors</div>
      <ul class="detail-list">${list(w.errors, 'cross', 'var(--bad)')}</ul></div>`);
  }
  if (w.design.length) {
    cards.push(`<div class="card"><div class="detail-head">${icon('alert', 'i i-sm')} Question faults, not theirs</div>
      <ul class="detail-list">${list(w.design, 'alert', 'var(--warn)')}</ul></div>`);
  }
  if (!cards.length) cards.push(`<div class="card"><p class="card-note">No detail recorded for this week.</p></div>`);

  return `<div class="detail-grid">${cards.join('')}</div>
    ${w.notes ? `<section class="card" style="margin-top:var(--s3)">
      <details class="disclose" style="border-top:0;margin-top:0;padding-top:0">
        <summary>${icon('chevronRight', 'i i-sm chev')} Full marking notes for week ${w.week}</summary>
        <div class="note-body" style="margin-top:var(--s3)">${esc(w.notes)}</div>
      </details></section>` : ''}`;
}

/* ------------------------------------------------------------------ charts */

function drawCharts(kid) {
  if (!live[kid] || !live[kid].weeks || !live[kid].weeks.length) return;
  const weeks = weeksFor(kid);
  const accent = css(`--child-${kid}`);

  for (const key of ['trend', 'subject', 'loss', 'spark']) {
    if (charts[`${kid}-${key}`]) { charts[`${kid}-${key}`].destroy(); delete charts[`${kid}-${key}`]; }
  }
  // The history chart bakes the theme in too, so it has to be rebuilt with the
  // rest or it keeps the colours of the theme it was first drawn under. Only
  // when its panel is open: a closed <details> has no box to size against.
  if ($(`${kid}-history-chart`) && charts[`${kid}-history`]) drawHistoryChart(kid);
  const trendEl = $(`${kid}-trend-chart`);
  if (trendEl) charts[`${kid}-trend`] = trendChart(trendEl, weeks, accent);
  const subjEl = $(`${kid}-subject-chart`);
  if (subjEl) charts[`${kid}-subject`] = subjectChart(subjEl, weeks, focus[kid] || null);
  const lossEl = $(`${kid}-loss-chart`);
  if (lossEl) charts[`${kid}-loss`] = lossChart(lossEl, weeks, focus[kid] || null);
  const sparkEl = $(`${kid}-spark-acc`);
  if (sparkEl) charts[`${kid}-spark`] = sparkline(sparkEl, weeks.map((w) => pct(w.total, w.outOf)), accent);

}

/* ------------------------------------------------- resolved gaps and history

   Both of these used to fetch the archive bin on demand. Everything they need
   now arrives in the first request, so they are plain renderers. */

function resolvedHtml(kid, data) {
  const resolved = (data.gaps || []).filter((g) => g.status === 'resolved');
  return `<details class="disclose" id="${kid}-resolved">
    <summary>${icon('chevronRight', 'i i-sm chev')} Resolved gaps (${resolved.length})</summary>
    <div style="margin-top:var(--s3)">${
      resolved.length ? heatHtml(resolved)
        : `<div class="empty">${icon('inbox', 'i i-lg')}<p>Nothing resolved yet.</p></div>`
    }</div>
  </details>`;
}

function historyHtml(kid) {
  const all = weeksFor(kid, true).sort((a, b) => a.week - b.week);
  if (!all.length) return '<p class="card-note">No weeks recorded yet.</p>';

  const avg = Math.round(all.reduce((t, w) => t + pct(w.total, w.outOf), 0) / all.length);
  const best = all.reduce((b, w) => (pct(w.total, w.outOf) > pct(b.total, b.outOf) ? w : b), all[0]);

  return `<details class="disclose" id="${kid}-history">
    <summary>${icon('chevronRight', 'i i-sm chev')} Full history, weeks ${all[0].week} to ${all[all.length - 1].week}</summary>
    <div style="margin-top:var(--s4)">
      <div class="kpi-row" style="margin-bottom:var(--s4)">
        <div class="kpi"><div class="kpi-label">${icon('history', 'i i-sm')} Weeks</div>
          <div class="kpi-value">${all.length}</div>
          <div class="kpi-sub">W${all[0].week} to W${all[all.length - 1].week}</div></div>
        <div class="kpi"><div class="kpi-label">${icon('target', 'i i-sm')} Average</div>
          <div class="kpi-value">${avg}%</div><div class="kpi-sub">every week</div></div>
        <div class="kpi"><div class="kpi-label">${icon('award', 'i i-sm')} Best</div>
          <div class="kpi-value">${pct(best.total, best.outOf)}%</div>
          <div class="kpi-sub">week ${best.week}</div></div>
        <div class="kpi"><div class="kpi-label">${icon('save', 'i i-sm')} Answers kept</div>
          <div class="kpi-value">${all.filter((w) => w.hasAnswers).length}</div>
          <div class="kpi-sub">weeks re-markable</div></div>
      </div>
      <div class="chart-box" style="height:240px;margin-bottom:var(--s4)">
        <canvas id="${kid}-history-chart"></canvas></div>
      <div class="table-wrap"><table>
        <caption class="sr-only">Every recorded week for ${CHILDREN[kid].name}</caption>
        <thead><tr><th>Week</th><th>Marks</th><th>Accuracy</th>
          ${SUBJECTS.map((s) => `<th>${SUBJECT_LABEL[s]}</th>`).join('')}<th>Summary</th></tr></thead>
        <tbody>${all.slice().reverse().map((w) => {
          const p = pct(w.total, w.outOf);
          const tone = p >= 90 ? 'badge-ok' : p >= 75 ? 'badge-info' : p >= 60 ? 'badge-warn' : 'badge-bad';
          return `<tr><td><strong>W${w.week}</strong></td><td class="n">${w.total} / ${w.outOf}</td>
            <td><span class="badge ${tone}">${p}%</span></td>
            ${SUBJECTS.map((s) => `<td class="n">${w[s] == null ? '-' : `${w[s]}/${w[`${s}Max`]}`}</td>`).join('')}
            <td style="max-width:34ch"><span class="td-detail" style="margin:0">${esc(w.summary || '')}</span></td></tr>`;
        }).join('')}</tbody></table></div>
    </div>
  </details>`;
}

function drawHistoryChart(kid) {
  const el = $(`${kid}-history-chart`);
  if (!el) return;
  if (charts[`${kid}-history`]) charts[`${kid}-history`].destroy();
  const all = weeksFor(kid, true).sort((a, b) => a.week - b.week);
  charts[`${kid}-history`] = trendChart(el, all, css(`--child-${kid}`));
}

/* ---------------------------------------------------------------- roadmap */

const STATE_ICON = { cleared: 'checkCircle', current: 'target', future: 'square' };

function roadmapHtml(kid) {
  if (!roadmap || !roadmap.children[kid]) return '<p class="card-note">The roadmap did not load.</p>';
  const legend = `<div class="roadmap-legend">${['cleared', 'current', 'future'].map((s) =>
    `<span class="row" style="gap:var(--s1)"><span class="kl-${s}" style="display:inline-flex">
      ${icon(STATE_ICON[s], 'i i-sm')}</span><span class="card-note">${
      s === 'cleared' ? 'Cleared' : s === 'current' ? 'Current level' : 'Not yet reached'}</span></span>`).join('')}</div>`;

  const cols = roadmap.children[kid].tracks.map((t) => {
    let html = `<div class="roadmap-col"><h3>${icon(t.icon)} ${esc(t.track)}</h3>`;
    let inSub = false;
    t.items.forEach((it) => {
      if (it.type === 'group') {
        if (inSub) { html += '</div>'; inSub = false; }
        html += `<p class="kl-group">${esc(it.label)}</p><div class="kl-sub">`;
        inSub = true;
        return;
      }
      html += `<div class="kl kl-${it.state}">${iconLabelled(STATE_ICON[it.state], it.state, 'i i-sm')}
        <div><div class="kl-name">${esc(it.name)}</div>
        <div class="kl-desc">${esc(it.detail)}</div></div></div>`;
    });
    if (inSub) html += '</div>';
    return `${html}</div>`;
  }).join('');

  return `${legend}<div class="roadmap-cols">${cols}</div>
    <p class="card-note" style="margin-top:var(--s4)">${esc(roadmap.note)}</p>
    <p class="card-note" style="margin-top:var(--s2);color:var(--warn)">
      ${icon('alert', 'i i-sm')} ${esc(roadmap.warning)}</p>`;
}

initTheme();
init();

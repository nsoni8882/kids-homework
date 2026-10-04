/* Parent dashboard.

   The live bin carries the last 8 weeks, which is what loads first. Everything
   older, and the resolved gaps, live in the archive bin and are fetched lazily
   the first time a panel that needs them is opened. */

import { CHILDREN } from './config.js';
import { loadLive, loadArchive } from './store.js';
import { icon, iconLabelled, SUBJECT_ICON } from './icons.js';

const KIDS = ['mason', 'elysia'];
const SUBJECT_MAX = {
  mason: { english: 20, maths: 20, thinking: 15, total: 55 },
  elysia: { english: 15, maths: 15, thinking: 10, total: 40 },
};
const SUBJECT_LABEL = { english: 'English', maths: 'Maths', thinking: 'Thinking skills' };
const GAP_STATUS = {
  new: { label: 'New', cls: 'badge-bad', icon: 'alert' },
  persists: { label: 'Persists', cls: 'badge-warn', icon: 'alert' },
  improving: { label: 'Improving', cls: 'badge-info', icon: 'trend' },
  resolved: { label: 'Resolved', cls: 'badge-ok', icon: 'checkCircle' },
};

const charts = {};
let live = null;
let archive = null;       // fetched on demand
let archivePromise = null;
let roadmap = null;

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ theme */

const THEME_KEY = 'kh-theme';

function isDark() {
  const set = document.documentElement.getAttribute('data-theme');
  if (set) return set === 'dark';
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

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
  try { saved = localStorage.getItem(THEME_KEY) || 'system'; } catch { /* blocked storage */ }
  applyTheme(saved);
  $('theme-btn').addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, next); } catch { /* blocked storage */ }
    applyTheme(next);
    if (live) KIDS.forEach(drawCharts);   // charts bake in the theme colours
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!document.documentElement.hasAttribute('data-theme')) {
      applyTheme('system');
      if (live) KIDS.forEach(drawCharts);
    }
  });
}

const cssVar = (name) => getComputedStyle(document.documentElement)
  .getPropertyValue(name).trim();

/* ------------------------------------------------------------------- data */

/** Normalise a week entry from either bin into the one shape the UI uses. */
function normalise(kid, raw) {
  const max = SUBJECT_MAX[kid];
  const sm = raw.sectionMarks || {};
  const hasSections = Object.keys(sm).length > 0;
  const sum = (...ids) => ids.reduce((t, id) => t + (sm[id] || 0), 0);
  return {
    week: raw.week,
    total: raw.total,
    outOf: raw.outOf || raw.max || max.total,
    // null, not 0, when a week predates section marks: Chart.js then leaves a
    // gap instead of drawing a misleading zero.
    english: hasSections ? sum('1A', '1B', '1C') : (raw.english ?? null),
    maths: hasSections ? sum('2A', '2B', '2C') : (raw.maths ?? null),
    thinking: hasSections ? sum('3A', '3B', '3C') : (raw.thinking ?? null),
    englishMax: raw.englishMax || max.english,
    mathsMax: raw.mathsMax || max.maths,
    thinkingMax: raw.thinkingMax || max.thinking,
    notes: raw.notes || '',
    hasAnswers: !!(raw.archive && Object.keys(raw.archive).length),
  };
}

function getArchive() {
  if (!archivePromise) {
    archivePromise = loadArchive().then((d) => { archive = d; return d; });
  }
  return archivePromise;
}

async function init() {
  try {
    const [liveData, roadmapData] = await Promise.all([
      loadLive(),
      fetch(new URL('./roadmap.json', import.meta.url)).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    live = liveData;
    roadmap = roadmapData;
    $('loading').hidden = true;
    $('app').hidden = false;
    KIDS.forEach(renderKid);
    initTabs();
  } catch (err) {
    $('loading').hidden = true;
    const box = $('error');
    box.hidden = false;
    box.innerHTML = `<div class="error-card">
      ${iconLabelled('alert', 'Error', 'i i-lg')}
      <h2>Could not load the tracker</h2>
      <p>${esc(err.message)}</p>
      <button class="btn btn-secondary" onclick="location.reload()">${icon('refresh')} Try again</button>
    </div>`;
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
      const next = tabs[(i + d + tabs.length) % tabs.length];
      next.focus();
      show(next.dataset.kid);
    });
  });
  show('mason');
}

/* --------------------------------------------------------------- per child */

function renderKid(kid) {
  const data = live[kid] || {};
  if (!data.weeks || !data.weeks.length) {
    $(`panel-${kid}`).innerHTML = `<div class="card"><div class="empty">
      ${icon('inbox', 'i i-lg')}<h2>No weeks recorded yet</h2>
      <p>The first submitted worksheet will show up here.</p>
    </div></div>`;
    return;
  }

  const weeks = data.weeks.slice(-8).map((w) => normalise(kid, w));
  const latest = weeks[weeks.length - 1];
  const prev = weeks.length > 1 ? weeks[weeks.length - 2] : null;
  const pct = Math.round(latest.total / latest.outOf * 100);
  const gaps = data.gaps || [];
  const active = gaps.filter((g) => g.status === 'new' || g.status === 'persists').length;

  const trend = !prev ? { cls: 'trend-flat', icon: 'square', text: 'first week recorded' }
    : latest.total > prev.total ? { cls: 'trend-up', icon: 'trend', text: `up from ${prev.total}` }
    : latest.total < prev.total ? { cls: 'trend-down', icon: 'trendDown', text: `down from ${prev.total}` }
    : { cls: 'trend-flat', icon: 'flat', text: `level with ${prev.total}` };

  const kumonMaths = (data.kumonLevel && data.kumonLevel.maths)
    || (kid === 'mason' ? 'Level C' : 'Level B');
  const kumonEnglish = (data.kumonLevel && data.kumonLevel.english)
    || (kid === 'mason' ? 'Level BI' : 'Level AI');

  const gapTone = active > 2 ? 'var(--bad)' : active > 0 ? 'var(--warn)' : 'var(--ok)';

  const subjectLine = ['english', 'maths', 'thinking'].map((s) => {
    const got = latest[s];
    const max = latest[`${s}Max`];
    return `<span class="subj-${s}">${icon(SUBJECT_ICON[s], 'i i-sm')}
      <span style="color:var(--text-2)">${got === null ? '-' : got}/${max}</span></span>`;
  }).join('');

  $(`panel-${kid}`).innerHTML = `
    <h1 class="sr-only">${CHILDREN[kid].name}'s progress</h1>
    <div class="grid grid-3">
      <div class="stat">
        <div class="stat-num">${latest.total}<span style="font-size:.6em;color:var(--text-3)">/${latest.outOf}</span></div>
        <div class="stat-label">Week ${latest.week} score</div>
        <div class="stat-sub ${trend.cls}">${icon(trend.icon, 'i i-sm')} ${trend.text}</div>
      </div>
      <div class="stat">
        <div class="stat-num">${pct}%</div>
        <div class="stat-label">Accuracy</div>
        <div class="stat-sub">${subjectLine}</div>
      </div>
      <div class="stat">
        <div class="stat-num" style="color:${gapTone}">${active}</div>
        <div class="stat-label">Open gaps</div>
        <div class="stat-sub">
          <span class="pill">${icon('calc', 'i i-sm')} ${esc(kumonMaths)}</span>
          <span class="pill">${icon('book', 'i i-sm')} ${esc(kumonEnglish)}</span>
        </div>
      </div>
    </div>

    <div class="grid grid-2" style="margin-top:var(--s4)">
      <section class="card">
        <div class="card-head">${icon('trend')}<h2>Total score</h2>
          <span class="pill">last ${weeks.length} weeks</span></div>
        <div class="chart-box"><canvas id="${kid}-total-chart"></canvas></div>
        ${srTable(kid, weeks, 'total')}
      </section>
      <section class="card">
        <div class="card-head">${icon('target')}<h2>By subject</h2></div>
        <div class="chart-box"><canvas id="${kid}-subject-chart"></canvas></div>
        ${srTable(kid, weeks, 'subject')}
      </section>
    </div>

    <section class="card" style="margin-top:var(--s4)">
      <div class="card-head">${icon('notes')}<h2>Latest session notes</h2></div>
      ${notesHtml(weeks)}
    </section>

    <h2 class="section-label">Gap tracker</h2>
    <section class="card">
      <div class="card-head">${icon('search')}<h2>Learning gaps</h2>
        <span class="pill">${gaps.length} open</span></div>
      ${gapTable(gaps)}
      <details class="disclose" id="${kid}-resolved">
        <summary>${icon('chevronRight', 'i i-sm chev')} Resolved gaps, from the archive</summary>
        <div id="${kid}-resolved-body" style="margin-top:var(--s3)">
          <p class="card-note">Opening this loads the archive.</p>
        </div>
      </details>
    </section>

    <h2 class="section-label">Full history</h2>
    <section class="card">
      <div class="card-head">${icon('history')}<h2>Every week on record</h2></div>
      <p class="card-note">The charts above show the last 8 weeks, which is all the live tracker
        holds. The rest is in the archive.</p>
      <details class="disclose" id="${kid}-history">
        <summary>${icon('chevronRight', 'i i-sm chev')} Load the full history</summary>
        <div id="${kid}-history-body" style="margin-top:var(--s4)">
          <p class="card-note">Opening this loads the archive.</p>
        </div>
      </details>
    </section>

    <h2 class="section-label">Kumon curriculum</h2>
    <section class="card">
      <div class="card-head">${icon('compass')}<h2>Level progress</h2></div>
      ${roadmapHtml(kid)}
    </section>
  `;

  $(`${kid}-resolved`).addEventListener('toggle', function once() {
    this.removeEventListener('toggle', once);
    loadResolvedGaps(kid);
  });
  $(`${kid}-history`).addEventListener('toggle', function once() {
    this.removeEventListener('toggle', once);
    loadHistory(kid);
  });
}

/* ----------------------------------------------------------------- charts */

function drawCharts(kid) {
  const data = live[kid] || {};
  if (!data.weeks || !data.weeks.length) return;
  const weeks = data.weeks.slice(-8).map((w) => normalise(kid, w));
  const labels = weeks.map((w) => `W${w.week}`);

  const accent = cssVar(`--child-${kid}`);
  const grid = cssVar('--border');
  const ink = cssVar('--text-2');
  const surface = cssVar('--surface');
  const text = cssVar('--text');

  const common = {
    responsive: true,
    maintainAspectRatio: false,
    animation: matchMedia('(prefers-reduced-motion: reduce)').matches ? false : { duration: 300 },
    interaction: { mode: 'index', intersect: false },
    scales: {
      y: {
        min: 40, max: 100, ticks: { callback: (v) => `${v}%`, color: ink, font: { size: 11 } },
        grid: { color: grid }, border: { color: grid },
      },
      x: { ticks: { color: ink, font: { size: 11 } }, grid: { display: false }, border: { color: grid } },
    },
    plugins: {
      tooltip: {
        backgroundColor: surface, titleColor: text, bodyColor: ink,
        borderColor: grid, borderWidth: 1, padding: 10, displayColors: true,
      },
    },
  };

  if (charts[`${kid}-total`]) charts[`${kid}-total`].destroy();
  charts[`${kid}-total`] = new Chart($(`${kid}-total-chart`), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Total',
        data: weeks.map((w) => Math.round(w.total / w.outOf * 100)),
        borderColor: accent,
        backgroundColor: `color-mix(in srgb, ${accent} 16%, transparent)`,
        borderWidth: 2.5, pointRadius: 5, pointHoverRadius: 8,
        pointBackgroundColor: accent, pointBorderColor: surface, pointBorderWidth: 2,
        fill: true, tension: 0.3,
      }],
    },
    options: {
      ...common,
      plugins: {
        ...common.plugins,
        legend: { display: false },
        tooltip: {
          ...common.plugins.tooltip,
          callbacks: {
            afterBody: (items) => {
              const w = weeks[items[0].dataIndex];
              return `${w.total} of ${w.outOf} marks`;
            },
          },
        },
      },
    },
  });

  // Subject bars carry a pattern-free but distinct hue each, plus the legend
  // and the screen reader table, so the series never depends on colour alone.
  const subjectColours = {
    english: cssVar('--english'), maths: cssVar('--maths'), thinking: cssVar('--thinking'),
  };

  if (charts[`${kid}-subject`]) charts[`${kid}-subject`].destroy();
  charts[`${kid}-subject`] = new Chart($(`${kid}-subject-chart`), {
    type: 'bar',
    data: {
      labels,
      datasets: ['english', 'maths', 'thinking'].map((s) => ({
        label: SUBJECT_LABEL[s],
        data: weeks.map((w) => (w[s] === null ? null : Math.round(w[s] / w[`${s}Max`] * 100))),
        backgroundColor: subjectColours[s],
        borderRadius: 4, borderSkipped: false, maxBarThickness: 22,
      })),
    },
    options: {
      ...common,
      plugins: {
        ...common.plugins,
        legend: {
          position: 'bottom',
          labels: { boxWidth: 12, boxHeight: 12, color: ink, font: { size: 11 }, usePointStyle: true, pointStyle: 'rectRounded' },
        },
      },
    },
  });
}

/** A chart on its own is not readable by a screen reader, so every chart ships
    with the same numbers as a table. */
function srTable(kid, weeks, kind) {
  const head = kind === 'total'
    ? '<tr><th>Week</th><th>Marks</th><th>Percent</th></tr>'
    : `<tr><th>Week</th>${['english', 'maths', 'thinking'].map((s) => `<th>${SUBJECT_LABEL[s]}</th>`).join('')}</tr>`;
  const rows = weeks.map((w) => (kind === 'total'
    ? `<tr><td>${w.week}</td><td>${w.total} of ${w.outOf}</td><td>${Math.round(w.total / w.outOf * 100)}%</td></tr>`
    : `<tr><td>${w.week}</td>${['english', 'maths', 'thinking']
        .map((s) => `<td>${w[s] === null ? 'not recorded' : `${w[s]} of ${w[`${s}Max`]}`}</td>`).join('')}</tr>`
  )).join('');
  return `<table class="sr-only"><caption>${kind === 'total' ? 'Total score' : 'Score by subject'}
    for ${CHILDREN[kid].name}, last ${weeks.length} weeks</caption>
    <thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

/* ------------------------------------------------------------------ notes */

function notesHtml(weeks) {
  const recent = weeks.slice().reverse().slice(0, 3);
  return recent.map((w) => `
    <article class="note-item">
      <div class="note-head">
        <span class="note-week">Week ${w.week}</span>
        <span class="note-score">${w.total} of ${w.outOf}, ${Math.round(w.total / w.outOf * 100)}%</span>
      </div>
      <div class="note-body">${w.notes ? esc(w.notes) : 'Marking still to be written up.'}</div>
    </article>`).join('');
}

/* ------------------------------------------------------------------- gaps */

function gapTable(gaps) {
  if (!gaps.length) {
    return `<div class="empty">${icon('checkCircle', 'i i-lg')}
      <h3>No open gaps</h3><p>Nothing is currently flagged.</p></div>`;
  }
  const order = { new: 0, persists: 1, improving: 2, resolved: 3 };
  const sorted = [...gaps].sort((a, b) => (order[a.status] ?? 4) - (order[b.status] ?? 4));

  const rows = sorted.map((g) => {
    const st = GAP_STATUS[g.status] || GAP_STATUS.new;
    const recent = (g.weeks || []).slice(-8);
    const chips = recent.map((v, i) => {
      const last = i === recent.length - 1;
      const cls = v === true ? 'week-pass' : v === false ? 'week-fail' : 'week-null';
      const mark = v === true ? '✓' : v === false ? '✗' : '–';
      const label = v === true ? 'correct' : v === false ? 'wrong' : 'not tested';
      return `<span class="week-chip ${cls}${last ? ' week-latest' : ''}"
        role="img" aria-label="${label}${last ? ', latest week' : ''}">${mark}</span>`;
    }).join('');
    const detail = (g.detail || '').slice(0, 160);
    return `<tr>
      <td class="td-topic"><strong>${esc(g.topic)}</strong>
        <span class="td-detail">${esc(detail)}${(g.detail || '').length > 160 ? '…' : ''}</span></td>
      <td><span class="badge ${st.cls}">${icon(st.icon)} ${st.label}</span></td>
      <td style="white-space:nowrap">${chips}</td>
    </tr>`;
  }).join('');

  return `<div class="table-wrap"><table>
    <thead><tr><th>Topic</th><th>Status</th>
      <th>Week history <span style="font-weight:400;text-transform:none;letter-spacing:0">ringed is latest</span></th>
    </tr></thead><tbody>${rows}</tbody></table></div>`;
}

async function loadResolvedGaps(kid) {
  const box = $(`${kid}-resolved-body`);
  box.innerHTML = `<div class="row"><div class="spinner" style="width:20px;height:20px"></div>
    <span class="card-note">Loading the archive</span></div>`;
  try {
    const data = await getArchive();
    const resolved = ((data[kid] || {}).resolvedGaps) || [];
    const summary = $(`${kid}-resolved`).querySelector('summary');
    summary.innerHTML = `${icon('chevronRight', 'i i-sm chev')} Resolved gaps (${resolved.length})`;
    box.innerHTML = resolved.length
      ? gapTable(resolved)
      : `<div class="empty">${icon('inbox', 'i i-lg')}<p>Nothing archived yet.</p></div>`;
  } catch (err) {
    box.innerHTML = `<p class="helper" style="color:var(--bad)">${icon('alert', 'i i-sm')}
      Could not load the archive: ${esc(err.message)}</p>`;
  }
}

/* ---------------------------------------------------------- full history */

async function loadHistory(kid) {
  const box = $(`${kid}-history-body`);
  box.innerHTML = `<div class="row"><div class="spinner" style="width:20px;height:20px"></div>
    <span class="card-note">Loading the archive</span></div>`;
  try {
    const data = await getArchive();
    const older = ((data[kid] || {}).weeks) || [];
    const all = [...older, ...(live[kid].weeks || [])]
      .map((w) => normalise(kid, w))
      .sort((a, b) => a.week - b.week);

    const summary = $(`${kid}-history`).querySelector('summary');
    summary.innerHTML = `${icon('chevronRight', 'i i-sm chev')} Full history (weeks ${all[0].week} to ${all[all.length - 1].week})`;

    const best = all.reduce((b, w) => (w.total / w.outOf > b.total / b.outOf ? w : b), all[0]);
    const avg = Math.round(all.reduce((t, w) => t + w.total / w.outOf * 100, 0) / all.length);

    const rows = all.slice().reverse().map((w) => {
      const p = Math.round(w.total / w.outOf * 100);
      const tone = p >= 90 ? 'badge-ok' : p >= 75 ? 'badge-info' : p >= 60 ? 'badge-warn' : 'badge-bad';
      return `<tr>
        <td><strong>W${w.week}</strong></td>
        <td class="n">${w.total} / ${w.outOf}</td>
        <td><span class="badge ${tone}">${p}%</span></td>
        <td class="n">${w.english === null ? '-' : `${w.english}/${w.englishMax}`}</td>
        <td class="n">${w.maths === null ? '-' : `${w.maths}/${w.mathsMax}`}</td>
        <td class="n">${w.thinking === null ? '-' : `${w.thinking}/${w.thinkingMax}`}</td>
        <td>${w.hasAnswers ? `<span class="badge badge-neutral">${icon('check')} kept</span>` : ''}</td>
      </tr>`;
    }).join('');

    box.innerHTML = `
      <div class="grid grid-3" style="margin-bottom:var(--s4)">
        <div class="stat"><div class="stat-num">${all.length}</div>
          <div class="stat-label">Weeks recorded</div>
          <div class="stat-sub">W${all[0].week} to W${all[all.length - 1].week}</div></div>
        <div class="stat"><div class="stat-num">${avg}%</div>
          <div class="stat-label">Average accuracy</div>
          <div class="stat-sub">across every week</div></div>
        <div class="stat"><div class="stat-num">${Math.round(best.total / best.outOf * 100)}%</div>
          <div class="stat-label">Best week</div>
          <div class="stat-sub">${icon('award', 'i i-sm')} week ${best.week}</div></div>
      </div>
      <div class="chart-box" style="height:260px;margin-bottom:var(--s4)">
        <canvas id="${kid}-history-chart"></canvas>
      </div>
      <div class="table-wrap"><table>
        <caption class="sr-only">Every recorded week for ${CHILDREN[kid].name}</caption>
        <thead><tr><th>Week</th><th>Marks</th><th>Percent</th>
          <th>English</th><th>Maths</th><th>Thinking</th><th>Answers</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;

    const accent = cssVar(`--child-${kid}`);
    const grid = cssVar('--border');
    const ink = cssVar('--text-2');
    if (charts[`${kid}-history`]) charts[`${kid}-history`].destroy();
    charts[`${kid}-history`] = new Chart($(`${kid}-history-chart`), {
      type: 'line',
      data: {
        labels: all.map((w) => `W${w.week}`),
        datasets: [{
          label: 'Accuracy',
          data: all.map((w) => Math.round(w.total / w.outOf * 100)),
          borderColor: accent,
          backgroundColor: `color-mix(in srgb, ${accent} 14%, transparent)`,
          borderWidth: 2, pointRadius: 3, pointHoverRadius: 7,
          pointBackgroundColor: accent, fill: true, tension: 0.25,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: matchMedia('(prefers-reduced-motion: reduce)').matches ? false : { duration: 300 },
        plugins: { legend: { display: false } },
        scales: {
          y: { min: 40, max: 100, ticks: { callback: (v) => `${v}%`, color: ink }, grid: { color: grid } },
          x: { ticks: { color: ink, autoSkip: true, maxTicksLimit: 12 }, grid: { display: false } },
        },
      },
    });
  } catch (err) {
    box.innerHTML = `<p class="helper" style="color:var(--bad)">${icon('alert', 'i i-sm')}
      Could not load the archive: ${esc(err.message)}</p>`;
  }
}

/* ---------------------------------------------------------------- roadmap */

const STATE_ICON = { cleared: 'checkCircle', current: 'target', future: 'square' };

function roadmapHtml(kid) {
  if (!roadmap || !roadmap.children[kid]) {
    return `<p class="card-note">The roadmap did not load.</p>`;
  }
  const { tracks } = roadmap.children[kid];
  const legend = `<div class="roadmap-legend">
    ${['cleared', 'current', 'future'].map((s) => `<span class="row" style="gap:var(--s1)">
      <span class="kl-${s}" style="display:inline-flex">${icon(STATE_ICON[s], 'i i-sm')}</span>
      <span class="card-note">${s === 'cleared' ? 'Cleared' : s === 'current' ? 'Current level' : 'Not yet reached'}</span>
    </span>`).join('')}
  </div>`;

  const cols = tracks.map((t) => {
    let html = `<div class="roadmap-col"><h3>${icon(t.icon)} ${esc(t.track)}</h3>`;
    let inSub = false;
    t.items.forEach((it) => {
      if (it.type === 'group') {
        if (inSub) { html += '</div>'; inSub = false; }
        html += `<p class="kl-group">${esc(it.label)}</p><div class="kl-sub">`;
        inSub = true;
        return;
      }
      html += `<div class="kl kl-${it.state}">
        ${iconLabelled(STATE_ICON[it.state], it.state, 'i i-sm')}
        <div><div class="kl-name">${esc(it.name)}</div>
        <div class="kl-desc">${esc(it.detail)}</div></div>
      </div>`;
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

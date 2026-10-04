/* The weekly worksheet, one child per page.

   Flow: welcome -> one screen per section -> parent marks the written answers
   -> results, which save themselves. A week already submitted can be reopened
   read only from the welcome screen. */

import { CHILDREN, currentChild } from './config.js';
import { apiWeek, apiSubmit, apiAward } from './store.js';
import { icon, iconLabelled, SUBJECT_ICON } from './icons.js';

const child = currentChild();
const PROFILE = CHILDREN[child];
const NAME = PROFILE.name;

const app = document.getElementById('app');
const render = (html) => { app.innerHTML = html; app.scrollTop = 0; window.scrollTo(0, 0); };
const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const plural = (n) => (n === 1 ? 'mark' : 'marks');

let week = null;           // { weekNum, sections[] }
let savedEntry = null;     // the week's entry in the bin, if already submitted
let sectionIdx = 0;
let answers = {};
let sectionMarks = {};
let toMark = [];           // parent marked questions
let markIdx = 0;
let reviewMode = false;
let timerId = null;
let serverResult = null;
const sectionSecs = {};        // how long each section actually took
let sectionStarted = Date.now();
const startedAt = Date.now();

function recordSectionTime() {
  const sec = week.sections[sectionIdx];
  if (!sec) return;
  sectionSecs[sec.id] = (sectionSecs[sec.id] || 0) + Math.round((Date.now() - sectionStarted) / 1000);
  sectionStarted = Date.now();
}

/* ------------------------------------------------------------------ theme */

const THEME_KEY = 'kh-theme';

function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  const btn = document.getElementById('theme-btn');
  if (btn) {
    const dark = mode === 'dark'
      || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    btn.innerHTML = icon(dark ? 'sun' : 'moon');
    btn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  }
}

export function initTheme() {
  let saved = 'system';
  try { saved = localStorage.getItem(THEME_KEY) || 'system'; } catch { /* blocked storage */ }
  applyTheme(saved);
  const btn = document.getElementById('theme-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark'
      || (!document.documentElement.hasAttribute('data-theme')
          && matchMedia('(prefers-color-scheme: dark)').matches);
    const next = dark ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, next); } catch { /* blocked storage */ }
    applyTheme(next);
  });
}

/* ------------------------------------------------------------------- init */

async function init() {
  render(`<div class="center-state">
    <div class="spinner" role="status" aria-label="Loading"></div>
    <p>Loading this week's homework</p>
  </div>`);
  try {
    const data = await apiWeek(child);
    week = data.questions;
    // perQuestion is kept, not discarded: it is how the server marked each
    // answer. Review mode shows exactly that rather than re-deciding in the
    // browser, which could disagree with the database.
    savedEntry = data.submitted
      ? { week: data.week, total: data.submitted.total, outOf: data.submitted.outOf,
          sectionMarks: data.submitted.sectionMarks, archive: data.submitted.answers,
          perQuestion: data.submitted.perQuestion || {} }
      : null;
    showWelcome();
  } catch (err) {
    render(`<div class="center-state">
      <div class="error-card">
        ${iconLabelled('alert', 'Error', 'i i-lg')}
        <h2>Could not load the homework</h2>
        <p>${esc(err.message)}</p>
        <button class="btn btn-secondary" onclick="location.reload()">
          ${icon('refresh')} Try again
        </button>
      </div>
    </div>`);
  }
}

/* ---------------------------------------------------------------- welcome */

function showWelcome() {
  clearInterval(timerId);
  const total = week.sections.reduce((s, sec) => s + sec.totalMarks, 0);

  const chips = week.sections.map((s) => `
    <li class="section-chip">
      <span class="subj-${s.subject}">${icon(SUBJECT_ICON[s.subject] || 'square', 'i i-sm')}</span>
      <span>${esc(s.title)}</span>
      <span class="chip-marks">${s.totalMarks}m</span>
    </li>`).join('');

  let banner = '';
  if (savedEntry) {
    const pct = Math.round(savedEntry.total / savedEntry.outOf * 100);
    const marks = savedEntry.sectionMarks || {};
    const bySubject = {};
    week.sections.forEach((sec) => {
      bySubject[sec.subject] = (bySubject[sec.subject] || 0) + (marks[sec.id] || 0);
    });
    const parts = Object.entries(bySubject)
      .map(([s, m]) => `${m} ${s}`).join(' · ');
    banner = `<div class="banner">
      <div class="banner-title">${icon('checkCircle')} Week ${savedEntry.week} already submitted</div>
      <div class="banner-score">${savedEntry.total} / ${savedEntry.outOf} <span style="font-size:.9rem;font-weight:400">(${pct}%)</span></div>
      <div class="banner-sub">${esc(parts)}</div>
    </div>`;
  }

  const actions = savedEntry
    ? `<div class="welcome-actions">
         <button class="btn btn-primary btn-lg" data-act="review">${icon('eye')} Review ${esc(NAME)}'s answers</button>
         <button class="btn btn-secondary" data-act="fresh">Start again with a blank sheet</button>
       </div>`
    : `<div class="welcome-actions">
         <button class="btn btn-primary btn-lg" data-act="fresh">${icon('play')} Start homework</button>
       </div>`;

  render(`<div class="welcome">
    <div class="welcome-mark">${icon(PROFILE.icon, 'i')}</div>
    <h1>${esc(NAME)}'s homework</h1>
    <div class="week-badge">Week ${week.weekNum}</div>
    <p class="welcome-meta">${total} marks across ${week.sections.length} sections</p>
    <ul class="section-chips" style="list-style:none;padding:0;margin:0">${chips}</ul>
    ${banner}
    ${actions}
  </div>`);

  app.querySelector('[data-act="fresh"]').addEventListener('click', startFresh);
  const rev = app.querySelector('[data-act="review"]');
  if (rev) rev.addEventListener('click', startReview);
}

function startReview() {
  reviewMode = true;
  answers = { ...(savedEntry.archive || {}) };
  sectionMarks = { ...(savedEntry.sectionMarks || {}) };
  sectionIdx = 0;
  showSection();
}

function startFresh() {
  reviewMode = false;
  answers = {};
  sectionMarks = {};
  toMark = [];
  sectionIdx = 0;
  showSection();
}

/* --------------------------------------------------------------- sections */

function showSection() {
  const sec = week.sections[sectionIdx];
  const count = week.sections.length;
  const isLast = sectionIdx === count - 1;
  clearInterval(timerId);

  const passage = sec.passage ? `
    <div class="passage">
      <div class="passage-label">${icon('book')} ${esc(sec.title)}</div>
      <p>${esc(sec.passage)}</p>
    </div>` : '';

  const scored = reviewMode && sectionMarks[sec.id] !== undefined
    ? `<span><strong>Scored ${sectionMarks[sec.id]} / ${sec.totalMarks}</strong></span>` : '';

  const meta = reviewMode
    ? `<span>${icon('award', 'i i-sm')} ${sec.totalMarks} ${plural(sec.totalMarks)}</span>${scored}`
    : `<span>${icon('clock', 'i i-sm')} Target ${sec.timerMins} min</span>
       <span class="timer" id="timer" aria-live="off">0:00</span>
       <span>${icon('award', 'i i-sm')} ${sec.totalMarks} ${plural(sec.totalMarks)}</span>`;

  render(`
    <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="${count}"
         aria-valuenow="${sectionIdx}" aria-label="Section progress">
      <div class="progress-fill" style="width:${sectionIdx / count * 100}%"></div>
    </div>
    <div class="page page-narrow" style="padding-top:var(--s5)">
      ${reviewMode ? `<div class="mode-bar">${icon('eye')} Reviewing saved answers for week ${week.weekNum}</div>` : ''}
      <div class="section-top">
        <span class="section-count">Section ${sectionIdx + 1} of ${count}</span>
        <span class="chip-subject subj-${sec.subject}">
          ${icon(SUBJECT_ICON[sec.subject] || 'square', 'i i-sm')} ${esc(sec.subject)}
        </span>
      </div>
      <h1>${esc(sec.title)}</h1>
      <div class="section-meta">${meta}</div>
      ${passage}
      <div>${sec.scoreBand ? drillSection(sec) : regularSection(sec)}</div>
      <div class="section-nav">
        ${sectionIdx > 0 ? `<button class="btn btn-secondary" data-nav="prev">${icon('arrowLeft')} Back</button>` : ''}
        <button class="btn btn-primary" data-nav="next">
          ${isLast ? (reviewMode ? 'Back to results' : 'Finish') : 'Next section'} ${icon('arrowRight')}
        </button>
      </div>
    </div>`);

  // restore anything already typed, and lock the fields in review mode
  app.querySelectorAll('[data-qid]').forEach((el) => {
    if (answers[el.dataset.qid] !== undefined) el.value = answers[el.dataset.qid];
    if (reviewMode) el.readOnly = true;
  });

  app.querySelector('[data-nav="next"]').addEventListener('click', nextSection);
  const prev = app.querySelector('[data-nav="prev"]');
  if (prev) prev.addEventListener('click', prevSection);

  if (!reviewMode) { sectionStarted = Date.now(); startTimer(sec); }
}

function startTimer(sec) {
  const el = document.getElementById('timer');
  if (!el) return;
  const target = sec.timerMins * 60;
  let elapsed = 0;
  timerId = setInterval(() => {
    elapsed++;
    const m = Math.floor(elapsed / 60);
    const s = String(elapsed % 60).padStart(2, '0');
    el.textContent = `${m}:${s}`;
    el.className = elapsed > target ? 'timer timer-over' : 'timer';
  }, 1000);
}

function drillSection(sec) {
  const grid = sec.questions.filter((q) => q.inputType === 'letter' || q.inputType === 'number');
  const free = sec.questions.filter(
    (q) => !['letter', 'number', 'none'].includes(q.inputType),
  );
  let html = '';

  if (grid.length) {
    if (grid[0].inputType === 'letter') {
      const first = grid[0].text;
      const instr = first.includes('S,') || first.includes('S, M')
        ? 'Identify each phrase. S = Simile, M = Metaphor, P = Personification.'
        : 'Write N for Noun or V for Verb next to each word.';
      const items = grid.map((q) => {
        const word = q.text
          .replace(/^Write S, M or P for:\s*/i, '')
          .replace(/^Write N or V for( the word)?:\s*/i, '');
        return `<div class="letter-item">
          <span class="letter-word" id="lbl-${q.id}">${esc(word)}</span>
          <input class="letter-input" type="text" maxlength="2" data-qid="${q.id}"
            aria-labelledby="lbl-${q.id}" placeholder="?"
            autocorrect="off" autocapitalize="characters" autocomplete="off"
            oninput="this.value=this.value.toUpperCase().replace(/[^A-Z]/g,'')">
        </div>`;
      }).join('');
      html += `<p class="drill-instr">${instr}</p><div class="letter-grid">${items}</div>`;
    } else {
      const items = grid.map((q, i) => {
        const label = `${i + 1}. ${esc(q.text).replace(/\s*=\s*\?.*$/, ' =')} ?`;
        return `<div class="number-item">
          <label for="in-${q.id}">${label}</label>
          <input class="number-input" id="in-${q.id}" type="number" data-qid="${q.id}"
            inputmode="numeric" placeholder="?" autocomplete="off">
        </div>`;
      }).join('');
      html += `<div class="number-grid">${items}</div>`;
    }
  }

  if (free.length) {
    html += `<div style="margin-top:var(--s5)">${
      free.map((q, i) => questionCard(q, grid.length + i + 1)).join('')
    }</div>`;
  }
  return html;
}

function regularSection(sec) {
  return sec.questions.map((q, i) => questionCard(q, i + 1)).join('');
}

function questionCard(q, num) {
  const needsParent = !q.autoMark && q.inputType !== 'none';
  let input = '';
  if (q.inputType === 'multiline') {
    input = `<label class="sr-only" for="in-${q.id}">Answer to question ${num}</label>
      <textarea class="textarea" id="in-${q.id}" data-qid="${q.id}" rows="5"
        placeholder="Write your answer here"></textarea>`;
  } else if (q.inputType === 'number') {
    input = `<label class="sr-only" for="in-${q.id}">Answer to question ${num}</label>
      <input class="input" id="in-${q.id}" type="number" data-qid="${q.id}"
        inputmode="numeric" placeholder="Your answer" autocomplete="off">`;
  } else if (q.inputType === 'letter') {
    input = `<label class="sr-only" for="in-${q.id}">Answer to question ${num}</label>
      <input class="input" id="in-${q.id}" type="text" maxlength="2" data-qid="${q.id}"
        placeholder="?" autocorrect="off" autocomplete="off"
        oninput="this.value=this.value.toUpperCase()" style="max-width:110px;text-align:center">`;
  } else if (q.inputType !== 'none') {
    input = `<label class="sr-only" for="in-${q.id}">Answer to question ${num}</label>
      <input class="input" id="in-${q.id}" type="text" data-qid="${q.id}"
        placeholder="Your answer" autocomplete="off">`;
  }

  const helper = needsParent
    ? `<p class="helper">${icon('sparkle', 'i i-sm')} A grown up marks this one (${q.marks} ${plural(q.marks)})</p>`
    : '';

  return `<section class="q-card${needsParent ? ' q-card-parent' : ''}">
    <div class="q-top">
      <span class="q-num">Q${num}</span>
      <span class="q-marks">${q.marks} ${plural(q.marks)}</span>
    </div>
    <p class="q-text">${esc(q.text)}</p>
    ${input}${helper}
  </section>`;
}

function collect() {
  app.querySelectorAll('[data-qid]').forEach((el) => {
    answers[el.dataset.qid] = el.value.trim();
  });
}

function prevSection() {
  if (!reviewMode) { collect(); recordSectionTime(); }
  if (sectionIdx > 0) { sectionIdx--; showSection(); }
}

function nextSection() {
  if (!reviewMode) { collect(); recordSectionTime(); }
  sectionIdx++;
  if (sectionIdx < week.sections.length) { showSection(); return; }

  clearInterval(timerId);
  if (reviewMode) { showResults(true); return; }
  submitToServer();
}

/* The marking now happens on the server, where the key for Jev lives and where
   the child's browser cannot influence the result. The page sends the answers
   and is told what was decided. */
async function submitToServer() {
  render(`<div class="center-state">
    <div class="spinner" role="status" aria-label="Marking"></div>
    <h2>Marking</h2>
    <p>Checking the answers</p>
  </div>`);
  try {
    serverResult = await apiSubmit(child, {
      week: week.weekNum,
      answers,
      elapsedSecs: Math.round((Date.now() - startedAt) / 1000),
      sectionSecs,
    });
    sectionMarks = serverResult.sectionMarks;
    // Only what Jev could not settle needs a grown up.
    toMark = Object.entries(serverResult.perQuestion)
      .filter(([, p]) => p.markedBy === 'parent')
      .map(([qid]) => {
        const section = week.sections.find((sec) => sec.questions.some((q) => q.id === qid));
        return { section, q: section.questions.find((q) => q.id === qid), marksAwarded: null };
      });
    markIdx = 0;
    if (toMark.length) showMarkScreen(); else showResults(false);
  } catch (err) {
    render(`<div class="center-state"><div class="error-card">
      ${iconLabelled('alert', 'Error', 'i i-lg')}
      <h2>Could not save the answers</h2><p>${esc(err.message)}</p>
      <p style="font-size:.85rem">Nothing is lost. Tap to try again, and do not close this tab.</p>
      <button class="btn btn-secondary" id="retry-submit">${icon('refresh')} Try again</button>
    </div></div>`);
    const b = document.getElementById('retry-submit');
    if (b) b.addEventListener('click', submitToServer);
  }
}

/* ---------------------------------------------------------- parent marking */

/** Say why this one reached a human, so the choice is informed rather than blind. */
function jevNote(qid) {
  const p = serverResult && serverResult.perQuestion && serverResult.perQuestion[qid];
  if (!p || !p.reason) return '';
  return `<p class="helper" style="color:var(--text-3);margin-top:var(--s3)">
    ${icon('sparkle', 'i i-sm')} Checked automatically first and it was not confident enough to
    decide: ${esc(p.reason)}</p>`;
}

function showMarkScreen() {
  if (markIdx >= toMark.length) { showResults(false); return; }
  const item = toMark[markIdx];
  const { section: sec, q } = item;
  const given = answers[q.id] || '';

  const buttons = Array.from({ length: q.marks + 1 }, (_, i) => `
    <button class="mark-btn" data-award="${i}" aria-pressed="${item.marksAwarded === i}">${i}</button>
  `).join('');

  const scheme = q.markScheme ? `
    <div class="scheme-block">
      <div class="scheme-label">${icon('book', 'i i-sm')} Mark scheme</div>
      <div class="answer-text">${esc(q.markScheme)}</div>
    </div>` : '';

  render(`<div class="page page-narrow" style="padding-top:var(--s6)">
    <div class="review-head">
      <p class="review-step">${icon('clipboard', 'i i-sm')} A grown up decides, ${markIdx + 1} of ${toMark.length}</p>
      <h1>${esc(sec.title)}</h1>
    </div>
    <section class="card">
      <p class="q-text">${esc(q.text)}</p>
      <div class="answer-block">
        <div class="answer-label">${esc(NAME)}'s answer</div>
        <div class="answer-text">${given ? esc(given) : '<em style="color:var(--text-3)">Left blank</em>'}</div>
      </div>
      ${scheme}
      ${jevNote(q.id)}
      <fieldset style="border:0;padding:0;margin:var(--s5) 0 0">
        <legend class="answer-label" style="padding:0">Award marks out of ${q.marks}</legend>
        <div class="mark-buttons">${buttons}</div>
      </fieldset>
    </section>
    <div class="section-nav">
      ${markIdx > 0 ? `<button class="btn btn-secondary" data-nav="back">${icon('arrowLeft')} Back</button>` : ''}
      <button class="btn btn-primary" data-nav="next" ${item.marksAwarded === null ? 'disabled' : ''}>
        ${markIdx + 1 < toMark.length ? 'Next' : 'See results'} ${icon('arrowRight')}
      </button>
    </div>
  </div>`);

  app.querySelectorAll('[data-award]').forEach((b) => b.addEventListener('click', () => {
    toMark[markIdx].marksAwarded = Number(b.dataset.award);
    showMarkScreen();
  }));
  app.querySelector('[data-nav="next"]').addEventListener('click', () => {
    markIdx++;
    if (markIdx >= toMark.length) showResults(false); else showMarkScreen();
  });
  const back = app.querySelector('[data-nav="back"]');
  if (back) back.addEventListener('click', () => { markIdx--; showMarkScreen(); });
}

/* ---------------------------------------------------------------- results */

function showResults(readOnly) {
  let finalMarks;
  if (readOnly && savedEntry && savedEntry.sectionMarks) {
    finalMarks = { ...savedEntry.sectionMarks };
  } else {
    // The server owns the marks. Anything awarded here is added for display and
    // then sent, after which the server recomputes and is the authority.
    finalMarks = { ...sectionMarks };
    toMark.forEach((item) => {
      if (item.marksAwarded !== null) {
        finalMarks[item.section.id] = (finalMarks[item.section.id] || 0) + item.marksAwarded;
      }
    });
  }

  const bySubj = {};
  const maxBySubj = {};
  week.sections.forEach((sec) => {
    bySubj[sec.subject] = (bySubj[sec.subject] || 0) + (finalMarks[sec.id] || 0);
    maxBySubj[sec.subject] = (maxBySubj[sec.subject] || 0) + sec.totalMarks;
  });
  const total = Object.values(bySubj).reduce((a, b) => a + b, 0);
  const maxTotal = Object.values(maxBySubj).reduce((a, b) => a + b, 0);
  const pct = Math.round(total / maxTotal * 100);

  const trophy = pct >= 90 ? '🏆' : pct >= 75 ? '⭐' : pct >= 60 ? '👍' : '💪';
  const msg = pct >= 90 ? 'Outstanding' : pct >= 75 ? 'Great work' : pct >= 60 ? 'Good effort' : 'Keep practising';
  const labels = { english: 'English', maths: 'Maths', thinking: 'Thinking skills' };

  const rows = Object.entries(bySubj).map(([s, m]) => `
    <div class="subj-row">
      <span class="subj-name subj-${s}">${icon(SUBJECT_ICON[s] || 'square', 'i i-sm')}
        <span style="color:var(--text)">${labels[s] || esc(s)}</span></span>
      <span class="subj-marks">${m} / ${maxBySubj[s]}</span>
    </div>`).join('');

  const footer = readOnly
    ? `<button class="btn btn-secondary" data-act="home">${icon('arrowLeft')} Back to the start</button>`
    : `<div class="save-status" id="save-status" role="status" aria-live="polite">
         ${icon('save', 'i i-sm')} <span id="save-text">Saving</span>
       </div>
       <button class="btn btn-secondary" id="retry-btn" style="display:none">
         ${icon('refresh')} Try saving again
       </button>`;

  render(`<div class="page page-narrow">
    <div class="results">
      ${readOnly ? `<p class="review-step">${icon('eye', 'i i-sm')} Saved results for week ${week.weekNum}</p>` : ''}
      <div class="trophy" role="img" aria-label="${msg}">${trophy}</div>
      <h1>${msg}</h1>
      <div class="total-score">${total} / ${maxTotal}</div>
      <div class="pct-track" role="img" aria-label="${pct} percent">
        <div class="pct-fill" id="pct-fill"></div>
      </div>
      <div class="subj-rows">${rows}</div>
      ${wrongAnswers(readOnly)}
      ${footer}
    </div>
  </div>`);

  requestAnimationFrame(() => {
    const fill = document.getElementById('pct-fill');
    if (fill) fill.style.width = `${pct}%`;
  });

  const home = app.querySelector('[data-act="home"]');
  if (home) home.addEventListener('click', showWelcome);

  if (!readOnly) sendAwards();
}

/** The answers are already saved. This only sends the marks a grown up awarded
    for the few Jev referred. */
async function sendAwards() {
  const box = document.getElementById('save-status');
  const text = document.getElementById('save-text');
  const retry = document.getElementById('retry-btn');
  if (retry) retry.style.display = 'none';

  const awards = {};
  toMark.forEach((item) => {
    if (item.marksAwarded !== null) awards[item.q.id] = item.marksAwarded;
  });

  if (!Object.keys(awards).length) {
    if (box) box.className = 'save-status is-ok';
    if (text) {
      text.textContent = serverResult
        ? `Week ${week.weekNum} saved. ${serverResult.askedJev} answer${serverResult.askedJev === 1 ? '' : 's'} were checked for meaning.`
        : `Week ${week.weekNum} saved.`;
    }
    return;
  }

  if (text) text.textContent = 'Saving the marks you awarded';
  try {
    const r = await apiAward(child, awards);
    if (box) box.className = 'save-status is-ok';
    if (text) text.textContent = `Week ${week.weekNum} saved, ${r.total} out of ${r.outOf}. Check the dashboard.`;
  } catch (err) {
    if (box) box.className = 'save-status is-bad';
    if (text) text.textContent = `The answers are saved, but the marks you awarded did not go through (${err.message}).`;
    if (retry) {
      retry.style.display = 'inline-flex';
      retry.onclick = sendAwards;
    }
  }
}

function wrongAnswers(readOnly) {
  const ans = readOnly && savedEntry ? { ...(savedEntry.archive || {}) } : answers;
  // Whichever way this screen was reached, the verdicts come from the server:
  // the submit response when the week was just sat, the stored rows when it is
  // being reviewed later.
  const verdicts = (readOnly && savedEntry)
    ? (savedEntry.perQuestion || {})
    : ((serverResult && serverResult.perQuestion) || {});
  const items = [];

  week.sections.forEach((sec) => {
    sec.questions.forEach((q) => {
      if (q.inputType === 'none') return;
      const given = (ans[q.id] || '').trim();
      const verdict = verdicts[q.id];

      // No verdict means the server has no row for this question, so there is
      // nothing to report either way. Guessing one in the browser is how the
      // page and the database came to disagree.
      if (!verdict) return;

      // Show anything that did not get full marks, and say who decided, because
      // "a machine judged your wording" is a different thing from "this did not
      // match the answer".
      const found = readOnly ? null : toMark.find((i) => i.q.id === q.id);
      const finalMarks = (found && found.marksAwarded !== null)
        ? found.marksAwarded : verdict.marks;
      if (finalMarks === null || finalMarks >= q.marks) return;

      items.push({
        type: verdict.markedBy === 'auto' ? 'auto' : 'parent',
        section: sec, q, given, awarded: finalMarks, readOnly,
        markedBy: verdict.markedBy,
        correct: (q.accepted && q.accepted.length) ? q.accepted[0] : (q.markScheme || '-'),
      });
    });
  });

  if (!items.length) {
    return `<div class="wrong-panel"><div class="banner">
      <div class="banner-title">${icon('checkCircle')} Every auto marked question is correct</div>
    </div></div>`;
  }

  const groups = new Map();
  items.forEach((it) => {
    if (!groups.has(it.section.id)) groups.set(it.section.id, { section: it.section, items: [] });
    groups.get(it.section.id).items.push(it);
  });

  const body = [...groups.values()].map(({ section, items: list }) => `
    <div class="wrong-group">
      <h3 class="wrong-group-label">${esc(section.title)}</h3>
      ${list.map((it) => wrongCard(it)).join('')}
    </div>`).join('');

  return `<div class="wrong-panel">
    <h2 style="display:flex;align-items:center;gap:var(--s2)">${icon('search')} Where did the marks go?</h2>
    ${body}
  </div>`;
}

function wrongCard(it) {
  const q = it.q;
  const text = q.text.length > 200 ? `${q.text.slice(0, 197)}…` : q.text;
  const givenCell = `<div>
    <div class="wa-label">${esc(NAME)}'s answer</div>
    <div class="wa-val ${it.given ? 'kid-wrong' : 'kid-blank'}">${
      it.given ? esc(it.given) : 'Left blank'}</div>
  </div>`;

  if (it.type === 'parent') {
    const who = it.markedBy === 'jev' ? 'checked for meaning'
      : it.markedBy === 'parent' ? 'decided by a grown up' : 'parent marked';
    const tag = (!it.readOnly && it.awarded !== null)
      ? `${it.awarded} of ${q.marks} ${plural(q.marks)}, ${who}` : who;
    return `<article class="wrong-card parent-card">
      <span class="badge badge-warn">${icon('sparkle')} ${esc(q.id)} · ${esc(tag)}</span>
      <p class="wrong-q-text">${esc(text)}</p>
      <div class="wrong-grid single">${givenCell}</div>
      <div style="margin-top:var(--s3)">
        <div class="wa-label">Mark scheme</div>
        <div class="wa-val scheme">${esc(q.markScheme || '-')}</div>
      </div>
    </article>`;
  }

  return `<article class="wrong-card">
    <span class="badge badge-bad">${icon('cross')} ${esc(q.id)}</span>
    <p class="wrong-q-text">${esc(text)}</p>
    <div class="wrong-grid">
      ${givenCell}
      <div>
        <div class="wa-label">Correct answer</div>
        <div class="wa-val correct">${esc(it.correct)}</div>
      </div>
    </div>
  </article>`;
}

initTheme();
init();

/* The weekly worksheet, one child per page.

   Flow: welcome -> one screen per section -> parent marks the written answers
   -> results, which save themselves. A week already submitted can be reopened
   read only from the welcome screen. */

import { CHILDREN, currentChild } from './config.js';
import { apiWeek, apiSubmit, apiAward } from './store.js';
import { icon, iconLabelled, SUBJECT_ICON } from './icons.js';
import { loadDraft, saveDraft, clearDraft, draftAnswered } from './draft.js';

const child = currentChild();
const PROFILE = CHILDREN[child];
const NAME = PROFILE.name;

const app = document.getElementById('app');
const render = (html) => { app.innerHTML = html; app.scrollTop = 0; window.scrollTo(0, 0); };
const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const plural = (n) => (n === 1 ? 'mark' : 'marks');

/* A child reads motion before words, so the worksheet leans on it. Anyone who
   has asked their system for less of it gets none: this is the one switch the
   decorative animations are checked against, and it is read live rather than
   captured, so changing the system setting mid week is honoured. */
const calmly = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

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
let draft = null;               // this browser's unfinished attempt, if any
let savedMsg = '';             // what the last successful save said, kept across a re-render
let typingTimer = null;        // debounce for the save while typing
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
    if (savedEntry) clearDraft(child, week.weekNum);
    draft = savedEntry ? null : loadDraft(child, week.weekNum);
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

  const chips = week.sections.map((s, i) => `
    <li class="section-chip" style="--i:${i}">
      <span class="subj-${s.subject}">${icon(SUBJECT_ICON[s.subject] || 'square', 'i i-sm')}</span>
      <span>${esc(s.title)}</span>
      <span class="chip-marks">${s.totalMarks} ${plural(s.totalMarks)}</span>
    </li>`).join('');

  let banner = '';
  let pending = 0;
  if (savedEntry) {
    const pct = Math.round(savedEntry.total / savedEntry.outOf * 100);
    const marks = savedEntry.sectionMarks || {};
    const bySubject = {};
    week.sections.forEach((sec) => {
      bySubject[sec.subject] = (bySubject[sec.subject] || 0) + (marks[sec.id] || 0);
    });
    const parts = Object.entries(bySubject)
      .map(([s, m]) => `${m} ${s}`).join(' · ');
    // How many answers the server referred and nobody has marked. Until they
    // are marked the total is short by whatever they are worth, so the banner
    // says so rather than presenting an unfinished score as the score.
    const waiting = pendingQuestions();
    const atStake = waiting.reduce((t, i) => t + (i.section.scoreBand ? 0 : i.q.marks), 0);
    banner = `<div class="banner">
      <div class="banner-title">${icon('checkCircle')} Week ${savedEntry.week} already submitted</div>
      <div class="banner-score">${savedEntry.total} / ${savedEntry.outOf} <span style="font-size:.9rem;font-weight:400">(${pct}%)</span></div>
      <div class="banner-sub">${esc(parts)}</div>
      ${waiting.length ? `<div class="banner-sub" style="margin-top:var(--s2);color:var(--warn);font-weight:700">
        ${icon('clock', 'i i-sm')} ${waiting.length} ${waiting.length === 1 ? 'answer' : 'answers'} still to mark, worth up to ${atStake} ${plural(atStake)}
      </div>` : ''}
    </div>`;
    pending = waiting.length;
  }

  const answered = draftAnswered(draft);

  let actions;
  if (savedEntry) {
    actions = `<div class="welcome-actions">
         ${pending ? `<button class="btn btn-primary btn-lg" data-act="mark-rest">
           ${icon('clipboard')} Mark the last ${pending} ${pending === 1 ? 'answer' : 'answers'}
         </button>` : ''}
         <button class="btn ${pending ? 'btn-secondary' : 'btn-primary btn-lg'}" data-act="review">${icon('eye')} Review ${esc(NAME)}'s answers</button>
         <button class="btn btn-secondary" data-act="fresh">Start again with a blank sheet</button>
       </div>`;
  } else if (answered) {
    const where = week.sections[draft.sectionIdx] || week.sections[0];
    actions = `<div class="banner banner-draft">
         <div class="banner-title">${icon('checkCircle')} Saved on this device</div>
         <div class="banner-sub">${answered} ${answered === 1 ? 'answer' : 'answers'} kept, up to ${esc(where.title)}. Nothing has been marked yet.</div>
       </div>
       <div class="welcome-actions">
         <button class="btn btn-primary btn-lg" data-act="resume">${icon('play')} Carry on where ${esc(NAME)} left off</button>
         <button class="btn btn-secondary" data-act="fresh">Start again with a blank sheet</button>
       </div>`;
  } else {
    actions = `<div class="welcome-actions">
         <button class="btn btn-primary btn-lg" data-act="fresh">${icon('play')} Start homework</button>
       </div>`;
  }

  render(`<div class="page page-narrow"><div class="welcome">
    <div class="welcome-mark">${icon(PROFILE.icon, 'i')}</div>
    <h1>${esc(NAME)}'s homework</h1>
    <div class="week-badge">Week ${week.weekNum}</div>
    <p class="welcome-meta">${week.sections.length} sections, ${total} marks to collect</p>
    <ul class="section-chips" style="list-style:none;padding:0;margin:0">${chips}</ul>
    ${banner}
    ${actions}
  </div></div>`);

  app.querySelector('[data-act="fresh"]').addEventListener('click', startFresh);
  const rev = app.querySelector('[data-act="review"]');
  if (rev) rev.addEventListener('click', startReview);
  const res = app.querySelector('[data-act="resume"]');
  if (res) res.addEventListener('click', resumeDraft);
  const rest = app.querySelector('[data-act="mark-rest"]');
  if (rest) rest.addEventListener('click', markPending);
}

function startReview() {
  reviewMode = true;
  answers = { ...(savedEntry.archive || {}) };
  sectionMarks = { ...(savedEntry.sectionMarks || {}) };
  sectionIdx = 0;
  showSection();
}

function startFresh() {
  // A submitted week is marked and possibly awarded. Starting again replaces all
  // of it, so ask first: one stray tap used to be enough.
  if (savedEntry && !confirm(
    `Week ${savedEntry.week} is already marked. Starting again will replace its marks `
    + 'with the new attempt. Are you sure?')) return;
  reviewMode = false;
  answers = {};
  sectionMarks = {};
  toMark = [];
  sectionIdx = 0;
  Object.keys(sectionSecs).forEach((k) => delete sectionSecs[k]);
  draft = null;
  clearDraft(child, week.weekNum);
  showSection();
}

/* Pick the week back up from what this browser saved. Only the typing and the
   place in the sheet come back: nothing has been marked, so there is no score
   to restore. */
function resumeDraft() {
  reviewMode = false;
  answers = { ...draft.answers };
  sectionMarks = {};
  toMark = [];
  Object.assign(sectionSecs, draft.sectionSecs);
  sectionIdx = Math.min(draft.sectionIdx, week.sections.length - 1);
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
      ${stepDots(count)}
      ${reviewMode ? `<div class="mode-bar">${icon('eye')} Reviewing saved answers for week ${week.weekNum}</div>` : ''}
      <div class="section-top">
        <span class="section-count">Section ${sectionIdx + 1} of ${count}</span>
        <span class="chip-subject subj-${sec.subject}">
          ${icon(SUBJECT_ICON[sec.subject] || 'square', 'i i-sm')} ${esc(sec.subject)}
        </span>
      </div>
      <h1>${esc(sec.title)}</h1>
      <div class="section-meta">${meta}</div>
      ${reviewMode ? '' : `<div class="answered-chip" id="answered" role="status" aria-live="polite"></div>`}
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

  if (!reviewMode) {
    // Save a second after the typing stops, so a closed tab or a flat battery
    // mid section loses nothing. The listeners go with the next render.
    clearTimeout(typingTimer);
    app.querySelectorAll('[data-qid]').forEach((el) => {
      el.addEventListener('input', () => {
        clearTimeout(typingTimer);
        typingTimer = setTimeout(collect, 1000);
      });
    });
    app.querySelectorAll('[data-qid]').forEach((el) => {
      el.addEventListener('input', updateAnswered);
    });
    updateAnswered();
    sectionStarted = Date.now();
    startTimer(sec);
  }
}

/* Where the child is in the week, as dots rather than a number. The thin bar
   above already carries the progressbar role, so these are decoration and are
   hidden from screen readers to avoid saying the same thing twice. */
function stepDots(count) {
  const dots = Array.from({ length: count }, (_, i) => {
    const cls = i < sectionIdx ? 'step-dot is-done' : i === sectionIdx ? 'step-dot is-now' : 'step-dot';
    return `<span class="${cls}"></span>`;
  }).join('');
  return `<div class="step-dots" aria-hidden="true">${dots}</div>`;
}

/* How many boxes have something in them. Deliberately NOT how many are right:
   nothing is marked until the week is submitted, and telling a child "4 correct"
   before the server has seen it would be a lie they would believe. */
function updateAnswered() {
  const box = document.getElementById('answered');
  if (!box) return;
  const fields = [...app.querySelectorAll('[data-qid]')];
  if (!fields.length) { box.hidden = true; return; }
  box.hidden = false;
  const done = fields.filter((el) => el.value.trim() !== '').length;
  const full = done === fields.length;
  box.className = full ? 'answered-chip is-full' : 'answered-chip';
  box.innerHTML = `${icon(full ? 'checkCircle' : 'pencil', 'i i-sm')} ${
    full ? `All ${fields.length} answered` : `${done} of ${fields.length} answered`}`;
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
      const items = grid.map((q, gi) => {
        const word = q.text
          .replace(/^Write S, M or P for:\s*/i, '')
          .replace(/^Write N or V for( the word)?:\s*/i, '');
        return `<div class="letter-item" style="--i:${gi}">
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
        return `<div class="number-item" style="--i:${i}">
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

  return `<section class="q-card${needsParent ? ' q-card-parent' : ''}" style="--i:${num - 1}">
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
  if (!reviewMode) {
    saveDraft(child, week.weekNum, { answers, sectionIdx, sectionSecs });
  }
}

function prevSection() {
  clearTimeout(typingTimer);
  if (!reviewMode) { collect(); recordSectionTime(); }
  if (sectionIdx > 0) {
    sectionIdx--;
    if (!reviewMode) saveDraft(child, week.weekNum, { answers, sectionIdx, sectionSecs });
    showSection();
  }
}

function nextSection() {
  clearTimeout(typingTimer);
  if (!reviewMode) { collect(); recordSectionTime(); }
  sectionIdx++;
  if (sectionIdx < week.sections.length) {
    if (!reviewMode) saveDraft(child, week.weekNum, { answers, sectionIdx, sectionSecs });
    showSection();
    return;
  }

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
      resit: !!savedEntry,
      elapsedSecs: Math.round((Date.now() - startedAt) / 1000),
      sectionSecs,
    });
    clearDraft(child, week.weekNum);
    draft = null;
    // The sheet was loaded without its key. Now that it is submitted the server
    // will hand the key over, and the marking screen needs the mark schemes.
    try { week = (await apiWeek(child)).questions; } catch { /* the screens degrade without a scheme */ }
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
  const p = verdicts()[qid];
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

/* Whichever way this screen was reached, the verdicts come from the server: the
   submit response when the week was just sat, the stored rows when it is being
   reviewed later. The browser never decides a mark. */
function verdicts() {
  if (serverResult && serverResult.perQuestion) return serverResult.perQuestion;
  return (savedEntry && savedEntry.perQuestion) || {};
}

function givenAnswers() {
  if (Object.keys(answers).length) return answers;
  return (savedEntry && savedEntry.archive) || {};
}

/** Every question the server could not settle and nobody has awarded yet.

    These are worth marks that are neither won nor lost. Leaving them out of the
    arithmetic is exactly what made the score and the list of wrong answers
    disagree: week 24 showed 18 marks missing and explained 6 of them. */
function pendingQuestions() {
  const v = verdicts();
  const out = [];
  week.sections.forEach((sec) => sec.questions.forEach((q) => {
    if (q.inputType === 'none') return;
    const p = v[q.id];
    if (p && p.marks === null) out.push({ section: sec, q, marksAwarded: null });
  }));
  return out;
}

/* A drill is banded on the count correct, so one wrong item inside it can cost
   nothing at all. Recomputed with the same rules the Worker uses, and only
   where a grown up has just awarded something in that section: everywhere else
   the stored band stands. */
function bandFor(sec, awarded) {
  const v = verdicts();
  const items = sec.questions.filter((q) => q.autoMark);
  const correct = items.filter((q) => {
    if (q.id in awarded) return awarded[q.id] > 0;
    const p = v[q.id];
    return p && p.correct === 1;
  }).length;
  let marks = 0;
  for (const [lo, hi, m] of sec.scoreBandRules || []) {
    if (correct >= lo && correct <= hi) { marks = m; break; }
  }
  return { marks, correct, outOf: items.length };
}

/**
 * One pass over the week that produces every number the results screen shows.
 *
 * The score and the list of wrong answers used to be worked out separately and
 * they disagreed. A question the server referred to a grown up has a mark of
 * null: the total counted those marks as missing, and the list then skipped the
 * question, because it tested for a LOW mark rather than for no mark at all. A
 * wrong item inside a drill was the same mistake the other way round, listed as
 * a loss when the band had already given the section full marks.
 *
 * Both now come from here, and `missing` has to equal the four strands that
 * follow it. Anything left over is reported as not traced rather than hidden,
 * because a page that quietly swallows a mark is how this was missed for a week.
 */
function ledger(readOnly) {
  const v = verdicts();
  const ans = givenAnswers();
  const awarded = {};
  toMark.forEach((i) => { if (i.marksAwarded !== null) awarded[i.q.id] = i.marksAwarded; });

  const base = (readOnly && savedEntry && savedEntry.sectionMarks)
    ? { ...savedEntry.sectionMarks } : { ...sectionMarks };

  const items = [];
  const sections = [];
  let pendingMarks = 0;
  let decidedLost = 0;
  let bandLost = 0;

  week.sections.forEach((sec) => {
    const touched = sec.questions.some((q) => q.id in awarded);
    let marks = base[sec.id] || 0;
    let band = null;
    if (sec.scoreBand) {
      band = bandFor(sec, awarded);
      if (touched) marks = band.marks;
    } else if (touched) {
      sec.questions.forEach((q) => { if (q.id in awarded) marks += awarded[q.id]; });
    }

    sec.questions.forEach((q) => {
      if (q.inputType === 'none') return;
      const p = v[q.id];
      // No verdict means the server has no row for this question, so there is
      // nothing to report either way. Guessing one in the browser is how the
      // page and the database came to disagree in the first place.
      if (!p) return;
      const mk = (q.id in awarded) ? awarded[q.id] : p.marks;
      if (mk !== null && mk >= q.marks) return;

      const common = {
        section: sec, q, readOnly,
        given: String(ans[q.id] == null ? '' : ans[q.id]).trim(),
        markedBy: (q.id in awarded) ? 'parent' : p.markedBy,
        reason: p.reason || '',
        correct: (q.accepted && q.accepted.length) ? q.accepted[0] : (q.markScheme || '-'),
      };

      if (mk === null) {
        // Inside a drill the marks ride on the band, so a pending item is worth
        // nothing on its own and must not be counted twice.
        const atStake = sec.scoreBand ? 0 : q.marks;
        pendingMarks += atStake;
        items.push({ ...common, kind: 'pending', awarded: null, lost: 0, atStake });
      } else if (sec.scoreBand) {
        items.push({ ...common, kind: 'slip', awarded: mk, lost: 0, atStake: 0 });
      } else {
        decidedLost += q.marks - mk;
        items.push({ ...common, kind: 'lost', awarded: mk, lost: q.marks - mk, atStake: 0 });
      }
    });

    if (sec.scoreBand) bandLost += sec.totalMarks - marks;
    sections.push({ sec, marks, band });
  });

  const bySubj = {};
  const maxBySubj = {};
  sections.forEach(({ sec, marks }) => {
    bySubj[sec.subject] = (bySubj[sec.subject] || 0) + marks;
    maxBySubj[sec.subject] = (maxBySubj[sec.subject] || 0) + sec.totalMarks;
  });

  const total = sections.reduce((t, s) => t + s.marks, 0);
  const maxTotal = week.sections.reduce((t, s) => t + s.totalMarks, 0);
  const missing = maxTotal - total;
  const pendingCount = items.filter((i) => i.kind === 'pending').length;

  return {
    items, sections, bySubj, maxBySubj, total, maxTotal, missing,
    pendingMarks, decidedLost, bandLost, pendingCount,
    untraced: missing - pendingMarks - decidedLost - bandLost,
  };
}

/* One line of plain praise under the score, keyed off the same bands as the
   trophy so the picture and the words never disagree. */
function cheer(pct) {
  if (pct >= 95) return 'Almost every single one. That is a brilliant week.';
  if (pct >= 90) return 'A really strong week. Go and tell someone.';
  if (pct >= 75) return 'Lots right and a few to look at together.';
  if (pct >= 60) return 'A solid go. The ones below are the ones worth a second look.';
  return 'Hard sections this week. Walk through the ones below with a grown up.';
}

/* The score counts itself up, which gives the number a moment of its own
   instead of just appearing. The element keeps tabular figures, so nothing
   reflows as the digits change. */
function countUp(total, maxTotal) {
  const el = document.getElementById('total-score');
  if (!el || calmly() || total === 0) return;
  const dur = 700;
  const t0 = performance.now();
  const tick = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    const eased = 1 - (1 - p) ** 3;
    el.textContent = `${Math.round(total * eased)} / ${maxTotal}`;
    if (p < 1) requestAnimationFrame(tick);
  };
  el.textContent = `0 / ${maxTotal}`;
  requestAnimationFrame(tick);
}

/* Decoration, and nothing but: aria-hidden, built only above 75 percent, and
   skipped entirely for anyone who asked for less motion. The CSS hides it too,
   so a setting changed after the page loaded still wins. */
function confetti() {
  if (calmly()) return '';
  const colours = ['--play-1', '--play-2', '--play-3', '--play-4', '--play-5', '--play-6'];
  const bits = Array.from({ length: 26 }, (_, i) => {
    const left = Math.round(i / 26 * 100 + (Math.random() * 6 - 3));
    const style = [
      `left:${Math.max(0, Math.min(98, left))}%`,
      `--c:var(${colours[i % colours.length]})`,
      `--dx:${Math.round(Math.random() * 80 - 40)}px`,
      `--spin:${Math.round(360 + Math.random() * 720)}deg`,
      `--dur:${(1.8 + Math.random() * 1.6).toFixed(2)}s`,
      `--delay:${(Math.random() * 0.5).toFixed(2)}s`,
    ].join(';');
    return `<i style="${style}"></i>`;
  }).join('');
  return `<div class="confetti" aria-hidden="true">${bits}</div>`;
}

function showResults(readOnly) {
  const L = ledger(readOnly);
  // A week with answers still waiting on a grown up has no final score yet, so
  // it does not get a verdict, a percentage band or confetti. Saying "good
  // effort, 37 of 55" over a sheet that is 12 marks short of being marked is
  // the page telling the child something untrue.
  const open = L.pendingCount > 0;
  const pct = Math.round(L.total / L.maxTotal * 100);

  const trophy = open ? '📝' : pct >= 90 ? '🏆' : pct >= 75 ? '⭐' : pct >= 60 ? '👍' : '💪';
  const msg = open ? 'Nearly marked'
    : pct >= 90 ? 'Outstanding' : pct >= 75 ? 'Great work' : pct >= 60 ? 'Good effort' : 'Keep practising';
  const line = open
    ? `${L.pendingCount} ${L.pendingCount === 1 ? 'answer' : 'answers'} still need a grown up, worth up to ${L.pendingMarks} ${plural(L.pendingMarks)}. Everything else is marked.`
    : cheer(pct);
  const labels = { english: 'English', maths: 'Maths', thinking: 'Thinking skills' };

  const rows = Object.entries(L.bySubj).map(([s, m], i) => `
    <div class="subj-row" style="--i:${i}">
      <span class="subj-name subj-${s}">${icon(SUBJECT_ICON[s] || 'square', 'i i-sm')}
        <span style="color:var(--text)">${labels[s] || esc(s)}</span></span>
      <span class="subj-marks">${m} / ${L.maxBySubj[s]}</span>
    </div>`).join('');

  const markRest = open
    ? `<button class="btn btn-primary btn-lg" data-act="mark-rest">
         ${icon('clipboard')} Mark the last ${L.pendingCount} ${L.pendingCount === 1 ? 'answer' : 'answers'}
       </button>`
    : '';

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
      ${!open && pct >= 75 ? confetti() : ''}
      ${readOnly ? `<p class="review-step">${icon(savedMsg ? 'checkCircle' : 'eye', 'i i-sm')} ${
        esc(savedMsg || `Saved results for week ${week.weekNum}`)}</p>` : ''}
      <div class="trophy" role="img" aria-label="${msg}">${trophy}</div>
      <h1>${msg}</h1>
      <div class="total-score" id="total-score">${L.total} / ${L.maxTotal}</div>
      ${open ? `<p class="score-note">${icon('clock', 'i i-sm')} marked so far</p>` : ''}
      <p class="cheer">${esc(line)}</p>
      <div class="pct-track" role="img" aria-label="${pct} percent">
        <div class="pct-fill" id="pct-fill"></div>
      </div>
      <div class="subj-rows">${rows}</div>
      ${markRest}
      ${marksPanel(L)}
      ${footer}
    </div>
  </div>`);

  requestAnimationFrame(() => {
    const fill = document.getElementById('pct-fill');
    if (fill) fill.style.width = `${pct}%`;
  });
  countUp(L.total, L.maxTotal);

  const home = app.querySelector('[data-act="home"]');
  if (home) home.addEventListener('click', showWelcome);
  const rest = app.querySelector('[data-act="mark-rest"]');
  if (rest) rest.addEventListener('click', markPending);

  // Only the live path has awards of its own to send. Review mode saves when a
  // grown up finishes the marking, not every time the screen is opened.
  if (!readOnly) sendAwards();
}

/** Pick up the questions the server referred and never got an answer for.
    Reachable from the welcome screen and from the results, because the marking
    screen is easy to walk away from and those marks are then stuck: week 24
    sat at 37 of 55 with seven answers nobody had looked at. */
function markPending() {
  const pending = pendingQuestions();
  if (!pending.length) { showResults(true); return; }
  if (!Object.keys(answers).length) answers = { ...((savedEntry && savedEntry.archive) || {}) };
  if (!Object.keys(sectionMarks).length) {
    sectionMarks = { ...((savedEntry && savedEntry.sectionMarks) || {}) };
  }
  toMark = pending;
  markIdx = 0;
  showMarkScreen();
}

/** The answers are already saved. This only sends the marks a grown up awarded
    for the few that were referred. */
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
    // The server recomputed the totals from its own rows, so the page takes
    // them rather than keeping its own running sum. A drill band can move when
    // a referred drill item is awarded, and the server is the authority on it.
    // Re-rendering from the server's numbers is also what makes the screen
    // settle on a finished score, with the trophy and the ledger agreeing.
    if (r && r.sectionMarks) {
      const merged = { ...verdicts() };
      Object.entries(awards).forEach(([qid, m]) => {
        merged[qid] = { marks: m, correct: m > 0 ? 1 : 0, markedBy: 'parent' };
      });
      savedEntry = {
        week: week.weekNum, total: r.total, outOf: r.outOf,
        sectionMarks: { ...r.sectionMarks },
        archive: { ...givenAnswers() },
        perQuestion: merged,
      };
      serverResult = null;
      sectionMarks = { ...r.sectionMarks };
      toMark = [];
      markIdx = 0;
      reviewMode = true;
      savedMsg = `Week ${week.weekNum} saved, ${r.total} out of ${r.outOf}. Check the dashboard.`;
      showResults(true);
    }
  } catch (err) {
    if (box) box.className = 'save-status is-bad';
    if (text) text.textContent = `The answers are saved, but the marks you awarded did not go through (${err.message}).`;
    if (retry) {
      retry.style.display = 'inline-flex';
      retry.onclick = sendAwards;
    }
  }
}

/* Where the marks went, and it has to add up. The ledger is printed above the
   cards on purpose: the list of cards alone never explained the gap between the
   score and the total, which is the whole reason this screen was not trusted. */
function marksPanel(L) {
  if (!L.items.length && !L.missing) {
    return `<div class="wrong-panel"><div class="banner">
      <div class="banner-title">${icon('checkCircle')} Every question is correct</div>
    </div></div>`;
  }

  const strands = [
    [L.decidedLost, 'marked wrong, shown below'],
    [L.pendingMarks, `waiting on ${L.pendingCount} ${L.pendingCount === 1 ? 'answer' : 'answers'} a grown up has to mark`],
    [L.bandLost, 'from the drill band, which scores on how many were right'],
    [L.untraced, 'not traced'],
  ].filter(([n]) => n > 0);

  // One strand on its own just repeats the total, so the breakdown is dropped.
  const ledgerRows = (strands.length < 2 ? [] : strands).map(([n, what]) => `
    <div class="ledger-row">
      <span class="ledger-marks">${n} ${plural(n)}</span>
      <span class="ledger-what">${esc(what)}</span>
    </div>`).join('');

  const summary = `
    <div class="ledger">
      <div class="ledger-row ledger-total">
        <span class="ledger-marks">${L.missing} ${plural(L.missing)}</span>
        <span class="ledger-what">not collected, out of ${L.maxTotal}</span>
      </div>
      ${ledgerRows}
    </div>`;

  // Pending first: those are the marks still in play, and they are the ones a
  // grown up has to act on.
  const order = { pending: 0, lost: 1, slip: 2 };
  const groups = new Map();
  [...L.items].sort((a, b) => order[a.kind] - order[b.kind]).forEach((it) => {
    const key = `${it.kind}:${it.section.id}`;
    if (!groups.has(key)) groups.set(key, { section: it.section, kind: it.kind, items: [] });
    groups.get(key).items.push(it);
  });

  const heading = { pending: 'Waiting for a grown up', lost: 'Lost marks', slip: 'Wrong, but no mark lost' };
  const body = [...groups.values()].map(({ section, kind, items }) => `
    <div class="wrong-group">
      <h3 class="wrong-group-label">${esc(section.title)} · ${esc(heading[kind])}</h3>
      ${items.map((it) => markCard(it)).join('')}
    </div>`).join('');

  return `<div class="wrong-panel">
    <h2 style="display:flex;align-items:center;gap:var(--s2)">${icon('search')} Where did the marks go?</h2>
    ${summary}
    ${body}
  </div>`;
}

function markCard(it) {
  const q = it.q;
  const text = q.text.length > 200 ? `${q.text.slice(0, 197)}…` : q.text;
  const givenCell = `<div>
    <div class="wa-label">${esc(NAME)}'s answer</div>
    <div class="wa-val ${it.given ? 'kid-wrong' : 'kid-blank'}">${
      it.given ? esc(it.given) : 'Left blank'}</div>
  </div>`;
  // A written answer has a mark scheme. An auto marked one only has the key, so
  // the label says which it is rather than calling a single word a scheme.
  const schemeCell = `<div>
    <div class="wa-label">${q.markScheme ? 'Mark scheme' : 'Expected answer'}</div>
    <div class="wa-val scheme">${esc(q.markScheme || it.correct)}</div>
  </div>`;

  if (it.kind === 'pending') {
    const why = it.reason
      ? `<p class="helper" style="color:var(--text-3);margin-top:var(--s3)">${icon('sparkle', 'i i-sm')} ${esc(it.reason)}</p>`
      : '';
    return `<article class="wrong-card pending-card">
      <span class="badge badge-warn">${icon('clock')} ${esc(q.id)} · up to ${it.atStake || q.marks} ${plural(it.atStake || q.marks)} still to decide</span>
      <p class="wrong-q-text">${esc(text)}</p>
      <div class="wrong-grid">${givenCell}${schemeCell}</div>
      ${why}
    </article>`;
  }

  if (it.kind === 'slip') {
    return `<article class="wrong-card slip-card">
      <span class="badge badge-neutral">${icon('cross')} ${esc(q.id)} · no mark lost</span>
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

  // A machine judging the wording is a different thing from an answer that did
  // not match, so the card says which it was and how many marks it cost.
  const who = it.markedBy === 'jev' ? 'checked for meaning'
    : it.markedBy === 'parent' ? 'decided by a grown up' : 'did not match the answer';
  const lost = `${it.lost} ${plural(it.lost)} lost`;
  const written = !q.autoMark || it.markedBy !== 'auto';
  return `<article class="wrong-card ${written ? 'parent-card' : ''}">
    <span class="badge ${written ? 'badge-warn' : 'badge-bad'}">
      ${icon(written ? 'sparkle' : 'cross')} ${esc(q.id)} · ${esc(lost)}, ${esc(who)}</span>
    <p class="wrong-q-text">${esc(text)}</p>
    <div class="wrong-grid${written ? '' : ''}">
      ${givenCell}
      ${written ? schemeCell : `<div>
        <div class="wa-label">Correct answer</div>
        <div class="wa-val correct">${esc(it.correct)}</div>
      </div>`}
    </div>
  </article>`;
}

initTheme();
init();

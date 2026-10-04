/* The homework API.
 *
 * Everything the browser used to do against JSONbin now happens here, which
 * changes three things that mattered:
 *
 *   - no secret reaches the page. The browser gets endpoints that can read this
 *     week and submit this week, and nothing else. Before, the page carried a
 *     key that could overwrite both bins.
 *   - marking happens on the server, so Jev can be used. The child's browser no
 *     longer decides the marks.
 *   - writes are per row, so two children submitting at the same moment cannot
 *     clobber each other. The old read, modify, write dance is gone.
 *
 * Marking order, which is the point of the whole thing:
 *   1. answersMatch, deterministic, free and instant. If it says correct, done.
 *   2. anything it rejects, and every question marked for a grown up, goes to Jev.
 *   3. only what Jev is genuinely unsure about reaches the parent.
 */

import { answersMatch } from '../../assets/marking.js';
import { Jev, markAnswer, scoreWriting } from './jev.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

/* Every timestamp this Worker writes is an ISO 8601 string, because the rows it
   writes are compared against ISO strings. SQLite's own datetime('now') yields
   "2026-10-04 21:32:29" with a space, which sorts BELOW any "...T..." stamp for
   the same instant, so mixing the two makes every comparison wrong in a way
   that looks like it works. */
const nowIso = () => new Date().toISOString();
const isoMinusSecs = (s) => new Date(Date.now() - s * 1000).toISOString();

/* --------------------------------------------------------------------- cors */

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : allowed[0] || '',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (body, request, env, status = 200) => new Response(
  JSON.stringify(body),
  { status, headers: { ...JSON_HEADERS, ...corsHeaders(request, env) } },
);

const fail = (message, request, env, status = 400) => json({ error: message }, request, env, status);

/* --------------------------------------------------------------------- util */

const CHILDREN = ['mason', 'elysia'];
const isChild = (c) => CHILDREN.includes(c);
const slotOf = (id) => String(id).slice(0, 2);

/* An answer arrives as JSON from a browser, so it can be any type. Coerce it to
   a string rather than trusting it: `(5).trim` is not a function, and before
   this a numeric answer took the whole submission down with a 500. */
const ANSWER_MAX = 4000;
const asAnswer = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return '';
  return String(v).slice(0, ANSWER_MAX).trim();
};

/** Every question in the week, by id. Built once: finding each one with a
    flatMap().find() per question made submit quadratic in the question count. */
const indexQuestions = (set) => Object.fromEntries(
  set.sections.flatMap((s) => s.questions.map((q) => [q.id, q])),
);

async function audit(env, actor, action, child, week, detail) {
  try {
    await env.DB.prepare(
      'INSERT INTO audit (actor, action, child_id, week, detail, at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(actor, action, child || null, week ?? null,
      detail ? String(detail).slice(0, 500) : null, nowIso()).run();
  } catch {
    /* an audit failure must never fail the request it is recording */
  }
}

/* ------------------------------------------------------------------ reading */

async function getQuestionSet(env, child, week) {
  const row = await env.DB.prepare(
    'SELECT payload FROM question_set WHERE child_id = ? AND week = ?',
  ).bind(child, week).first();
  return row ? JSON.parse(row.payload) : null;
}

async function getCurrentWeek(env, child) {
  const row = await env.DB.prepare('SELECT current_week FROM child WHERE id = ?')
    .bind(child).first();
  return row ? row.current_week : null;
}

/** What the worksheet needs to start: the questions, and whether this week was
    already submitted. The answers come back too, so Review mode works. */
async function handleWeek(request, env, child) {
  const week = await getCurrentWeek(env, child);
  if (!week) return fail(`no week set up for ${child}`, request, env, 404);

  const set = await getQuestionSet(env, child, week);
  if (!set) return fail(`no questions stored for ${child} week ${week}`, request, env, 404);

  const row = await env.DB.prepare(
    'SELECT total, out_of, submitted_at FROM week WHERE child_id = ? AND week = ? AND submitted_at IS NOT NULL',
  ).bind(child, week).first();

  let submitted = null;
  if (row) {
    const marks = await env.DB.prepare(
      'SELECT section_id, marks FROM section_mark WHERE child_id = ? AND week = ?',
    ).bind(child, week).all();
    const answers = await env.DB.prepare(
      'SELECT question_id, given, marks, correct, marked_by FROM answer WHERE child_id = ? AND week = ?',
    ).bind(child, week).all();
    submitted = {
      total: row.total,
      outOf: row.out_of,
      submittedAt: row.submitted_at,
      sectionMarks: Object.fromEntries(marks.results.map((r) => [r.section_id, r.marks])),
      answers: Object.fromEntries(answers.results.map((r) => [r.question_id, r.given])),
      perQuestion: Object.fromEntries(answers.results.map((r) => [r.question_id, {
        marks: r.marks, correct: r.correct, markedBy: r.marked_by,
      }])),
    };
  }

  return json({ child, week, questions: set, submitted }, request, env);
}

/* ------------------------------------------------------------------ marking */

/**
 * Mark one week's answers.
 *
 * Deterministic first because it is free, instant and already correct on every
 * accepted answer. Jev only sees what it could not settle, which is a small
 * handful per week.
 */
async function markWeek(child, set, answers, jev) {
  const perQuestion = {};
  const toAsk = [];

  for (const section of set.sections) {
    for (const q of section.questions) {
      if (q.inputType === 'none') continue;
      const given = asAnswer(answers[q.id]);

      if (q.autoMark && answersMatch(given, q.accepted, q.inputType)) {
        perQuestion[q.id] = {
          marks: q.marks, correct: 1, markedBy: 'auto', confidence: 1,
          reason: 'matched the accepted list',
        };
        continue;
      }

      // A letter drill is a closed set: there is no meaning for Jev to judge, so
      // asking would only add latency and a chance of being wrong.
      if (q.inputType === 'letter') {
        perQuestion[q.id] = {
          marks: 0, correct: 0, markedBy: 'auto', confidence: 1,
          reason: 'letter answers are an exact set',
        };
        continue;
      }

      // A blank is a blank. Nothing to judge.
      if (!given) {
        perQuestion[q.id] = {
          marks: 0, correct: 0, markedBy: 'auto', confidence: 1, reason: 'left blank',
        };
        continue;
      }

      // Everything else goes to Jev: the auto marked ones it rejected, and every
      // question that used to go straight to the parent.
      toAsk.push({ section, q, given });
    }
  }

  // Run them together. Jev is 70 to 500ms each, so ten of them concurrently is
  // well under a second.
  const judged = await Promise.all(toAsk.map(async ({ section, q, given }) => {
    try {
      const r = await markAnswer(jev, { child, question: q, given });
      return { q, section, given, r };
    } catch (err) {
      return { q, section, given, r: { outcome: 'refer', marks: null, confidence: 0, reason: `Jev unavailable: ${err.message}` } };
    }
  }));

  for (const { q, r } of judged) {
    perQuestion[q.id] = {
      marks: r.outcome === 'refer' ? null : r.marks,
      correct: r.outcome === 'refer' ? null : (r.marks > 0 ? 1 : 0),
      markedBy: r.outcome === 'refer' ? 'parent' : 'jev',
      confidence: r.confidence,
      reason: r.reason,
    };
  }

  // Section totals. A drill is banded on the count correct, not the sum.
  const sectionMarks = {};
  const sectionOutOf = {};

  for (const section of set.sections) {
    sectionOutOf[section.id] = section.totalMarks;
    if (section.scoreBand) {
      const correct = section.questions.filter(
        (q) => q.autoMark && perQuestion[q.id] && perQuestion[q.id].correct === 1,
      ).length;
      let band = 0;
      for (const [lo, hi, marks] of section.scoreBandRules || []) {
        if (correct >= lo && correct <= hi) { band = marks; break; }
      }
      sectionMarks[section.id] = band;
      continue;
    }
    let earned = 0;
    for (const q of section.questions) {
      const p = perQuestion[q.id];
      if (!p || p.marks === null) continue;
      earned += p.marks;
    }
    sectionMarks[section.id] = earned;
  }

  // Count every referral, wherever it sits. Counting only the non-drill
  // sections meant a referred drill item created a decision row for the parent
  // while telling the page nothing was waiting, so the page skipped the marking
  // screen and the decision was never answered.
  const needsParent = Object.values(perQuestion).filter((p) => p.marks === null).length;

  const total = Object.values(sectionMarks).reduce((a, b) => a + b, 0);
  const outOf = Object.values(sectionOutOf).reduce((a, b) => a + b, 0);
  return { perQuestion, sectionMarks, sectionOutOf, total, outOf, needsParent, askedJev: toAsk.length };
}

/* ---------------------------------------------------------------- submitting */

async function handleSubmit(request, env, child, ctx) {
  const week = await getCurrentWeek(env, child);
  if (!week) return fail(`no week set up for ${child}`, request, env, 404);

  let body;
  try {
    body = await request.json();
  } catch {
    return fail('body must be JSON', request, env);
  }
  const answers = body && body.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return fail('answers object required', request, env);
  }
  if (Object.keys(answers).length > 400) return fail('too many answers', request, env, 413);

  // Only ever the current week, so a stale or crafted request cannot rewrite history.
  if (body.week != null && Number(body.week) !== week) {
    return fail(`this week is ${week}, not ${body.week}`, request, env, 409);
  }

  // A second submission within a minute is almost certainly a double tap.
  //
  // The cutoff is computed here rather than with datetime('now', '-60 seconds'),
  // which produced a space separated stamp. Compared as text against the ISO
  // stamps this Worker stores, the 'T' at index 10 always sorted above a space,
  // so the guard matched every past submission and the real behaviour was the
  // opposite of a 60 second window.
  const recent = await env.DB.prepare(
    'SELECT submitted_at FROM week WHERE child_id = ? AND week = ? AND submitted_at > ?',
  ).bind(child, week, isoMinusSecs(60)).first();
  if (recent) return fail('that week was just submitted, try again in a minute', request, env, 429);

  const set = await getQuestionSet(env, child, week);
  if (!set) return fail(`no questions stored for ${child} week ${week}`, request, env, 404);

  const jev = new Jev(env.JEV_API_KEY);
  const marked = await markWeek(child, set, answers, jev);
  const byId = indexQuestions(set);

  const stamp = nowIso();
  const elapsed = Number.isFinite(body.elapsedSecs) ? Math.round(body.elapsedSecs) : null;
  const sectionTimes = (body.sectionSecs && typeof body.sectionSecs === 'object')
    ? body.sectionSecs : {};
  const unanswered = set.sections.reduce((t, s) => t + s.questions.filter(
    (q) => q.inputType !== 'none' && !asAnswer(answers[q.id]),
  ).length, 0);

  const statements = [
    env.DB.prepare(`INSERT INTO week (child_id, week, total, out_of, submitted_at, elapsed_secs, unanswered)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(child_id, week) DO UPDATE SET
         total = excluded.total, out_of = excluded.out_of,
         submitted_at = excluded.submitted_at, elapsed_secs = excluded.elapsed_secs,
         unanswered = excluded.unanswered`)
      .bind(child, week, marked.total, marked.outOf, stamp, elapsed, unanswered),
  ];

  for (const section of set.sections) {
    statements.push(env.DB.prepare(
      `INSERT INTO section_mark (child_id, week, section_id, marks, out_of, elapsed_secs, target_secs)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(child_id, week, section_id) DO UPDATE SET
         marks = excluded.marks, out_of = excluded.out_of, elapsed_secs = excluded.elapsed_secs`,
    ).bind(child, week, section.id, marked.sectionMarks[section.id] ?? 0, section.totalMarks,
      sectionTimes[section.id] ?? null, Math.round((section.timerMins || 0) * 60)));
  }

  for (const [qid, p] of Object.entries(marked.perQuestion)) {
    const q = byId[qid];
    statements.push(env.DB.prepare(
      `INSERT INTO answer (child_id, week, question_id, section_id, given, marks, out_of,
         marked_by, correct, confidence, jev_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(child_id, week, question_id) DO UPDATE SET
         given = excluded.given, marks = excluded.marks, marked_by = excluded.marked_by,
         correct = excluded.correct, confidence = excluded.confidence,
         jev_reason = excluded.jev_reason`,
    ).bind(child, week, qid, slotOf(qid), asAnswer(answers[qid]),
      p.marks, q ? q.marks : 1, p.markedBy, p.correct, p.confidence ?? null, p.reason || null));
  }

  // Anything Jev could not settle becomes a decision waiting for the parent,
  // rather than a prompt the child's browser has to show.
  //
  // Clear this week's open marking decisions first. A resubmission re-marks
  // everything, so leaving the previous round in place piled up duplicates:
  // one submit then one resubmit produced four rows for three questions.
  statements.push(env.DB.prepare(
    "DELETE FROM decision WHERE child_id = ? AND week = ? AND kind = 'mark' AND status = 'open'",
  ).bind(child, week));

  for (const [qid, p] of Object.entries(marked.perQuestion)) {
    if (p.marks !== null) continue;
    const q = byId[qid];
    statements.push(env.DB.prepare(
      `INSERT INTO decision (child_id, week, kind, question_id, summary, detail, recommend, created_at)
       VALUES (?, ?, 'mark', ?, ?, ?, NULL, ?)`,
    ).bind(child, week, qid,
      `Mark ${qid}, out of ${q ? q.marks : 1}`,
      `${(q && q.text) || ''}\n\nAnswer given: ${asAnswer(answers[qid]) || '(blank)'}\n\n${p.reason || ''}`,
      stamp));
  }

  await env.DB.batch(statements);
  ctx.waitUntil(audit(env, 'browser', 'submit', child, week,
    `${marked.total}/${marked.outOf}, jev asked ${marked.askedJev}, referred ${marked.needsParent}`));

  return json({
    child,
    week,
    total: marked.total,
    outOf: marked.outOf,
    sectionMarks: marked.sectionMarks,
    sectionOutOf: marked.sectionOutOf,
    perQuestion: marked.perQuestion,
    needsParent: marked.needsParent,
    askedJev: marked.askedJev,
    submittedAt: stamp,
  }, request, env);
}

/** Record the marks a grown up awarded for the questions Jev referred.
 *
 *  Separate from submit on purpose: submitting is the child's action and
 *  awarding is the parent's, and they can be minutes apart. Recomputing the
 *  totals here rather than trusting a number from the page means the page
 *  cannot inflate a score. */
async function handleAward(request, env, child, ctx) {
  const week = await getCurrentWeek(env, child);
  if (!week) return fail(`no week set up for ${child}`, request, env, 404);

  let body;
  try { body = await request.json(); } catch { return fail('body must be JSON', request, env); }
  const awards = body && body.awards;
  if (!awards || typeof awards !== 'object' || Array.isArray(awards)) {
    return fail('awards object required', request, env);
  }
  if (Object.keys(awards).length > 400) return fail('too many awards', request, env, 413);

  const set = await getQuestionSet(env, child, week);
  if (!set) return fail('no questions stored for this week', request, env, 404);
  const byId = indexQuestions(set);

  const statements = [];
  for (const [qid, raw] of Object.entries(awards)) {
    const q = byId[qid];
    if (!q) return fail(`unknown question ${qid}`, request, env);
    const marks = Number(raw);
    if (!Number.isInteger(marks) || marks < 0 || marks > q.marks) {
      return fail(`${qid} must be a whole number between 0 and ${q.marks}`, request, env);
    }
    statements.push(env.DB.prepare(
      `UPDATE answer SET marks = ?, correct = ?, marked_by = 'parent', jev_reason = 'awarded by a grown up'
       WHERE child_id = ? AND week = ? AND question_id = ?`,
    ).bind(marks, marks > 0 ? 1 : 0, child, week, qid));
    statements.push(env.DB.prepare(
      `UPDATE decision SET status = 'accepted', resolved_at = ?
       WHERE child_id = ? AND week = ? AND question_id = ? AND kind = 'mark' AND status = 'open'`,
    ).bind(nowIso(), child, week, qid));
  }
  if (statements.length) await env.DB.batch(statements);

  // Recompute from the rows, never from anything the page sent.
  const rows = await env.DB.prepare(
    'SELECT question_id, section_id, marks, correct FROM answer WHERE child_id = ? AND week = ?',
  ).bind(child, week).all();
  const byQ = Object.fromEntries(rows.results.map((r) => [r.question_id, r]));

  const sectionMarks = {};
  for (const section of set.sections) {
    if (section.scoreBand) {
      const correct = section.questions.filter(
        (q) => q.autoMark && byQ[q.id] && byQ[q.id].correct === 1,
      ).length;
      let band = 0;
      for (const [lo, hi, m] of section.scoreBandRules || []) {
        if (correct >= lo && correct <= hi) { band = m; break; }
      }
      sectionMarks[section.id] = band;
      continue;
    }
    sectionMarks[section.id] = section.questions.reduce(
      (t, q) => t + ((byQ[q.id] && byQ[q.id].marks) || 0), 0,
    );
  }
  const total = Object.values(sectionMarks).reduce((a, b) => a + b, 0);
  const outOf = set.sections.reduce((t, s) => t + s.totalMarks, 0);

  // adjusted_at records that a human changed the marks, which is what lets the
  // weekly re-mark explain a stored total sitting above the automatic one.
  const updates = [env.DB.prepare(
    'UPDATE week SET total = ?, out_of = ?, adjusted_at = ? WHERE child_id = ? AND week = ?',
  ).bind(total, outOf, nowIso(), child, week)];
  for (const [sid, m] of Object.entries(sectionMarks)) {
    updates.push(env.DB.prepare(
      'UPDATE section_mark SET marks = ? WHERE child_id = ? AND week = ? AND section_id = ?',
    ).bind(m, child, week, sid));
  }
  await env.DB.batch(updates);

  ctx.waitUntil(audit(env, 'browser', 'award', child, week,
    `${Object.keys(awards).length} awarded, total now ${total}/${outOf}`));
  return json({ child, week, total, outOf, sectionMarks }, request, env);
}

/* ---------------------------------------------------------------- dashboard */

async function handleDashboard(request, env) {
  const out = {};
  for (const child of CHILDREN) {
    const profile = await env.DB.prepare(
      'SELECT display_name, marks_total, kumon_maths, kumon_english, current_week FROM child WHERE id = ?',
    ).bind(child).first();

    const weeks = await env.DB.prepare(
      `SELECT week, total, out_of, submitted_at, adjusted_at, notes, elapsed_secs, unanswered,
              summary, verdict, wins, errors, design_issues, hinted_sections
       FROM week WHERE child_id = ? ORDER BY week`,
    ).bind(child).all();

    const marks = await env.DB.prepare(
      'SELECT week, section_id, marks, out_of, elapsed_secs, target_secs FROM section_mark WHERE child_id = ?',
    ).bind(child).all();
    const bySection = {};
    for (const r of marks.results) {
      (bySection[r.week] = bySection[r.week] || {})[r.section_id] = r;
    }

    const gaps = await env.DB.prepare(
      `SELECT g.id, g.topic, g.detail, g.status, g.slot, g.rung, g.parked_until
       FROM gap g WHERE g.child_id = ? ORDER BY g.id`,
    ).bind(child).all();
    const obs = await env.DB.prepare(
      `SELECT o.gap_id, o.week, o.result FROM gap_observation o
       JOIN gap g ON g.id = o.gap_id WHERE g.child_id = ? ORDER BY o.week`,
    ).bind(child).all();
    const byGap = {};
    for (const r of obs.results) (byGap[r.gap_id] = byGap[r.gap_id] || []).push(r.result);

    const pos = await env.DB.prepare(
      'SELECT slot, rung, since_week, note FROM position WHERE child_id = ?',
    ).bind(child).all();

    const decisions = await env.DB.prepare(
      `SELECT id, week, kind, question_id, summary, detail, recommend
       FROM decision WHERE child_id = ? AND status = 'open' ORDER BY id`,
    ).bind(child).all();

    out[child] = {
      profile,
      weeks: weeks.results.map((w) => ({
        week: w.week,
        total: w.total,
        outOf: w.out_of,
        submittedAt: w.submitted_at,
        adjustedAt: w.adjusted_at,
        notes: w.notes,
        elapsedSecs: w.elapsed_secs,
        unanswered: w.unanswered,
        summary: w.summary,
        verdict: w.verdict,
        wins: w.wins ? JSON.parse(w.wins) : [],
        errors: w.errors ? JSON.parse(w.errors) : [],
        designIssues: w.design_issues ? JSON.parse(w.design_issues) : [],
        hintedSections: w.hinted_sections ? JSON.parse(w.hinted_sections) : [],
        sectionMarks: Object.fromEntries(
          Object.entries(bySection[w.week] || {}).map(([k, v]) => [k, v.marks]),
        ),
        sectionTiming: Object.fromEntries(
          Object.entries(bySection[w.week] || {})
            .filter(([, v]) => v.elapsed_secs != null)
            .map(([k, v]) => [k, { elapsed: v.elapsed_secs, target: v.target_secs }]),
        ),
      })),
      gaps: gaps.results.map((g) => ({
        topic: g.topic, detail: g.detail, status: g.status,
        slot: g.slot, rung: g.rung, parkedUntil: g.parked_until,
        weeks: byGap[g.id] || [],
      })),
      position: { slots: Object.fromEntries(pos.results.map((r) => [r.slot, {
        rung: r.rung, since: r.since_week, note: r.note,
      }])) },
      decisions: decisions.results,
    };
  }
  return json(out, request, env);
}

/* ----------------------------------------------------------------- progress */

/** The child's own page: what they have cleared, not what they got wrong. */
async function handleProgress(request, env, child) {
  // A week counts as done when it has a score, not when it has a submitted_at.
  // The weeks migrated from the old archive format never carried a timestamp,
  // so filtering on one hid nine real weeks per child from the progress page.
  const weeks = await env.DB.prepare(
    `SELECT week, total, out_of, submitted_at FROM week
     WHERE child_id = ? AND total IS NOT NULL AND out_of > 0 ORDER BY week`,
  ).bind(child).all();

  const rungs = await env.DB.prepare(
    'SELECT rung, slot, cleared_week FROM rung_cleared WHERE child_id = ? ORDER BY cleared_week',
  ).bind(child).all();

  const pos = await env.DB.prepare('SELECT slot, rung FROM position WHERE child_id = ?')
    .bind(child).all();

  const list = weeks.results;
  const rate = (w) => (w && w.out_of ? w.total / w.out_of : 0);
  const best = list.reduce((b, w) => (rate(w) > rate(b) ? w : b), null);

  // A streak is consecutive submitted weeks, so missing one breaks it.
  let streak = 0;
  for (let i = list.length - 1; i > 0; i--) {
    if (list[i].week === list[i - 1].week + 1) streak++; else break;
  }
  if (list.length) streak++;

  return json({
    child,
    weeksDone: list.length,
    streak,
    best: best ? { week: best.week, pct: Math.round(best.total / best.out_of * 100) } : null,
    latest: list.length ? {
      week: list[list.length - 1].week,
      total: list[list.length - 1].total,
      outOf: list[list.length - 1].out_of,
    } : null,
    cleared: rungs.results,
    current: Object.fromEntries(pos.results.map((r) => [r.slot, r.rung])),
  }, request, env);
}

/* ------------------------------------------------------------------ writing */

async function handleWriting(request, env, child, ctx) {
  const week = await getCurrentWeek(env, child);
  if (!week) return fail(`no week set up for ${child}`, request, env, 404);

  let body;
  try { body = await request.json(); } catch { return fail('body must be JSON', request, env); }
  if (!body || typeof body !== 'object') return fail('body must be a JSON object', request, env);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return fail('nothing written', request, env);
  if (text.length > 20000) return fail('that is too long', request, env, 413);

  const row = await env.DB.prepare(
    'SELECT prompt, genre, minutes FROM writing WHERE child_id = ? AND week = ?',
  ).bind(child, week).first();
  if (!row) return fail('no writing task set for this week', request, env, 404);

  const jev = new Jev(env.JEV_API_KEY);
  let scored;
  try {
    scored = await scoreWriting(jev, { child, prompt: row.prompt, genre: row.genre, text });
  } catch (err) {
    scored = { dims: {}, total: null, confidence: 0, needsParent: true, error: err.message };
  }

  const words = text.split(/\s+/).filter(Boolean).length;
  await env.DB.prepare(
    `UPDATE writing SET text = ?, words = ?, elapsed_secs = ?, ideas = ?, structure = ?,
       vocabulary = ?, accuracy = ?, total = ?, scored_by = ?, confidence = ?, submitted_at = ?
     WHERE child_id = ? AND week = ?`,
  ).bind(text, words, Number.isFinite(body.elapsedSecs) ? Math.round(body.elapsedSecs) : null,
    scored.dims.ideas ?? null, scored.dims.structure ?? null,
    scored.dims.vocabulary ?? null, scored.dims.accuracy ?? null,
    scored.total, scored.total == null ? null : 'jev', scored.confidence ?? null,
    nowIso(), child, week).run();

  if (scored.needsParent) {
    // One open confirmation per week, so resubmitting a piece does not stack up
    // a queue of identical decisions for the same writing task.
    await env.DB.prepare(
      `DELETE FROM decision WHERE child_id = ? AND week = ? AND kind = 'writing' AND status = 'open'`,
    ).bind(child, week).run();
    await env.DB.prepare(
      `INSERT INTO decision (child_id, week, kind, summary, detail, recommend, created_at)
       VALUES (?, ?, 'writing', ?, ?, NULL, ?)`,
    ).bind(child, week, `Confirm the writing score for week ${week}`,
      scored.total == null
        ? `Jev could not score this one: ${scored.error || 'unavailable'}. ${words} words.`
        : `Jev proposed ${scored.total} out of 10 with confidence ${(scored.confidence || 0).toFixed(2)}.`,
      nowIso()).run();
  }

  ctx.waitUntil(audit(env, 'browser', 'writing', child, week, `${words} words, ${scored.total} of 10`));
  return json({ child, week, words, ...scored }, request, env);
}

/* -------------------------------------------------------------------- admin */

/** Everything scripts/kh.py needs. Behind a bearer token that only the CLI has. */
async function handleAdmin(request, env, path, ctx) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
    return fail('unauthorised', request, env, 401);
  }

  if (request.method === 'GET' && path === '/admin/export') {
    return await handleDashboard(request, env);
  }

  let body = {};
  if (request.method === 'POST') {
    try { body = await request.json(); } catch { return fail('body must be JSON', request, env); }
    if (!body || typeof body !== 'object') return fail('body must be a JSON object', request, env);
  }

  if (request.method === 'POST' && path === '/admin/sql') {
    const { statements } = body;
    if (!Array.isArray(statements) || !statements.length) {
      return fail('statements[] required', request, env);
    }
    if (statements.length > 500) return fail('too many statements', request, env, 413);
    const bad = statements.findIndex((s) => !s || typeof s.sql !== 'string' || !s.sql.trim());
    if (bad >= 0) return fail(`statements[${bad}] needs a sql string`, request, env);
    const prepared = statements.map((s) => env.DB.prepare(s.sql).bind(...(s.params || [])));
    const results = await env.DB.batch(prepared);
    ctx.waitUntil(audit(env, 'cli', 'sql', null, null, `${statements.length} statements`));
    return json({ ok: true, count: results.length }, request, env);
  }

  if (request.method === 'POST' && path === '/admin/query') {
    const { sql, params } = body;
    if (typeof sql !== 'string' || !/^\s*select\b/i.test(sql)) {
      return fail('only SELECT is allowed here', request, env);
    }
    const r = await env.DB.prepare(sql).bind(...(params || [])).all();
    return json({ results: r.results }, request, env);
  }

  return fail('unknown admin route', request, env, 404);
}

/* ------------------------------------------------------------------- router */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    /* Every handler below is awaited rather than returned. Returning the promise
       handed it straight back to the runtime, so a rejection inside a handler
       escaped this try/catch entirely and the caller got Cloudflare's bare
       "error code: 1101" instead of the JSON 500 below. */
    try {
      if (path === '/' || path === '/health') {
        return json({ ok: true, service: 'kids-homework-api' }, request, env);
      }

      if (path.startsWith('/admin/')) return await handleAdmin(request, env, path, ctx);

      const week = path.match(/^\/api\/week\/([a-z]+)$/);
      if (week && request.method === 'GET') {
        if (!isChild(week[1])) return fail('unknown child', request, env, 404);
        return await handleWeek(request, env, week[1]);
      }

      const submit = path.match(/^\/api\/week\/([a-z]+)\/submit$/);
      if (submit && request.method === 'POST') {
        if (!isChild(submit[1])) return fail('unknown child', request, env, 404);
        return await handleSubmit(request, env, submit[1], ctx);
      }

      if (path === '/api/dashboard' && request.method === 'GET') {
        return await handleDashboard(request, env);
      }

      const award = path.match(/^\/api\/week\/([a-z]+)\/award$/);
      if (award && request.method === 'POST') {
        if (!isChild(award[1])) return fail('unknown child', request, env, 404);
        return await handleAward(request, env, award[1], ctx);
      }

      const prog = path.match(/^\/api\/progress\/([a-z]+)$/);
      if (prog && request.method === 'GET') {
        if (!isChild(prog[1])) return fail('unknown child', request, env, 404);
        return await handleProgress(request, env, prog[1]);
      }

      const writing = path.match(/^\/api\/writing\/([a-z]+)$/);
      if (writing && request.method === 'POST') {
        if (!isChild(writing[1])) return fail('unknown child', request, env, 404);
        return await handleWriting(request, env, writing[1], ctx);
      }

      return fail('not found', request, env, 404);
    } catch (err) {
      // Never leak a stack to the page, but keep it in the log.
      console.error(err && err.stack ? err.stack : String(err));
      return fail('something went wrong on the server', request, env, 500);
    }
  },
};

/* markWeek is exported for scripts/test.mjs, which exercises the marking order
   against a stub Jev. Nothing else imports from this module: it is an entry
   point, not a library. */
export { markWeek };

/* JSONbin client.

   Both worksheets and the dashboard read the same shared document, so a save is
   read, modify, write. If both children submit at the same moment one write can
   clobber the other, which is why saveWeek re-reads immediately before writing,
   reads back after writing to confirm the entry actually landed, and retries
   with backoff when either check fails. */

import { ACCESS_KEY, BINS } from './config.js';

const JSONBIN = 'https://api.jsonbin.io/v3/b';

const readHeaders = { 'X-Access-Key': ACCESS_KEY, 'X-Bin-Meta': 'false' };

async function getBin(binId, { fresh = false } = {}) {
  const res = await fetch(`${JSONBIN}/${binId}`, {
    headers: readHeaders,
    cache: fresh ? 'no-store' : 'default',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} reading the tracker`);
  return res.json();
}

export const loadLive = (opts) => getBin(BINS.live, opts);
export const loadArchive = (opts) => getBin(BINS.archive, opts);
/* The question set moved to its own bin when the live one hit its 100KB cap.
   The worksheet now downloads only the week it is about to sit. */
export const loadCurrent = (opts) => getBin(BINS.current, opts);

async function putLive(payload) {
  const res = await fetch(`${JSONBIN}/${BINS.live}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Access-Key': ACCESS_KEY },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `HTTP ${res.status} writing the tracker`);
  }
  return res.json();
}

/**
 * Write one week's result for one child.
 *
 * @param {object} o
 * @param {string} o.child        'mason' or 'elysia'
 * @param {number} o.week         week number
 * @param {number} o.total        marks earned
 * @param {number} o.outOf        marks available
 * @param {object} o.sectionMarks { '1A': 7, ... }
 * @param {object} o.answers      { '1A-Q1': 'twenty', ... }
 * @param {(stage: string, attempt: number, detail?: string) => void} [o.onProgress]
 * @param {number} [o.attempts=4]
 * @returns {Promise<object>} the entry as it was saved
 */
export async function saveWeek({
  child, week, total, outOf, sectionMarks, answers, onProgress = () => {}, attempts = 4,
}) {
  const stamp = new Date().toISOString();
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    onProgress(attempt === 1 ? 'saving' : 'retrying', attempt);
    try {
      // Re-read right before writing so a save from the other child's tab,
      // or a grading change made since this page loaded, is not thrown away.
      const data = await getBin(BINS.live, { fresh: true });
      const kid = data[child];
      if (!kid) throw new Error(`no record for ${child} in the tracker`);
      kid.weeks = kid.weeks || [];

      const entry = {
        week, total, outOf,
        sectionMarks: { ...sectionMarks },
        archive: { ...answers },
        submittedAt: stamp,
      };
      const existing = kid.weeks.find((w) => w.week === week);
      if (existing) {
        Object.assign(existing, entry);
      } else {
        kid.weeks.push(entry);
        kid.weeks.sort((a, b) => a.week - b.week);
      }

      await putLive(data);

      // Confirm the write stuck. A concurrent save would have overwritten it.
      const back = await getBin(BINS.live, { fresh: true });
      const saved = ((back[child] || {}).weeks || []).find((w) => w.week === week);
      if (!saved || saved.submittedAt !== stamp) {
        throw new Error('another save landed at the same time');
      }

      onProgress('saved', attempt);
      return saved;
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        onProgress('waiting', attempt, err.message);
        await new Promise((r) => setTimeout(r, 700 * attempt));
      }
    }
  }

  onProgress('failed', attempts, lastError && lastError.message);
  throw lastError;
}

/* -------------------------------------------------------------------- API --
 *
 * The Worker path. The JSONbin functions above stay for now as a fallback that
 * can be forced with ?api=jsonbin, and come out once this has run a full week.
 */

import { API as WORKER } from './config.js';

async function api(path, options = {}) {
  const res = await fetch(`${WORKER}${path}`, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

/** This week's questions, plus whether it was already submitted. */
export const apiWeek = (child) => api(`/api/week/${child}`);

/** Everything the dashboard needs for both children. */
export const apiDashboard = () => api('/api/dashboard');

/** The child's own progress page. */
export const apiProgress = (child) => api(`/api/progress/${child}`);

/**
 * Submit a week. The server marks it: deterministic first, then Jev on anything
 * that rejected and on every question that used to come straight to the parent.
 * The browser no longer decides any mark.
 */
export const apiSubmit = (child, payload) => api(`/api/week/${child}/submit`, {
  method: 'POST',
  body: JSON.stringify(payload),
});

/** Record the marks a grown up awarded for the questions Jev referred.
    The server recomputes the totals from its own rows, so the page cannot
    inflate a score. */
export const apiAward = (child, awards) => api(`/api/week/${child}/award`, {
  method: 'POST',
  body: JSON.stringify({ awards }),
});

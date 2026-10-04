/* JSONbin client.

   Both worksheets and the dashboard read the same shared document, so a save is
   read, modify, write. If both children submit at the same moment one write can
   clobber the other, which is why saveWeek re-reads immediately before writing,
   reads back after writing to confirm the entry actually landed, and retries
   with backoff when either check fails. */

import { ACCESS_KEY, BINS } from './config.js';

const API = 'https://api.jsonbin.io/v3/b';

const readHeaders = { 'X-Access-Key': ACCESS_KEY, 'X-Bin-Meta': 'false' };

async function getBin(binId, { fresh = false } = {}) {
  const res = await fetch(`${API}/${binId}`, {
    headers: readHeaders,
    cache: fresh ? 'no-store' : 'default',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} reading the tracker`);
  return res.json();
}

export const loadLive = (opts) => getBin(BINS.live, opts);
export const loadArchive = (opts) => getBin(BINS.archive, opts);

async function putLive(payload) {
  const res = await fetch(`${API}/${BINS.live}`, {
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

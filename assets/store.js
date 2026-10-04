/* The API client.

   One transport, one source of truth. The Worker marks the week, owns every
   total and writes per row, so the page neither holds a key nor decides a mark.

   This replaced a JSONbin client that did read, modify, write against a single
   shared document, with retries and a read back check because two children
   submitting at once could overwrite each other. None of that is needed now:
   the rows are independent, so there is nothing to race. */

import { API } from './config.js';

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
  } catch {
    // fetch only rejects when the request never completed, so this is the
    // offline case. Say that rather than showing a bare "Failed to fetch".
    throw new Error('Could not reach the homework server. Check the connection and try again.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

/** This week's questions, plus whether it was already submitted. */
export const apiWeek = (child) => api(`/api/week/${child}`);

/** Everything the dashboard needs for both children. */
export const apiDashboard = () => api('/api/dashboard');

/* GET /api/progress/:child also exists and is tested, but nothing calls it yet:
   the child facing progress page has not been built. Add the helper when it is,
   rather than keeping an unused one here. */

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

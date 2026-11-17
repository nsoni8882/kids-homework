/* Endpoints and per child settings.

   There is deliberately no key in this file. Everything the pages do goes
   through the Worker, which holds the only secrets: the browser can read this
   week and submit this week, and nothing else. The earlier version shipped a
   JSONbin access key that could overwrite the whole tracker from any tab. */

const PRODUCTION_API = 'https://kids-homework-api.nikunj-sap.workers.dev';

/** The API to talk to.
 *
 *  Always production, except on localhost, where `?api=<url>` points the page at
 *  a `wrangler dev` instance. The override is restricted to localhost on
 *  purpose: a published page must never be redirectable to another origin by
 *  query string, because the answers and marks go through it. */
export const API = (() => {
  try {
    const local = ['localhost', '127.0.0.1'].includes(location.hostname);
    if (!local) return PRODUCTION_API;
    return new URLSearchParams(location.search).get('api') || PRODUCTION_API;
  } catch {
    return PRODUCTION_API;
  }
})();

export const CHILDREN = {
  mason:  { name: 'Mason',  icon: 'compass', outOf: 25 },
  elysia: { name: 'Elysia', icon: 'sparkle', outOf: 20 },
};

/** The first DAILY set per child. Homework went daily on 17 Nov 2026; the set
    number keeps counting, so older sets are a Week and newer ones a Day.
    kh.py validate checks this against spine.cadence.dailyFrom. */
export const DAILY_FROM = { mason: 30, elysia: 29 };
export const isDaily = (child, n) => n >= DAILY_FROM[child];
/** "Day 31" or "Week 28"; short gives "D31" or "W28". */
export const setLabel = (child, n, short = false) =>
  (short ? (isDaily(child, n) ? 'D' : 'W') : (isDaily(child, n) ? 'Day ' : 'Week ')) + n;

/** The child this page is for. Set explicitly on <html data-child>, with the
    URL path as a fallback so /mason/ and /elysia/ keep working on their own. */
export function currentChild() {
  const declared = document.documentElement.dataset.child;
  if (declared && CHILDREN[declared]) return declared;
  return location.pathname.toLowerCase().includes('elysia') ? 'elysia' : 'mason';
}

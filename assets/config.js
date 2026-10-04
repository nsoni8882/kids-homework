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
  mason:  { name: 'Mason',  icon: 'compass', outOf: 55 },
  elysia: { name: 'Elysia', icon: 'sparkle', outOf: 40 },
};

/** The child this page is for. Set explicitly on <html data-child>, with the
    URL path as a fallback so /mason/ and /elysia/ keep working on their own. */
export function currentChild() {
  const declared = document.documentElement.dataset.child;
  if (declared && CHILDREN[declared]) return declared;
  return location.pathname.toLowerCase().includes('elysia') ? 'elysia' : 'mason';
}

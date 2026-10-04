/* The only file in this repo that holds a key.

   This is a RESTRICTED JSONbin access key: it can read bins and update bins,
   and it is rejected for deleting a bin or creating one. The repo is public, so
   anyone can read it. Worst case someone reads or overwrites the two bins. They
   cannot delete them or add new ones to the account. The master key must never
   appear here: it lives in CLAUDE.md, which is gitignored. */

export const ACCESS_KEY = '$2a$10$Y9F3Cfhg1.rVgc23d7egfuECDbmcBIXPjm6GKBcb/MyGb5kt6vIiG';

export const BINS = {
  live: '6a0a0384adc21f119ab47d7e',       // weeks, gaps, curriculum position
  archive: '6aa7b068ac6210605aca94c2',    // older weeks, resolved gaps, past question sets
  current: '6ac2a281ffd5d160534cc69a',    // only this week's questions
};

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

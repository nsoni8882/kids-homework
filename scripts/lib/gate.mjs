/* Shared machinery for the two Jev gates.
 *
 * check-week.mjs is the gate the weekly cycle runs before a week goes out.
 * jev-check.mjs is the same quality pass on its own, and can look at a past
 * week. They had separate copies of the key lookup, the week loader, the
 * concurrency pool, the rung lookup and the drill sampling rule, which drifted:
 * fixing a sampling bug in one left the other wrong.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA = join(ROOT, 'data');

/** Jev costs this per million input tokens. Output is free. */
export const COST_PER_MTOK = 0.042;

export const loadSpine = () => JSON.parse(
  readFileSync(join(ROOT, 'curriculum', 'spine.json'), 'utf8'),
);

/** The TypeSafe key. Server side only: it lives in CLAUDE.md, never in the repo. */
export function apiKey({ quiet = false } = {}) {
  const md = join(ROOT, 'CLAUDE.md');
  if (!existsSync(md)) {
    if (quiet) return null;
    console.error('CLAUDE.md not found. It holds the key and is never committed.');
    process.exit(1);
  }
  const m = readFileSync(md, 'utf8').match(/^- API key: `([^`]+)`/m);
  if (!m) {
    if (quiet) return null;
    console.error('no TypeSafe API key in CLAUDE.md');
    process.exit(1);
  }
  return m[1];
}

/** The current week, or a past one from the saved question sets. */
export function loadWeek(child, week) {
  const current = join(DATA, 'current', `${child}.json`);
  if (week == null) {
    return existsSync(current) ? JSON.parse(readFileSync(current, 'utf8')) : null;
  }
  const past = join(DATA, 'children', child, 'question-sets', `w${String(week).padStart(2, '0')}.json`);
  if (existsSync(past)) return JSON.parse(readFileSync(past, 'utf8'));
  if (existsSync(current)) {
    const c = JSON.parse(readFileSync(current, 'utf8'));
    if (c.weekNum === week) return c;
  }
  return null;
}

/** Keep a few requests in flight without hammering the API. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/**
 * The rung the child is on in this slot, so the level check has something real
 * to judge against.
 *
 * Returns null when no position is recorded. It used to return the middle of
 * the ladder instead, which is worse than nothing: the checks then judge "too
 * hard" and "does this evidence the rung" against a level the child was never
 * on, and report the result with the same confidence as a real one.
 */
export function rungFor(spine, child, slot) {
  const ladder = spine.ladders[child] && spine.ladders[child][slot];
  if (!ladder) return null;
  const posPath = join(DATA, 'curriculum', 'position.json');
  if (!existsSync(posPath)) return null;
  const pos = JSON.parse(readFileSync(posPath, 'utf8'));
  const here = (((pos.children || {})[child] || {}).slots || {})[slot];
  if (!here) return null;
  return ladder.rungs.find((r) => r.id === here.rung) || null;
}

/** Slots in this week with no recorded rung, which the level checks cannot judge. */
export function slotsMissingRung(spine, child, set) {
  return set.sections
    .filter((s) => !rungFor(spine, child, s.id))
    .map((s) => s.id);
}

/**
 * Which questions to send.
 *
 * A drill is 30 near identical sums, so every tenth one is sampled rather than
 * paying for 30 answers that say the same thing. The index comes from the loop
 * rather than indexOf: searching the array for each question made this
 * quadratic, and on a 30 item drill with repeated text indexOf returned the
 * first match, so the wrong items were sampled.
 */
export function questionsToCheck(set) {
  const jobs = [];
  for (const section of set.sections) {
    let n = -1;
    for (const question of section.questions) {
      if (question.inputType === 'none') continue;
      n++;
      if (section.scoreBand && n % 10 !== 0) continue;
      jobs.push({ section, question });
    }
  }
  return jobs;
}

export const costLine = (jev) => `${jev.usage.requests} requests, `
  + `${jev.usage.inputTokens.toLocaleString()} input tokens, `
  + `about $${(jev.usage.inputTokens / 1e6 * COST_PER_MTOK).toFixed(4)}`;

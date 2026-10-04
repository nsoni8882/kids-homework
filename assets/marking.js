/* Marking engine.

   This is the behaviour that decides a child's marks, so it is deliberately
   unchanged from the version that marked weeks 1 to 21. Do not "tidy" the
   matching rules: each one is there because a correct answer was marked wrong
   once. scripts/test.mjs locks the behaviour down. Run it after any edit.

   The matching is tolerant of: case, surrounding whitespace, trailing
   punctuation, a trailing unit after a number, a leading filler word or phrase,
   "and" and comma differences, stray internal spacing, and a correct phrase
   sitting inside a slightly longer answer. It refuses that last, loosest rule
   when the child's answer is negated, so "not Monday" never matches "Monday". */

const ANSWER_LEADING_FILLERS = [
  'because ', 'it was ', 'it is ', 'to the ', 'to ', 'for the ', 'for ',
  'at the ', 'at ', 'in the ', 'in ', 'on the ', 'on ', 'of the ', 'of ',
  'about ', 'every ', 'a ', 'an ', 'the ',
];

function normaliseAnswerText(s) {
  return (s || '').toString().trim().toLowerCase()
    .replace(/[^a-z0-9]+$/, '')
    .replace(/\s+and\s+/g, ' ')
    .trim();
}

function stripLeadingFillers(s, depth = 0) {
  if (depth >= 3) return s;
  for (const f of ANSWER_LEADING_FILLERS) {
    if (s.startsWith(f)) return stripLeadingFillers(s.slice(f.length).trim(), depth + 1);
  }
  return s;
}

const noSpaces = (s) => s.replace(/\s+/g, '');

/**
 * Does the child's answer count as one of the accepted answers?
 * @param {string} kidRaw        what the child typed
 * @param {string[]} acceptedRaw every answer the question accepts
 * @param {string} inputType     'letter' is compared strictly, upper cased
 */
export function answersMatch(kidRaw, acceptedRaw, inputType) {
  const accepted = (acceptedRaw || []).map((a) => a.toString());

  if (inputType === 'letter') {
    const kidUp = (kidRaw || '').toString().trim().toUpperCase();
    return accepted.map((a) => a.trim().toUpperCase()).includes(kidUp);
  }

  const kidNorm = normaliseAnswerText(kidRaw);
  if (!kidNorm) return false;
  const accNorm = accepted.map(normaliseAnswerText);
  if (accNorm.includes(kidNorm)) return true;

  // A trailing unit or word after a number, for example "43 cm" when "43" is accepted.
  const kidNumMatch = kidNorm.replace(/,/g, '').match(/^-?\d+(\.\d+)?/);
  if (kidNumMatch) {
    const kidNum = kidNumMatch[0];
    if (accNorm.some((a) => a.replace(/,/g, '') === kidNum)) return true;
  }

  // A leading filler word or phrase, for example "for 2 hours" when "2 hours" is accepted.
  const kidStripped = stripLeadingFillers(kidNorm);
  if (kidStripped !== kidNorm && accNorm.includes(kidStripped)) return true;

  // The same filler words missing or extra on either side, for example the child wrote
  // "wetlands of North and South Carolina" and the key says "the wetlands of North and
  // South Carolina". Strip the fillers from both sides, then compare.
  const accStripped = accNorm.map((a) => stripLeadingFillers(a));
  if (accStripped.includes(kidStripped)) return true;

  // Stray internal spacing either way, for example "w e s t" or "atmidnight".
  const kidNoSpace = noSpaces(kidNorm);
  if (accNorm.some((a) => noSpaces(a) === kidNoSpace)) return true;

  // Punctuation and "and" differences, and a few extra words around a correct text
  // answer. Never applied when the answer is negated or names both true and false.
  const toks = (s) => (s || '').toString().toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter((t) => t && t !== 'and');

  const kt = toks(kidRaw);
  if (!kt.length) return false;
  const kidLower = (kidRaw || '').toString().toLowerCase();
  const negated = /\b(not|no|never)\b|n['’]t/.test(kidLower)
    || (kt.includes('true') && kt.includes('false'));

  for (const a of accepted) {
    const at = toks(a);
    if (!at.length) continue;
    if (kt.join(' ') === at.join(' ')) return true;
    const textAnswer = at.some((t) => /[a-z]/.test(t));
    if (textAnswer && !negated && kt.length <= at.length + 3) {
      for (let i = 0; i + at.length <= kt.length; i++) {
        if (at.every((t, j) => kt[i + j] === t)) return true;
      }
    }
  }

  return false;
}

/**
 * Marks for one section, given the answers collected so far.
 *
 * A drill section (scoreBand) is banded: count how many are right, then take
 * the marks from the first matching band. Its question marks do not sum to the
 * section total, which is why it cannot use the normal path.
 *
 * @returns {number} marks earned for the section
 */
export function markSection(section, answers) {
  if (section.scoreBand) {
    let correct = 0;
    for (const q of section.questions) {
      if (!q.autoMark) continue;
      if (answersMatch(answers[q.id], q.accepted, q.inputType)) correct++;
    }
    for (const [lo, hi, marks] of section.scoreBandRules || []) {
      if (correct >= lo && correct <= hi) return marks;
    }
    return 0;
  }

  let earned = 0;
  for (const q of section.questions) {
    if (!q.autoMark || q.inputType === 'none') continue;
    if (answersMatch(answers[q.id], q.accepted, q.inputType)) earned += q.marks;
  }
  return earned;
}

/** How many of a drill section's auto marked questions are right. */
export function countCorrect(section, answers) {
  return section.questions.filter(
    (q) => q.autoMark && answersMatch(answers[q.id], q.accepted, q.inputType),
  ).length;
}

/* parentMarkedQuestions() lived here and listed every autoMark:false question
   for the parent to mark. It is gone because that is no longer how the decision
   is made: the server offers those questions to Jev first and the parent only
   sees what Jev could not settle, which is a list only the server can produce. */

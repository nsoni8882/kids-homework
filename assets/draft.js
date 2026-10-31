/* The in progress draft of a worksheet, kept in this browser only.

   It holds the typed answers and nothing else. No mark, no score, no total,
   so a draft can never influence a result: the Worker stays the only store
   for anything that counts. The draft is a convenience so a child who stops
   halfway, or closes the tab, comes back to their own typing.

   Every call is wrapped, because localStorage throws in a private window and
   returns nothing when site data is cleared. A blocked store means the sheet
   behaves exactly as it did before this file existed. */

const VERSION = 1;

const key = (child, week) => `kh-draft-${child}-w${week}`;

/* Active seconds per section. The worksheet resumes its clock from these, so
   anything that is not a finite, non negative number is dropped rather than
   allowed to turn the timer into NaN. */
function cleanSecs(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
}

/** The saved draft for this child and week, or null if there is none. */
export function loadDraft(child, week) {
  try {
    const raw = localStorage.getItem(key(child, week));
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || d.v !== VERSION || !d.answers || typeof d.answers !== 'object') return null;
    return {
      answers: d.answers,
      sectionIdx: Number.isInteger(d.sectionIdx) ? d.sectionIdx : 0,
      sectionSecs: cleanSecs(d.sectionSecs),
      savedAt: d.savedAt || null,
    };
  } catch {
    return null;
  }
}

/** Write the draft. Called on every section change and while typing, so it
    stays small and silent: a full store or a blocked one is not an error the
    child should ever see. */
export function saveDraft(child, week, state) {
  try {
    localStorage.setItem(key(child, week), JSON.stringify({
      v: VERSION,
      answers: state.answers || {},
      sectionIdx: state.sectionIdx || 0,
      sectionSecs: state.sectionSecs || {},
      savedAt: new Date().toISOString(),
    }));
  } catch { /* blocked or full storage, nothing to do */ }
}

export function clearDraft(child, week) {
  try { localStorage.removeItem(key(child, week)); } catch { /* blocked storage */ }
}

/** How many questions the draft actually has an answer for, for the welcome
    screen. An empty string counts as unanswered. */
export function draftAnswered(draft) {
  if (!draft) return 0;
  return Object.values(draft.answers).filter((v) => String(v).trim() !== '').length;
}

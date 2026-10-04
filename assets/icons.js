/* Inline SVG icons, one visual language: 24px grid, 1.75 stroke, round caps.
   Emoji is never used as an icon. It is allowed as content, such as a trophy. */

const PATHS = {
  chart: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M7 15l4-5 3 3 5-7"/>',
  trend: '<path d="M22 7l-8.5 8.5-4-4L2 19"/><path d="M16 7h6v6"/>',
  trendDown: '<path d="M22 17l-8.5-8.5-4 4L2 5"/><path d="M16 17h6v-6"/>',
  flat: '<path d="M3 12h18"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/>',
  notes: '<path d="M4 4h12l4 4v12a0 0 0 0 1 0 0H4z"/><path d="M8 11h8M8 15h5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4.3-4.3"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2z"/><path d="M8 3v18"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
  check: '<path d="M4 12.5l5 5L20 6.5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5L16 10"/>',
  cross: '<path d="M6 6l12 12M18 6L6 18"/>',
  alert: '<path d="M12 3l9.5 17H2.5z"/><path d="M12 9v5M12 17.2v.1"/>',
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3.2 2"/>',
  award: '<circle cx="12" cy="9" r="6"/><path d="M8.5 14.2L7 21l5-2.4 5 2.4-1.5-6.8"/>',
  square: '<rect x="4" y="4" width="16" height="16" rx="3"/>',
  user: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  users: '<circle cx="9" cy="8.5" r="3.6"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16.5 5.2a3.6 3.6 0 0 1 0 6.6M18 20a6.5 6.5 0 0 0-2.3-5"/>',
  calc: '<rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M8 7h8M8 12h2M12 12h2M16 12h0M8 16h2M12 16h2M16 16h0"/>',
  brain: '<path d="M9.5 4a3 3 0 0 0-3 3 2.6 2.6 0 0 0-1 4.9A3 3 0 0 0 7 17a2.8 2.8 0 0 0 2.5 2.8V4z"/><path d="M14.5 4a3 3 0 0 1 3 3 2.6 2.6 0 0 1 1 4.9A3 3 0 0 1 17 17a2.8 2.8 0 0 1-2.5 2.8V4z"/>',
  ruler: '<rect x="2.5" y="8" width="19" height="8" rx="2" transform="rotate(-45 12 12)"/><path d="M9 9l1.5 1.5M12 12l1.5 1.5"/>',
  arrowRight: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="M11 18L5 12l6-6"/>',
  chevronRight: '<path d="M9 5l7 7-7 7"/>',
  play: '<path d="M7 4.5l12 7.5-12 7.5z"/>',
  eye: '<path d="M2 12s3.8-6.5 10-6.5S22 12 22 12s-3.8 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 6.1"/><path d="M20 4.5V11h-6"/>',
  save: '<path d="M5 3h11l4 4v14H5z"/><path d="M8 3v6h8V3M8 21v-6h8v6"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.4M12 19.6V22M2 12h2.4M19.6 12H22M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M19.1 4.9l-1.7 1.7M6.6 17.4l-1.7 1.7"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
  clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1"/><path d="M9 10h6M9 14h4"/>',
  inbox: '<path d="M3 13l2.6-7.4A2 2 0 0 1 7.5 4h9a2 2 0 0 1 1.9 1.6L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 13h5l1 2.5h6L16 13h5"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4.5V11H10"/><path d="M12 8v4.3l3 1.8"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
};

export function icon(name, cls = 'i') {
  const d = PATHS[name];
  if (!d) return '';
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}

/** An icon that carries meaning on its own needs a name a screen reader can read. */
export function iconLabelled(name, label, cls = 'i') {
  const d = PATHS[name];
  if (!d) return '';
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"
    role="img" aria-label="${label}">${d}</svg>`;
}

export const SUBJECT_ICON = { english: 'book', maths: 'calc', thinking: 'brain' };

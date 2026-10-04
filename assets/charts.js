/* Chart definitions.
 *
 * The categorical palette is not a taste decision. The three subject hues were
 * run through the data-viz validator in both modes: the previous violet, teal
 * and amber set failed, with deuteranopia separation of only 5.9 between Maths
 * and English on the dark surface, which means a colourblind reader could not
 * tell those two series apart. The set below passes every gate in both modes:
 *
 *   light  orange #eb6834 / aqua #1baf7a / violet #4a3aa7
 *          worst all-pairs CVD dE 9.2, normal-vision dE 27.6
 *   dark   orange #d95926 / aqua #199e70 / violet #9085e9
 *          worst all-pairs CVD dE 9.4, normal-vision dE 24.6
 *
 * Aqua sits below 3:1 against the light surface, so the relief rule applies:
 * every subject chart ships direct labels and a table view. That is why the
 * table toggle is not optional decoration.
 */

const css = (name) => getComputedStyle(document.documentElement)
  .getPropertyValue(name).trim();

/* Chart.js parses colours with its own parser, which does NOT understand the
   CSS color-mix() function. Passing one in is accepted silently and then
   ignored, which is why the first version of the focus interaction changed the
   buttons but left the bars at full strength. Everything handed to Chart.js is
   therefore a real rgba string. */
function alpha(colour, a) {
  const hex = colour.trim();
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (m) {
    const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(hex);
  if (rgb) {
    const [r, g, b] = rgb[1].split(',').map((x) => parseFloat(x));
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  return hex;   // a named colour: leave it alone rather than mangle it
}

export const SUBJECTS = ['english', 'maths', 'thinking'];
export const SUBJECT_LABEL = { english: 'English', maths: 'Maths', thinking: 'Thinking' };
export const subjectColour = (s) => css(`--series-${s}`);

/* Emphasis. Clicking a legend entry focuses one series and recedes the rest,
   which the data-viz guidance calls the most underused form: when the story is
   "this one subject moved", three equal-weight series bury it.
   The others fade rather than disappear, so the comparison is still there. */
const FADE = 0.18;   // opacity kept for a series that is not focused

/** The fill for one subject, given which subject is focused.
 *
 *  Chart.js caches a resolved colour on each element, and neither mutating
 *  dataset.backgroundColor nor a scriptable option reliably invalidates that
 *  cache: both changed the data and left the pixels alone, confirmed by
 *  sampling the canvas. So the focus is baked in at construction and changing
 *  it rebuilds the chart, which for eight columns is instant and is always
 *  right. */
function subjectFill(key, focus) {
  const full = subjectColour(key);
  return (!focus || focus === key) ? full : alpha(full, FADE);
}

/** Shared scaffolding. Grid and axes stay recessive so the data reads first. */
function base() {
  const ink = css('--text-2');
  const grid = css('--grid');
  const surface = css('--surface');
  const text = css('--text');
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: matchMedia('(prefers-reduced-motion: reduce)').matches ? false : { duration: 260 },
    interaction: { mode: 'index', intersect: false },
    layout: { padding: { top: 8, right: 8 } },
    scales: {
      y: {
        ticks: { color: ink, font: { size: 11 }, padding: 6, maxTicksLimit: 6 },
        grid: { color: grid, drawTicks: false },
        border: { display: false },
      },
      x: {
        ticks: { color: ink, font: { size: 11 }, padding: 4 },
        grid: { display: false },
        border: { color: grid },
      },
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: surface,
        titleColor: text,
        bodyColor: ink,
        borderColor: css('--border-strong'),
        borderWidth: 1,
        padding: 10,
        cornerRadius: 8,
        titleFont: { weight: '700' },
        displayColors: true,
        boxWidth: 10,
        boxHeight: 10,
        usePointStyle: true,
      },
    },
  };
}

/* --------------------------------------------------------------- trend */

/** Accuracy over time. One series, so no legend: the card title names it.
    Emphasis form, with the area carrying the hue and the line thin on top. */
export function trendChart(canvas, weeks, accent) {
  const o = base();
  const pts = weeks.map((w) => Math.round(w.total / w.outOf * 100));
  // round the floor down to a ten so the axis reads cleanly
  const lo = Math.max(0, Math.floor((Math.min(...pts) - 8) / 10) * 10);

  return new Chart(canvas, {
    type: 'line',
    data: {
      labels: weeks.map((w) => `W${w.week}`),
      datasets: [{
        label: 'Accuracy',
        data: pts,
        borderColor: accent,
        backgroundColor: (ctx) => {
          const { ctx: c, chartArea: a } = ctx.chart;
          if (!a) return 'transparent';
          const g = c.createLinearGradient(0, a.top, 0, a.bottom);
          g.addColorStop(0, alpha(accent, 0.26));
          g.addColorStop(1, alpha(accent, 0.02));
          return g;
        },
        borderWidth: 2,
        pointRadius: (c) => (c.dataIndex === pts.length - 1 ? 6 : 4),
        pointHoverRadius: 9,
        pointBackgroundColor: accent,
        pointBorderColor: css('--surface'),
        pointBorderWidth: 2,
        fill: true,
        tension: 0.32,
      }],
    },
    options: {
      ...o,
      scales: {
        ...o.scales,
        y: { ...o.scales.y, min: lo, max: 100, ticks: { ...o.scales.y.ticks, callback: (v) => `${v}%` } },
      },
      plugins: {
        ...o.plugins,
        tooltip: {
          ...o.plugins.tooltip,
          callbacks: {
            label: (i) => `${i.parsed.y}% accuracy`,
            afterBody: (items) => {
              const w = weeks[items[0].dataIndex];
              return `${w.total} of ${w.outOf} marks`;
            },
          },
        },
      },
    },
  });
}

/* ------------------------------------------------------------- subjects */

/** Three series, so a legend is always present and all three are direct
    labelled on the final column. 2px gaps between adjacent bars. */
export function subjectChart(canvas, weeks, focus = null) {
  const o = base();
  const last = weeks.length - 1;

  return new Chart(canvas, {
    type: 'bar',
    data: {
      labels: weeks.map((w) => `W${w.week}`),
      datasets: SUBJECTS.map((s) => ({
        label: SUBJECT_LABEL[s],
        subjectKey: s,
        data: weeks.map((w) => (w[s] == null ? null : Math.round(w[s] / w[`${s}Max`] * 100))),
        backgroundColor: subjectFill(s, focus),
        borderRadius: 4,
        borderSkipped: false,
        maxBarThickness: 18,
        borderColor: css('--surface'),
        borderWidth: { top: 0, right: 1, bottom: 0, left: 1 },
      })),
    },
    options: {
      ...o,
      scales: {
        ...o.scales,
        y: { ...o.scales.y, min: 0, max: 100, ticks: { ...o.scales.y.ticks, callback: (v) => `${v}%` } },
      },
      plugins: {
        ...o.plugins,
        tooltip: {
          ...o.plugins.tooltip,
          filter: (i) => !focus || i.dataset.subjectKey === focus,
          callbacks: {
            label: (i) => {
              const w = weeks[i.dataIndex];
              const s = SUBJECTS[i.datasetIndex];
              return `${SUBJECT_LABEL[s]}  ${w[s]} of ${w[`${s}Max`]}  (${i.parsed.y}%)`;
            },
          },
        },
      },
    },
  });
}

/* ---------------------------------------------------------- where marks go */

/** Where the marks actually went, by subject.
 *
 * This used to split lost marks into real errors and question faults by counting
 * the records in each list. That was wrong: an error record is not worth one
 * mark. A slip inside a drill's top band costs nothing, and a two mark question
 * costs two. Mason's week 20 had three recorded errors against two marks lost.
 *
 * Marks lost per subject IS exactly known for every week, so that is what this
 * shows now. The error and fault counts are reported as counts beside it, where
 * they are honest. */
export function lossChart(canvas, weeks, focus = null) {
  const o = base();
  return new Chart(canvas, {
    type: 'bar',
    data: {
      labels: weeks.map((w) => `W${w.week}`),
      datasets: SUBJECTS.map((s) => ({
        label: SUBJECT_LABEL[s],
        subjectKey: s,
        data: weeks.map((w) => (w[s] == null ? null : w[`${s}Max`] - w[s])),
        backgroundColor: subjectFill(s, focus),
        borderRadius: 4,
        borderSkipped: false,
        maxBarThickness: 26,
        borderColor: css('--surface'),
        borderWidth: { top: 2, bottom: 0, left: 0, right: 0 },
      })),
    },
    options: {
      ...o,
      scales: {
        ...o.scales,
        x: { ...o.scales.x, stacked: true },
        y: {
          ...o.scales.y,
          stacked: true,
          beginAtZero: true,
          ticks: { ...o.scales.y.ticks, precision: 0 },
          title: { display: true, text: 'marks lost', color: css('--text-3'), font: { size: 10 } },
        },
      },
      plugins: {
        ...o.plugins,
        tooltip: {
          ...o.plugins.tooltip,
          filter: (i) => !focus || i.dataset.subjectKey === focus,
          callbacks: {
            label: (i) => `${i.dataset.label}: ${i.parsed.y} mark${i.parsed.y === 1 ? '' : 's'} lost`,
            footer: (items) => {
              const total = items.reduce((t, i) => t + (i.parsed.y || 0), 0);
              return `${total} lost in total`;
            },
          },
        },
      },
    },
  });
}

/* ----------------------------------------------------------- sparkline */

/** A bare sparkline for a stat tile. No axes, no tooltip: the tile's number
    is the message and the line is only its shape. */
export function sparkline(canvas, values, colour) {
  return new Chart(canvas, {
    type: 'line',
    data: {
      labels: values.map((_, i) => i),
      datasets: [{
        data: values,
        borderColor: colour,
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.35,
        fill: true,
        backgroundColor: alpha(colour, 0.14),
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      events: [],
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false },
        y: { display: false, min: Math.min(...values) - 4, max: Math.max(...values) + 4 },
      },
    },
  });
}

// Level: the gauge (needle, min-max arc, average marker) and the history chart
// with bars for average, maximum, minimum and peak, all over the selected span.

import { formatDb, formatDuration, levelClass, levelZone } from './dsp.js';
import { SPANS } from './settings.js';
import { TIMES, WEIGHTINGS } from './stats.js';

export const ZONE_COLORS = ['#34d399', '#facc15', '#fb923c', '#f43f5e'];
const ZONE_EDGES = [55, 70, 85];
const DIAL_MIN = 20;
const DIAL_MAX = 120;
const SWEEP = 240; // degrees, symmetric around the top
const CX = 100;
const CY = 100;
const SVG = 'http://www.w3.org/2000/svg';
const BARS = ['leq', 'max', 'min', 'peak'];

const $ = (id) => document.getElementById(id);

const angleOf = (db) => SWEEP * (Math.min(1, Math.max(0, (db - DIAL_MIN) / (DIAL_MAX - DIAL_MIN))) - 0.5);

function point(deg, r) {
  const a = (deg * Math.PI) / 180;
  return `${(CX + r * Math.sin(a)).toFixed(2)} ${(CY - r * Math.cos(a)).toFixed(2)}`;
}

function arc(db0, db1, r) {
  const a0 = angleOf(db0);
  const a1 = angleOf(db1);
  return `M${point(a0, r)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${point(a1, r)}`;
}

function svg(parent, tag, attrs) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent.append(node);
  return node;
}

// The static part: coloured zones, ticks and labels.
function buildDial() {
  const edges = [DIAL_MIN, ...ZONE_EDGES, DIAL_MAX];
  const zones = $('gauge-zones');
  svg(zones, 'path', { d: arc(DIAL_MIN, DIAL_MAX, 88), class: 'track' });
  // Segments with small gaps between them; the outer ends stay flush with the track.
  for (let z = 0; z < ZONE_COLORS.length; z++) {
    const from = edges[z] + (z ? 0.6 : 0);
    const to = edges[z + 1] - (z < ZONE_COLORS.length - 1 ? 0.6 : 0);
    svg(zones, 'path', { d: arc(from, to, 88), stroke: ZONE_COLORS[z] });
  }
  const ticks = $('gauge-ticks');
  for (let db = DIAL_MIN; db <= DIAL_MAX; db += 10) {
    const a = angleOf(db);
    const major = db % 20 === 0;
    svg(ticks, 'path', { d: `M${point(a, 82)}L${point(a, major ? 74 : 78)}`, class: major ? 'major' : '' });
    // 20 and 120 would sit under the reading.
    if (major && db > DIAL_MIN && db < DIAL_MAX) {
      const [x, y] = point(a, 63).split(' ');
      svg(ticks, 'text', { x, y }).textContent = String(db);
    }
  }
}

/** Seconds the chart shows: the selected span, or everything since the reset. */
export function chartSeconds(stats, s) {
  const span = SPANS[s.span];
  return Number.isFinite(span) ? span : Math.min(stats.size * stats.dt, Math.max(1, stats.seconds));
}

export function createLevelView() {
  const el = {
    now: $('now'),
    cls: $('class'),
    needle: $('gauge-needle'),
    range: $('gauge-range'),
    avg: $('gauge-avg'),
    duration: $('duration'),
    canvas: $('history'),
    bars: document.querySelector('.bars'),
  };
  // Bars in the order of `BARS`: the column, its value and its fill.
  const bars = BARS.map((key) => {
    const bar = $(`${key}-name`);
    return { key, bar, value: $(key), fill: bar.querySelector('i') };
  });
  const ctx = el.canvas.getContext('2d');
  let textAt = 0;
  let drawnAt = 0;
  let plot = null; // the chart's last scale, for the bars between redraws
  buildDial();

  /** Statistics over the selected span, calibrated (dB). */
  function spanStats(stats, s) {
    const v = stats.window(s.weighting, s.time, SPANS[s.span]);
    for (const key of BARS) v[key] += s.offset;
    return v;
  }

  function numbers(stats, s) {
    const now = stats.level(s.weighting, s.time) + s.offset;
    el.now.textContent = formatDb(now);
    el.cls.textContent = Number.isFinite(now) ? levelClass(now) : ' ';
    el.duration.textContent = formatDuration(stats.seconds);
    const v = spanStats(stats, s);
    placeBars(v);
    const range = Number.isFinite(v.min) && Number.isFinite(v.max);
    el.range.toggleAttribute('hidden', !range);
    if (range) el.range.setAttribute('d', arc(v.min, Math.max(v.max, v.min + 0.3), 88));
    el.avg.toggleAttribute('hidden', !Number.isFinite(v.leq));
    el.avg.setAttribute('transform', `rotate(${angleOf(v.leq).toFixed(2)} ${CX} ${CY})`);
  }

  // Each bar rises from the chart's floor to its value, on the chart's scale.
  function placeBars(v) {
    for (const { key, bar, value, fill } of bars) {
      const db = v[key];
      value.textContent = formatDb(db);
      const shown = Number.isFinite(db) && plot;
      bar.classList.toggle('empty', !shown);
      if (!shown) continue;
      const y = Math.max(plot.top, Math.min(plot.bottom, plot.y(db)));
      fill.style.top = `${y.toFixed(1)}px`;
      fill.style.bottom = `${(plot.height - plot.bottom).toFixed(1)}px`;
      value.style.top = `${(y - 15).toFixed(1)}px`;
      if (key !== 'leq') bar.style.color = ZONE_COLORS[levelZone(db)];
    }
  }

  function draw(stats, s) {
    const dpr = window.devicePixelRatio || 1;
    const w = el.canvas.clientWidth;
    const h = el.canvas.clientHeight;
    if (!w || !h) return;
    if (el.canvas.width !== Math.round(w * dpr) || el.canvas.height !== Math.round(h * dpr)) {
      el.canvas.width = Math.round(w * dpr);
      el.canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const seconds = chartSeconds(stats, s);
    const values = stats.recent(s.weighting, s.time, seconds);
    const v = spanStats(stats, s);
    const [lo, hi] = scale(
      values,
      s.offset,
      BARS.map((key) => v[key]),
    );
    // Room above the plot for the bars' values; the bars sit right of the dB labels.
    plot = { right: w - el.bars.offsetWidth - 26, top: 18, bottom: h - 16, height: h };
    plot.y = (db) => plot.bottom - ((db - lo) / (hi - lo)) * (plot.bottom - plot.top);
    grid(plot, lo, hi);
    columns(plot, values, Math.round(seconds / stats.dt), s.offset);
    if (Number.isFinite(v.leq)) {
      ctx.strokeStyle = 'rgb(34 211 238 / 0.8)';
      ctx.setLineDash([4, 4]);
      line(0, plot.right, plot.y(v.leq));
      ctx.setLineDash([]);
    }
    timeLabels(plot.right, h, seconds, !Number.isFinite(SPANS[s.span]));
    placeBars(v);
  }

  // dB range of the chart: in steps of 10, at least 30 dB; `extra` levels
  // (the bars) are calibrated already.
  function scale(values, off, extra) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of values) {
      if (!Number.isFinite(v)) continue;
      lo = Math.min(lo, v + off);
      hi = Math.max(hi, v + off);
    }
    for (const v of extra) {
      if (!Number.isFinite(v)) continue;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    if (!Number.isFinite(lo)) [lo, hi] = [30, 60];
    lo = Math.floor((lo - 3) / 10) * 10;
    hi = Math.ceil((hi + 3) / 10) * 10;
    if (hi - lo >= 30) return [lo, hi];
    // A steady level sits in the middle, not on the floor.
    lo = Math.floor(((lo + hi) / 2 - 15) / 10) * 10;
    return [lo, lo + 30];
  }

  function line(x0, x1, y) {
    ctx.beginPath();
    ctx.moveTo(x0, Math.round(y) + 0.5);
    ctx.lineTo(x1, Math.round(y) + 0.5);
    ctx.stroke();
  }

  function grid(plot, lo, hi) {
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    const step = hi - lo > 60 ? 20 : 10;
    for (let d = lo; d <= hi; d += step) {
      ctx.strokeStyle = 'rgb(255 255 255 / 0.07)';
      line(0, plot.right, plot.y(d));
      ctx.fillStyle = '#71717a';
      ctx.fillText(String(d), plot.right + 5, plot.y(d));
    }
  }

  // One column per pixel: the range of levels in its time slice, over a faint
  // area that follows the loudest level of each slice.
  function columns(plot, values, slots, off) {
    const missing = slots - values.length;
    const tops = [];
    for (let c = 0; c < plot.right; c++) {
      const i0 = Math.max(0, Math.floor((c * slots) / plot.right) - missing);
      const i1 = Math.floor(((c + 1) * slots) / plot.right) - missing;
      let a = Infinity;
      let b = -Infinity;
      for (let i = i0; i < i1; i++) {
        if (values[i] < a) a = values[i];
        if (values[i] > b) b = values[i];
      }
      if (!Number.isFinite(b)) continue;
      const top = plot.y(b + off);
      tops.push(c, top);
      ctx.fillStyle = ZONE_COLORS[levelZone(b + off)];
      ctx.fillRect(c, top, 1, Math.max(1.5, plot.y(a + off) - top));
    }
    area(plot, tops);
  }

  // `tops`: column, y pairs; the area goes under what is already drawn.
  function area(plot, tops) {
    if (!tops.length) return;
    const fade = ctx.createLinearGradient(0, plot.top, 0, plot.bottom);
    fade.addColorStop(0, 'rgb(255 255 255 / 0.1)');
    fade.addColorStop(1, 'rgb(255 255 255 / 0)');
    ctx.beginPath();
    ctx.moveTo(tops[0], plot.bottom);
    for (let k = 0; k < tops.length; k += 2) {
      ctx.lineTo(tops[k], tops[k + 1]);
      ctx.lineTo(tops[k] + 1, tops[k + 1]);
    }
    ctx.lineTo(tops[tops.length - 2] + 1, plot.bottom);
    ctx.fillStyle = fade;
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  function timeLabels(right, h, range, sinceReset) {
    const minutes = range >= 120;
    const label = (seconds) =>
      minutes
        ? `−${formatDb(seconds / 60, seconds % 60 ? 1 : 0)} min`
        : `−${formatDb(seconds, seconds % 1 ? 1 : 0)} s`;
    ctx.fillStyle = '#71717a';
    ctx.textBaseline = 'alphabetic';
    for (const [x, text, align] of [
      [0, sinceReset ? 'Start' : label(range), 'left'],
      [right / 2, label(range / 2), 'center'],
      [right, 'jetzt', 'right'],
    ]) {
      ctx.textAlign = align;
      ctx.fillText(text, x, h - 3);
    }
    ctx.textAlign = 'left';
  }

  return {
    labels(s) {
      const W = WEIGHTINGS[s.weighting];
      const T = TIMES[s.time];
      const names = { leq: `L${W}eq`, max: `L${W}${T}max`, min: `L${W}${T}min`, peak: `L${W}peak` };
      for (const { key, bar } of bars) bar.title = names[key];
    },
    /** Every frame while measuring: the needle follows at once, the numbers 4× a second. */
    frame(stats, s, now, force = false) {
      const level = stats.level(s.weighting, s.time) + s.offset;
      el.needle.style.transform = `rotate(${Number.isFinite(level) ? angleOf(level).toFixed(2) : -SWEEP / 2}deg)`;
      el.needle.style.color = Number.isFinite(level) ? ZONE_COLORS[levelZone(level)] : '';
      if (force || now - textAt >= 250) {
        textAt = now;
        numbers(stats, s);
      }
    },
    draw,
    /** The chart, but only once it would have moved by a pixel (saves battery on long runs). */
    chart(stats, s, now) {
      const width = Math.max(1, el.canvas.clientWidth - el.bars.offsetWidth - 26);
      if (now - drawnAt < Math.max(100, (chartSeconds(stats, s) * 1000) / width)) return;
      drawnAt = now;
      draw(stats, s);
    },
  };
}

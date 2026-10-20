// Pegel tab: current level, bar, statistics and the history chart.

import { formatDb, formatDuration, levelClass, levelZone } from './dsp.js';
import { TIMES, WEIGHTINGS } from './stats.js';

export const ZONE_COLORS = ['#34d399', '#facc15', '#fb923c', '#f43f5e'];
const TIME_NAMES = ['Fast', 'Slow'];
const BAR_MIN = 20;
const BAR_MAX = 120;

const $ = (id) => document.getElementById(id);

export function createLevelView() {
  const el = {
    now: $('now'),
    cls: $('class'),
    fill: $('meter-fill'),
    maxMark: $('meter-max'),
    leq: $('leq'),
    max: $('max'),
    min: $('min'),
    peak: $('peak'),
    duration: $('duration'),
    leqName: $('leq-name'),
    maxName: $('max-name'),
    weighting: $('weighting'),
    timing: $('timing'),
    range: $('range'),
    canvas: $('history'),
  };
  const ctx = el.canvas.getContext('2d');
  let textAt = 0;
  let drawnAt = 0;

  const bar = (db) => Math.min(1, Math.max(0, (db - BAR_MIN) / (BAR_MAX - BAR_MIN)));

  function numbers(stats, s) {
    const w = s.weighting;
    const t = s.time;
    const off = s.offset;
    const now = stats.level(w, t) + off;
    el.now.textContent = formatDb(now);
    el.cls.textContent = Number.isFinite(now) ? levelClass(now) : ' ';
    el.leq.textContent = formatDb(stats.leq(w) + off);
    el.max.textContent = formatDb(stats.max(w, t) + off);
    el.min.textContent = formatDb(stats.min(w, t) + off);
    el.peak.textContent = formatDb(stats.peak(w) + off);
    el.duration.textContent = formatDuration(stats.seconds);
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

    const values = stats.recent(s.weighting, s.time, s.range);
    const [lo, hi] = scale(values, s.offset);
    const plot = { right: w - 26, top: 6, bottom: h - 16 };
    plot.y = (db) => plot.bottom - ((db - lo) / (hi - lo)) * (plot.bottom - plot.top);
    grid(plot, lo, hi);
    columns(plot, values, Math.round(s.range / stats.dt), s.offset);
    const leq = stats.leq(s.weighting) + s.offset;
    if (Number.isFinite(leq)) {
      ctx.strokeStyle = 'rgb(244 244 245 / 0.7)';
      ctx.setLineDash([4, 4]);
      line(0, plot.right, plot.y(leq));
      ctx.setLineDash([]);
    }
    timeLabels(plot.right, h, s.range);
  }

  // dB range of the chart: in steps of 10, at least 30 dB.
  function scale(values, off) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of values) {
      if (!Number.isFinite(v)) continue;
      lo = Math.min(lo, v + off);
      hi = Math.max(hi, v + off);
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

  // One column per pixel: the range of levels in its time slice.
  function columns(plot, values, slots, off) {
    const missing = slots - values.length;
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
      ctx.fillStyle = ZONE_COLORS[levelZone(b + off)];
      ctx.fillRect(c, plot.y(b + off), 1, Math.max(1.5, plot.y(a + off) - plot.y(b + off)));
    }
  }

  function timeLabels(right, h, range) {
    const minutes = range >= 120;
    const label = (seconds) => (minutes ? `−${seconds / 60} min` : `−${seconds} s`);
    ctx.fillStyle = '#71717a';
    ctx.textBaseline = 'alphabetic';
    for (const [x, text, align] of [
      [0, label(range), 'left'],
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
      el.weighting.textContent = `dB(${W})`;
      el.timing.textContent = TIME_NAMES[s.time];
      el.leqName.textContent = `L${W}eq`;
      el.maxName.textContent = `L${W}${T}max`;
      el.range.textContent = s.range >= 120 ? `${s.range / 60} min` : `${s.range} s`;
    },
    /** Every frame while measuring: the bar follows at once, the numbers 4× a second. */
    frame(stats, s, now, force = false) {
      const level = stats.level(s.weighting, s.time) + s.offset;
      el.fill.style.transform = `scaleX(${bar(level)})`;
      el.fill.style.backgroundColor = ZONE_COLORS[levelZone(level)];
      const max = stats.max(s.weighting, s.time) + s.offset;
      el.maxMark.style.left = `${bar(max) * 100}%`;
      el.maxMark.hidden = !Number.isFinite(max);
      if (force || now - textAt >= 250) {
        textAt = now;
        numbers(stats, s);
      }
    },
    draw,
    /** The chart, but only once it would have moved by a pixel (saves battery on long runs). */
    chart(stats, s, now) {
      const width = Math.max(1, el.canvas.clientWidth - 26);
      if (now - drawnAt < Math.max(100, (s.range * 1000) / width)) return;
      drawnAt = now;
      draw(stats, s);
    },
  };
}

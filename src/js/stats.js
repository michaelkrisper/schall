// What the level meter has seen since the last reset: current level, minimum,
// maximum, Leq and peak for every frequency and time weighting, the same over
// the last seconds (`window`), plus a history for the chart. Levels are dB relative to digital full scale; the calibration
// offset is only added for display.

import { powerToDb } from './dsp.js';

export const WEIGHTINGS = ['A', 'C', 'Z'];
export const TIMES = ['F', 'S'];

// Layout of a report from the DSP core (wasm/src/lib.rs, write_report): sample
// count and seconds, then eight groups of A, C, Z mean squares.
const SUM = 2;
const PEAK = 5;
const FAST = 8;
const SLOW = 11;
const FAST_MIN = 14;
const FAST_MAX = 17;
const SLOW_MIN = 20;
const SLOW_MAX = 23;
export const REPORT_LENGTH = 26;

export class LevelStats {
  constructor({ reportSeconds = 0.05, historySeconds = 3600, windowSeconds = 60, settleSeconds = 0.5 } = {}) {
    this.dt = reportSeconds;
    this.size = Math.round(historySeconds / reportSeconds);
    this.history = WEIGHTINGS.map(() => TIMES.map(() => new Float32Array(this.size)));
    // Per report, for statistics over the last seconds: samples, energy, peak,
    // minimum and maximum (mean squares).
    this.ring = Math.max(1, Math.round(windowSeconds / reportSeconds));
    this.ringN = new Float64Array(this.ring);
    this.ringSum = WEIGHTINGS.map(() => new Float64Array(this.ring));
    this.ringPeak = WEIGHTINGS.map(() => new Float64Array(this.ring));
    this.ringMin = WEIGHTINGS.map(() => TIMES.map(() => new Float64Array(this.ring)));
    this.ringMax = WEIGHTINGS.map(() => TIMES.map(() => new Float64Array(this.ring)));
    this.reports = 0;
    this.current = WEIGHTINGS.map(() => TIMES.map(() => -Infinity));
    this.reset();
    // The microphone pops and the filters ring for a moment after the start.
    this.skip = Math.round(settleSeconds / reportSeconds);
  }

  reset() {
    this.skip = 0;
    this.n = 0;
    this.slots = 0; // reports in the ring since the reset
    this.seconds = 0;
    this.energy = WEIGHTINGS.map(() => 0);
    this.peakPower = WEIGHTINGS.map(() => 0);
    this.minPower = WEIGHTINGS.map(() => TIMES.map(() => Infinity));
    this.maxPower = WEIGHTINGS.map(() => TIMES.map(() => 0));
  }

  add(report) {
    const slot = this.reports++ % this.size;
    for (let w = 0; w < WEIGHTINGS.length; w++) {
      const levels = [powerToDb(report[FAST + w]), powerToDb(report[SLOW + w])];
      for (let t = 0; t < TIMES.length; t++) {
        this.current[w][t] = levels[t];
        // The chart leaves out the settling, like the statistics.
        this.history[w][t][slot] = this.skip > 0 ? Number.NaN : levels[t];
      }
    }
    if (this.skip > 0) {
      this.skip--;
      return;
    }
    this.n += report[0];
    this.seconds += report[1];
    const r = this.slots++ % this.ring;
    this.ringN[r] = report[0];
    for (let w = 0; w < WEIGHTINGS.length; w++) {
      this.energy[w] += report[SUM + w];
      this.peakPower[w] = Math.max(this.peakPower[w], report[PEAK + w]);
      this.ringSum[w][r] = report[SUM + w];
      this.ringPeak[w][r] = report[PEAK + w];
      const mins = [report[FAST_MIN + w], report[SLOW_MIN + w]];
      const maxs = [report[FAST_MAX + w], report[SLOW_MAX + w]];
      for (let t = 0; t < TIMES.length; t++) {
        this.minPower[w][t] = Math.min(this.minPower[w][t], mins[t]);
        this.maxPower[w][t] = Math.max(this.maxPower[w][t], maxs[t]);
        this.ringMin[w][t][r] = mins[t];
        this.ringMax[w][t][r] = maxs[t];
      }
    }
  }

  /**
   * Leq, minimum, maximum and peak in dB over the last `seconds` (at most the
   * window given to the constructor), or since the reset for Infinity.
   */
  window(w, t, seconds) {
    if (!Number.isFinite(seconds)) {
      return { leq: this.leq(w), min: this.min(w, t), max: this.max(w, t), peak: this.peak(w) };
    }
    const count = Math.min(this.slots, this.ring, Math.round(seconds / this.dt));
    let n = 0;
    let sum = 0;
    let peak = 0;
    let min = Infinity;
    let max = 0;
    for (let k = this.slots - count; k < this.slots; k++) {
      const r = k % this.ring;
      n += this.ringN[r];
      sum += this.ringSum[w][r];
      peak = Math.max(peak, this.ringPeak[w][r]);
      min = Math.min(min, this.ringMin[w][t][r]);
      max = Math.max(max, this.ringMax[w][t][r]);
    }
    return {
      leq: n ? powerToDb(sum / n) : -Infinity,
      min: Number.isFinite(min) ? powerToDb(min) : -Infinity,
      max: powerToDb(max),
      peak: powerToDb(peak),
    };
  }

  level(w, t) {
    return this.current[w][t];
  }

  leq(w) {
    return this.n ? powerToDb(this.energy[w] / this.n) : -Infinity;
  }

  min(w, t) {
    return Number.isFinite(this.minPower[w][t]) ? powerToDb(this.minPower[w][t]) : -Infinity;
  }

  max(w, t) {
    return powerToDb(this.maxPower[w][t]);
  }

  peak(w) {
    return powerToDb(this.peakPower[w]);
  }

  // The last `seconds` of levels, oldest first (shorter right after the start).
  recent(w, t, seconds) {
    const count = Math.min(this.reports, this.size, Math.round(seconds / this.dt));
    const ring = this.history[w][t];
    const out = new Float32Array(count);
    const start = this.reports - count;
    for (let i = 0; i < count; i++) out[i] = ring[(start + i) % this.size];
    return out;
  }
}

// The WebAssembly DSP core against reference values: levels of known signals,
// weighting curves, the FFT against a plain DFT, peak detection, averaging.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { columnEdges, FFT_SIZE, findPeaks, harmonics, powerToDb, weightingCurve } from '../src/js/dsp.js';
import { LevelStats } from '../src/js/stats.js';
import { loadCore, noise, sine, sum } from './core.js';

const near = (actual, expected, tolerance, what = '') =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what} ${actual.toFixed(4)} is not within ±${tolerance} of ${expected.toFixed(4)}`,
  );

async function measure(signal, seconds, fs = 48000, options = {}) {
  const core = await loadCore(fs, options);
  const stats = new LevelStats();
  for (const report of core.feed(signal, seconds).reports) stats.add(report);
  return stats;
}

describe('level meter', () => {
  it('reads a 1 kHz sine at its RMS level in every weighting', async () => {
    const stats = await measure(sine(1000, -20), 2);
    for (let w = 0; w < 3; w++) {
      near(stats.leq(w), -20, 0.02, `Leq[${w}]`);
      near(stats.level(w, 0), -20, 0.02, `Fast[${w}]`);
      // Slow still carries a trace of the start-up after 1.5 s.
      near(stats.level(w, 1), -20, 0.1, `Slow[${w}]`);
      near(stats.max(w, 0), -20, 0.05, `FastMax[${w}]`);
      near(stats.min(w, 0), -20, 0.05, `FastMin[${w}]`);
      near(stats.peak(w), -20 + 10 * Math.log10(2), 0.02, `Peak[${w}]`);
    }
    near(stats.seconds, 1.5, 0.06, 'measured time after settling');
  });

  for (const [fs, hz] of [
    [48000, 31.5],
    [48000, 100],
    [48000, 4000],
    [44100, 8000],
    [44100, 12500],
  ]) {
    it(`weights a ${hz} Hz sine at ${fs} Hz like IEC 61672`, async () => {
      const stats = await measure(sine(hz, -30), 2, fs);
      near(stats.leq(0), -30 + weightingCurve('A', hz), 0.1, 'A');
      near(stats.leq(1), -30 + weightingCurve('C', hz), 0.1, 'C');
      near(stats.leq(2), -30, 0.1, 'Z');
    });
  }

  it('gives the same result for any render quantum size and at 96 kHz', async () => {
    for (const [fs, quantum] of [
      [48000, 256],
      [48000, 1024],
      [96000, 128],
    ]) {
      const stats = await measure(sine(1000, -20), 2, fs, { quantum });
      near(stats.leq(0), -20, 0.02, `Leq at ${fs} Hz, ${quantum} per block`);
      near(stats.seconds, 1.5, 0.06, `time at ${fs} Hz, ${quantum} per block`);
    }
  });

  it('ignores a DC offset of the microphone', async () => {
    const tone = sine(1000, -40);
    const stats = await measure((t) => 0.3 + tone(t), 3);
    for (let w = 0; w < 3; w++) near(stats.level(w, 0), -40, 0.1, `Fast[${w}]`);
  });

  it('reads a full-scale square wave without overflow', async () => {
    const stats = await measure((t) => (Math.sin(2 * Math.PI * 1000 * t) >= 0 ? 1 : -1), 2);
    near(stats.leq(2), 0, 0.1, 'Z Leq');
    assert.ok(stats.peak(2) >= -0.1 && stats.peak(2) < 0.5, `Z peak ${stats.peak(2)}`);
  });

  it('stays finite on digital silence', async () => {
    const core = await loadCore();
    const stats = new LevelStats();
    for (const r of core.feed(() => 0, 1).reports) stats.add(r);
    assert.equal(stats.leq(0), -Infinity);
    const db = core.averageDb();
    assert.ok(
      db.every((v) => v <= -290 && !Number.isNaN(v)),
      'silence reads about -300 dB, never NaN',
    );
    assert.deepEqual(findPeaks(db, core.binHz), []);
  });

  it('follows a level step with Fast at once and with Slow within seconds', async () => {
    const core = await loadCore();
    const stats = new LevelStats();
    for (const r of core.feed(sine(1000, -50), 1).reports) stats.add(r);
    for (const r of core.feed(sine(1000, -20), 0.5).reports) stats.add(r);
    near(stats.level(0, 0), -20, 0.1, 'Fast after 0.5 s');
    assert.ok(stats.level(0, 1) < -21, 'Slow still rising after 0.5 s');
    for (const r of core.feed(sine(1000, -20), 6).reports) stats.add(r);
    near(stats.level(0, 1), -20, 0.05, 'Slow after 6.5 s');
    near(stats.min(0, 0), -50, 0.1, 'minimum');
    near(stats.max(0, 0), -20, 0.1, 'maximum');
    // Energy mean of 0.5 s at -50 dB (after settling) and 6.5 s at -20 dB.
    near(stats.leq(0), powerToDb((0.5 * 1e-5 + 6.5 * 1e-2) / 7), 0.05, 'Leq');
  });
});

describe('spectrum', () => {
  it('matches a plain DFT with the same window', async () => {
    const core = await loadCore();
    const n = FFT_SIZE;
    const random = noise(-10, 7);
    const samples = Float32Array.from({ length: n }, random);
    core.feedSamples(samples);
    const power = core.power();
    const a = [0.35875, 0.48829, 0.14128, 0.01168];
    const w = (i) =>
      a[0] -
      a[1] * Math.cos((2 * Math.PI * i) / n) +
      a[2] * Math.cos((4 * Math.PI * i) / n) -
      a[3] * Math.cos((6 * Math.PI * i) / n);
    const scale = 2 / (n * a[0]) ** 2;
    for (const k of [1, 2, 3, 4, 5, 77, 1000, 4096, 6001, 8188, 8191]) {
      let re = 0;
      let im = 0;
      for (let i = 0; i < n; i++) {
        const v = samples[i] * w(i);
        re += v * Math.cos((2 * Math.PI * k * i) / n);
        im -= v * Math.sin((2 * Math.PI * k * i) / n);
      }
      near(powerToDb(power[k]), powerToDb((re * re + im * im) * scale), 0.01, `bin ${k}`);
    }
  });

  it('computes dB with SIMD to within 0.001 dB', async () => {
    const core = await loadCore();
    core.x.set_mode(0);
    core.feed(noise(-30, 3), FFT_SIZE / 48000); // exactly one spectrum, so the average is that spectrum
    const power = core.power();
    const db = core.averageDb();
    let worst = 0;
    for (let k = 1; k < core.bins; k++) worst = Math.max(worst, Math.abs(db[k] - powerToDb(power[k])));
    assert.ok(worst < 0.001, `worst error ${worst} dB`);
  });

  for (const hz of [50, 440, 1001.3, 7777]) {
    it(`finds a ${hz} Hz tone in noise to within 0.1 Hz and 0.3 dB`, async () => {
      const core = await loadCore();
      const signal = sum(sine(hz, -30), noise(-60));
      core.feed(signal, 0.5);
      core.x.set_mode(2);
      core.x.reset_spectrum();
      core.feed(signal, 1);
      const [peak] = findPeaks(core.averageDb(), core.binHz);
      near(peak.hz, hz, 0.1, 'frequency');
      near(peak.db, -30, 0.3, 'level');
    });
  }

  it('separates a tone 50 dB weaker next to a strong one', async () => {
    const core = await loadCore();
    core.x.set_mode(2);
    core.feed(sum(sine(1000, -20), sine(1300, -70), noise(-110)), 2);
    const peaks = findPeaks(core.averageDb(), core.binHz);
    assert.equal(peaks.length, 2, JSON.stringify(peaks));
    near(peaks[0].hz, 1000, 0.1);
    near(peaks[1].hz, 1300, 0.1);
    near(peaks[1].db, -70, 0.5);
  });

  it('labels the harmonics of a motor-like sound', async () => {
    const core = await loadCore();
    core.x.set_mode(2);
    core.feed(sum(sine(120, -30), sine(240, -36), sine(360, -40), sine(1050, -45), noise(-80)), 2);
    const peaks = findPeaks(core.averageDb(), core.binHz);
    assert.deepEqual(
      peaks.map((p) => Math.round(p.hz)),
      [120, 240, 360, 1050],
    );
    assert.deepEqual(harmonics(peaks, core.binHz), [null, { of: 0, k: 2 }, { of: 0, k: 3 }, null]);
  });

  it('averages over 1 s, 10 s or everything since the reset', async () => {
    const core = await loadCore();
    // On bin centres, so the reading is not lowered by the window's scalloping.
    const low = 171 * core.binHz;
    const high = 683 * core.binHz;
    core.feed(sine(low, -20), 5);
    core.x.reset_spectrum();
    core.feed(sine(low, -20), 5);
    core.feed(sine(high, -20), 5);
    const at = (db, hz) => db[Math.round((hz === 500 ? low : high) / core.binHz)];
    core.x.set_mode(0);
    let db = core.averageDb();
    near(at(db, 500), -20 - 5 * 10 * Math.log10(Math.E), 1, '1 s: 500 Hz has faded for 5 s');
    near(at(db, 2000), -20, 1, '1 s: 2000 Hz');
    core.x.set_mode(2);
    db = core.averageDb();
    // Frames across the switch count less than their share: power goes with the square.
    near(at(db, 500), -23, 0.4, 'total: half the time at 500 Hz');
    near(at(db, 2000), -23, 0.4, 'total: half the time at 2000 Hz');
    core.x.set_mode(1);
    db = core.averageDb();
    // Exponential with τ = 10 s: after 5 s the old tone still has e^-0.5 of the weight.
    near(at(db, 500), -20 + 10 * Math.log10(Math.exp(-0.5)), 0.4, '10 s: 500 Hz');
    near(at(db, 2000), -20 + 10 * Math.log10(1 - Math.exp(-0.5)), 0.4, '10 s: 2000 Hz');
  });

  it('forgets everything before a reset in the total average', async () => {
    const core = await loadCore();
    core.x.set_mode(2);
    core.feed(sine(1000, -20), 1);
    // The reset clears the averages, not the 341 ms window: let it move on first.
    core.feed(sine(2000, -20), 0.5);
    core.x.reset_spectrum();
    core.feed(sine(2000, -20), 1);
    const db = core.averageDb();
    assert.ok(db[Math.round(1000 / core.binHz)] < -100, '1 kHz gone');
    near(findPeaks(db, core.binHz)[0].hz, 2000, 0.1, 'only 2 kHz');
  });

  it('rejects unsupported sizes', async () => {
    const { x } = await loadCore();
    assert.equal(x.setup(48000, 1000, 128, 2400), 1, 'not a power of two');
    assert.equal(x.setup(48000, 32768, 128, 2400), 1, 'too large');
    assert.equal(x.setup(48000, 1024, 2048, 2400), 1, 'hop longer than the window');
    assert.equal(x.columns(4097), 1, 'too many columns');
    assert.equal(x.setup(48000, 4096, 512, 2400), 0, 'a smaller FFT is fine');
    assert.equal(x.bins(), 2048);
  });

  it('pools bins into logarithmic display columns', async () => {
    const core = await loadCore();
    const width = 600;
    core.setColumns(columnEdges(width, 20, 20000, core.binHz));
    core.feed(sum(sine(1000, -20), sine(15000, -40), noise(-100)), 1);
    const live = core.live();
    const column = (hz) => Math.floor((width * Math.log(hz / 20)) / Math.log(1000));
    // Narrow columns interpolate (a little below the true peak), wide ones take the maximum.
    near(Math.max(...live.slice(column(1000) - 2, column(1000) + 3)), -20, 1, '1 kHz');
    near(live[column(15000)], -40, 1, '15 kHz');
    assert.ok(live[column(5000)] < -80, 'nothing at 5 kHz');
  });

  it('runs at a tiny fraction of real time', async () => {
    const core = await loadCore();
    const signal = sum(sine(440, -20), noise(-50));
    core.feed(signal, 1);
    const seconds = 20;
    const samples = Float32Array.from({ length: Math.round(seconds * core.fs) }, (_, i) =>
      signal(i / core.fs),
    );
    const start = performance.now();
    core.feedSamples(samples);
    const ms = performance.now() - start;
    console.info(
      `DSP core: ${seconds} s of audio in ${ms.toFixed(1)} ms (${((100 * ms) / 1000 / seconds).toFixed(3)} % of real time)`,
    );
    assert.ok(ms < seconds * 1000 * 0.05);
  });
});

// The JavaScript side of the maths: weighting filter design, notes, peak
// finding on synthetic spectra, number formatting, statistics, WAV header.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  columnEdges,
  filterResponse,
  findPeaks,
  formatDb,
  formatDuration,
  formatHz,
  harmonics,
  hopFor,
  levelClass,
  levelZone,
  noteOf,
  packFilters,
  weightingCurve,
  weightingFilter,
} from '../src/js/dsp.js';
import { fileName, wavHeader } from '../src/js/recorder.js';
import { LevelStats, REPORT_LENGTH } from '../src/js/stats.js';

// IEC 61672-1:2013, Table 3: nominal weightings at the exact base-10 third-octave frequencies.
const IEC = {
  31.5: [-39.4, -3.0],
  63: [-26.2, -0.8],
  125: [-16.1, -0.2],
  250: [-8.6, 0],
  500: [-3.2, 0],
  1000: [0, 0],
  2000: [1.2, -0.2],
  4000: [1.0, -0.8],
  8000: [-1.1, -3.0],
  16000: [-6.6, -8.5],
};
const exact = (nominal) => 1000 * 10 ** (Math.round(10 * Math.log10(nominal / 1000)) / 10);

describe('weighting filters', () => {
  for (const fs of [44100, 48000]) {
    it(`match IEC 61672 at ${fs} Hz`, () => {
      const a = weightingFilter('A', fs);
      const c = weightingFilter('C', fs);
      for (const [nominal, [da, dc]] of Object.entries(IEC)) {
        const f = exact(Number(nominal));
        // 0.05 rounding of the table plus a little filter error; 16 kHz is
        // close to Nyquist where class 1 allows +3.5/-17 dB anyway.
        const tolerance = f > 12000 ? 0.4 : 0.1;
        assert.ok(Math.abs(filterResponse(a, f, fs) - da) <= tolerance, `A at ${f.toFixed(0)} Hz`);
        assert.ok(Math.abs(filterResponse(c, f, fs) - dc) <= tolerance, `C at ${f.toFixed(0)} Hz`);
      }
    });
  }

  it('follow the analog curve to 0.05 dB up to 12.5 kHz', () => {
    for (const w of ['A', 'C', 'Z']) {
      const sections = weightingFilter(w, 48000);
      for (let f = 20; f <= 12500; f *= 1.05) {
        const error = filterResponse(sections, f, 48000) - weightingCurve(w, f);
        assert.ok(Math.abs(error) < (w === 'Z' ? 0.1 : 0.05), `${w} at ${f.toFixed(0)} Hz: ${error}`);
      }
    }
  });

  it('are packed as three A, three C and one Z biquad', () => {
    const packed = packFilters(48000);
    assert.equal(packed.length, 35);
    assert.deepEqual([...packed.slice(25, 30)], [1, 0, 0, 0, 0]);
  });
});

describe('notes and peaks', () => {
  it('names notes in German with cents', () => {
    assert.deepEqual(noteOf(440), { name: 'A4', cents: 0 });
    assert.deepEqual(noteOf(261.63), { name: 'C4', cents: 0 });
    assert.deepEqual(noteOf(493.88), { name: 'H4', cents: 0 });
    assert.deepEqual(noteOf(466.16), { name: 'B4', cents: 0 });
    assert.deepEqual(noteOf(1000), { name: 'H5', cents: 21 });
    assert.equal(noteOf(445).cents, 20);
  });

  it('finds tones on a noisy floor and ignores the floor', () => {
    const binHz = 48000 / 16384;
    const db = Float32Array.from({ length: 8192 }, (_, i) => -90 + 3 * Math.sin(i * 1.7));
    const tone = (hz, level) => {
      const centre = hz / binHz;
      for (let k = Math.floor(centre) - 4; k <= Math.ceil(centre) + 4; k++) {
        db[k] = Math.max(db[k], level - 6 * (k - centre) ** 2);
      }
    };
    tone(100, -30);
    tone(300, -40);
    tone(3000, -50);
    const peaks = findPeaks(db, binHz);
    assert.deepEqual(
      peaks.map((p) => Math.round(p.hz)),
      [100, 300, 3000],
    );
    assert.ok(Math.abs(peaks[0].db + 30) < 0.01);
    assert.deepEqual(
      harmonics(peaks, binHz),
      // 300 Hz is 3× 100 Hz; 3000 Hz would be 30× (beyond 16×) but is 10× 300 Hz.
      [null, { of: 0, k: 3 }, { of: 1, k: 10 }],
    );
  });

  it('covers the whole musical range', () => {
    assert.deepEqual(noteOf(27.5), { name: 'A0', cents: 0 });
    assert.deepEqual(noteOf(4186.01), { name: 'C8', cents: 0 });
    assert.deepEqual(noteOf(16.35), { name: 'C0', cents: 0 });
  });

  it('respects the count and the frequency range, and finds nothing in silence', () => {
    const binHz = 48000 / 16384;
    const db = new Float32Array(8192).fill(-90);
    for (const hz of [60, 120, 500, 1000, 15000]) db[Math.round(hz / binHz)] = -40;
    assert.equal(findPeaks(db, binHz, { count: 2 }).length, 2);
    const mid = findPeaks(db, binHz, { minHz: 100, maxHz: 2000 }).map((p) => Math.round(p.hz / 10) * 10);
    assert.deepEqual(
      mid.sort((a, b) => a - b),
      [120, 500, 1000],
    );
    assert.deepEqual(findPeaks(new Float32Array(8192).fill(-300), binHz), []);
  });

  it('spreads display columns logarithmically', () => {
    const edges = columnEdges(100, 20, 20000, 3);
    assert.equal(edges.length, 200);
    assert.ok(Math.abs(edges[0] - 20 / 3) < 1e-4);
    assert.ok(Math.abs(edges[199] - 20000 / 3) < 0.01);
    for (let c = 1; c < 100; c++) assert.ok(Math.abs(edges[2 * c] - edges[2 * c - 1]) < 1e-3);
  });

  it('uses a hop of about 21 ms in whole render quanta', () => {
    assert.equal(hopFor(48000), 1024);
    assert.equal(hopFor(44100), 896);
    assert.equal(hopFor(96000), 2048);
  });
});

describe('formatting', () => {
  it('writes numbers the Austrian way', () => {
    assert.equal(formatDb(57.25), '57,3');
    assert.equal(formatDb(-Infinity), '–');
    assert.equal(formatHz(49.94), '49,9 Hz');
    assert.equal(formatHz(440.2), '440 Hz');
    assert.equal(formatHz(1250), '1,25 kHz');
    assert.equal(formatHz(12345), '12,3 kHz');
    assert.equal(formatDuration(5.9), '0:05');
    assert.equal(formatDuration(3725), '1:02:05');
  });

  it('describes levels in everyday terms', () => {
    assert.equal(levelClass(30), 'Flüstern');
    assert.equal(levelClass(62), 'Normales Gespräch');
    assert.equal(levelClass(130), 'Schmerzgrenze');
    assert.deepEqual([40, 60, 80, 90].map(levelZone), [0, 1, 2, 3]);
  });
});

describe('level statistics', () => {
  const report = (power, fill = {}) => {
    const r = new Float64Array(REPORT_LENGTH);
    r[0] = 2400;
    r[1] = 0.05;
    for (let w = 0; w < 3; w++) {
      r[2 + w] = power * 2400;
      r[5 + w] = fill.peak ?? power * 2;
      for (const g of [8, 11, 14, 17, 20, 23]) r[g + w] = power;
    }
    return r;
  };

  it('keeps a ring of the last levels', () => {
    const stats = new LevelStats({ historySeconds: 0.2, settleSeconds: 0 });
    for (let i = 1; i <= 6; i++) stats.add(report(10 ** (-i / 10)));
    assert.deepEqual([...stats.recent(0, 0, 10)], [-3, -4, -5, -6]);
    assert.deepEqual([...stats.recent(0, 1, 0.1)], [-5, -6]);
  });

  it('reports nothing before the first measurement', () => {
    const stats = new LevelStats();
    assert.equal(stats.leq(0), -Infinity);
    assert.equal(stats.min(0, 0), -Infinity);
    assert.equal(stats.max(0, 0), -Infinity);
    assert.equal(stats.level(0, 0), -Infinity);
    assert.equal(stats.recent(0, 0, 60).length, 0);
  });

  it('skips the settling time, then averages energy', () => {
    const stats = new LevelStats({ settleSeconds: 0.1 });
    stats.add(report(1));
    stats.add(report(1));
    assert.equal(stats.seconds, 0);
    stats.add(report(0.01));
    stats.add(report(0.0001));
    assert.ok(Math.abs(stats.leq(0) - 10 * Math.log10(0.00505)) < 1e-9);
    assert.equal(stats.max(0, 0), -20);
    assert.equal(stats.min(0, 0), -40);
    assert.ok(Math.abs(stats.peak(0) - 10 * Math.log10(0.02)) < 1e-9);
    assert.ok(Math.abs(stats.seconds - 0.1) < 1e-9);
    const recent = stats.recent(0, 0, 1);
    assert.equal(recent.length, 4);
    assert.ok(Number.isNaN(recent[0]) && Number.isNaN(recent[1]));
    assert.deepEqual([...recent.slice(2)], [-20, -40]);
    stats.reset();
    assert.equal(stats.leq(0), -Infinity);
    assert.equal(stats.level(0, 0), -40);
  });
});

describe('recording files', () => {
  it('have a valid 16-bit mono WAV header', () => {
    const view = new DataView(wavHeader(48000, 48000));
    const text = (offset) => String.fromCharCode(...new Uint8Array(view.buffer, offset, 4));
    assert.equal(text(0), 'RIFF');
    assert.equal(view.getUint32(4, true), 36 + 96000);
    assert.equal(text(8), 'WAVE');
    assert.equal(view.getUint16(22, true), 1);
    assert.equal(view.getUint32(24, true), 48000);
    assert.equal(view.getUint16(34, true), 16);
    assert.equal(text(36), 'data');
    assert.equal(view.getUint32(40, true), 96000);
  });

  it('are named after their start time', () => {
    assert.equal(fileName(new Date(2026, 9, 20, 21, 5, 9).getTime()), 'schall-2026-10-20-210509.wav');
  });
});

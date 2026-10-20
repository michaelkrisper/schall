// The tone tracker: steady tones first, transients behind, drift followed,
// windows respected; on synthetic spectra and on the real DSP core.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findPeaks } from '../src/js/dsp.js';
import { ToneTracker, WINDOWS } from '../src/js/tracker.js';
import { loadCore, noise, sine, sum } from './core.js';

const BIN_HZ = 48000 / 16384;

// A spectrum in dB per bin: a floor of -90 dB plus tones as narrow peaks.
function spectrum(tones) {
  const db = new Float32Array(8192).fill(-90);
  for (const [hz, level] of tones) {
    const centre = hz / BIN_HZ;
    for (let k = Math.floor(centre) - 4; k <= Math.ceil(centre) + 4; k++) {
      db[k] = Math.max(db[k], level - 6 * (k - centre) ** 2);
    }
  }
  return db;
}

// Deterministic pseudo-random numbers for the transients.
function random(seed = 3) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

describe('tone tracker', () => {
  it('puts a quiet steady tone ahead of loud short ones', () => {
    const tracker = new ToneTracker(BIN_HZ);
    const next = random();
    for (let u = 0; u < 40; u++) {
      tracker.update(
        spectrum([
          [300, -50],
          [1000 + next() * 7000, -20],
        ]),
      );
    }
    const ranked = tracker.ranked(WINDOWS[1]);
    assert.equal(ranked.length, 1, 'tones heard only once are not listed');
    assert.ok(Math.abs(ranked[0].hz - 300) < 0.2, `first: ${ranked[0].hz}`);
    assert.equal(ranked[0].presence, 1);
    assert.ok(Math.abs(ranked[0].level + 50) < 0.1);
  });

  it('still ranks a louder tone first when it is there most of the time', () => {
    const tracker = new ToneTracker(BIN_HZ);
    for (let u = 0; u < 40; u++) {
      const tones = [[500, -45]];
      if (u % 4 !== 0) tones.push([2000, -40]);
      tracker.update(spectrum(tones));
    }
    const ranked = tracker.ranked(WINDOWS[1]);
    assert.deepEqual(
      ranked.map((t) => Math.round(t.hz)),
      [2000, 500],
    );
    assert.equal(ranked[0].presence, 0.75);
  });

  it('follows a slowly drifting tone as one track', () => {
    const tracker = new ToneTracker(BIN_HZ);
    for (let u = 0; u < 40; u++) tracker.update(spectrum([[1000 + u * 0.25, -30]]));
    const ranked = tracker.ranked(WINDOWS[1]);
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].presence, 1);
    assert.ok(Math.abs(ranked[0].hz - 1009.75) < 1, `hz ${ranked[0].hz}`);
  });

  it('looks back as far as the window', () => {
    const tracker = new ToneTracker(BIN_HZ);
    for (let u = 0; u < 60; u++) tracker.update(spectrum(u < 20 ? [[700, -35]] : [[150, -60]]));
    assert.deepEqual(
      tracker.ranked(WINDOWS[1]).map((t) => Math.round(t.hz)),
      [150],
      'within 10 s only the newer tone',
    );
    const total = tracker.ranked(WINDOWS[2]);
    assert.deepEqual(
      total.map((t) => Math.round(t.hz)),
      [150, 700],
      'since the reset both, the longer-lasting one first',
    );
    assert.ok(Math.abs(total[1].presence - 1 / 3) < 1e-9);
    assert.equal(total[1].level, -35);
    tracker.reset();
    assert.deepEqual(tracker.ranked(WINDOWS[2]), []);
  });

  it('finds the steady hum among loud bursts on the real DSP core', async () => {
    const core = await loadCore();
    const hum = sine(300, -40);
    const burst = sine(1000, -15);
    // 0.5 s bursts every 3 s, like a door or a voice; the hum never stops.
    const signal = sum(hum, (t) => (t % 3 < 0.5 ? burst(t) : 0), noise(-80));
    const tracker = new ToneTracker(core.binHz);
    core.x.set_mode(1);
    for (let u = 0; u < 4 * 12; u++) {
      core.feed(signal, 0.25);
      tracker.update(core.currentDb());
    }
    const [first] = tracker.ranked(WINDOWS[1]);
    assert.ok(Math.abs(first.hz - 300) < 0.2, `first: ${first.hz}`);
    assert.ok(first.presence > 0.95);
    // Ranked by the 10 s average alone, the bursts would win.
    const [loudest] = findPeaks(core.averageDb(), core.binHz);
    assert.ok(Math.abs(loudest.hz - 1000) < 0.5, `average ranking: ${loudest.hz}`);
  });
});

// The DSP core (src/dsp.wasm) in Node, wired up the way the audio worklet does
// it, with a signal generator instead of a microphone.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FFT_SIZE, hopFor, packFilters, REPORT_SECONDS } from '../src/js/dsp.js';
import { REPORT_LENGTH } from '../src/js/stats.js';

const BYTES = readFileSync(new URL('../src/dsp.wasm', import.meta.url));
const MAX_BLOCK = 1024;

/** The core set up for a sample rate; `quantum` is the block size per call (128 in browsers today). */
export async function loadCore(fs = 48000, { quantum = 128 } = {}) {
  const { instance } = await WebAssembly.instantiate(BYTES);
  const x = instance.exports;
  const view = (Type, ptr, length) => new Type(x.memory.buffer, ptr, length);
  view(Float64Array, x.filters_ptr(), 35).set(packFilters(fs));
  assert.equal(x.setup(fs, FFT_SIZE, hopFor(fs), Math.round(fs * REPORT_SECONDS)), 0);
  const input = view(Float32Array, x.input_ptr(), MAX_BLOCK);
  const bins = x.bins();
  let t = 0;
  let cols = 0;
  return {
    x,
    fs,
    bins,
    binHz: fs / FFT_SIZE,
    /** Feeds `seconds` of signal(t) (rounded to whole quanta); returns the level reports. */
    feed(signal, seconds) {
      const reports = [];
      let spectra = 0;
      const blocks = Math.round((seconds * fs) / quantum);
      for (let b = 0; b < blocks; b++) {
        for (let i = 0; i < quantum; i++) input[i] = signal(t++ / fs);
        const flags = x.process(quantum);
        if (flags & 1) reports.push(Float64Array.from(view(Float64Array, x.report_ptr(), REPORT_LENGTH)));
        if (flags & 2) spectra++;
      }
      return { reports, spectra };
    },
    /** Feeds raw samples, a whole number of quanta. */
    feedSamples(samples) {
      for (let off = 0; off < samples.length; off += quantum) {
        input.set(samples.subarray(off, off + quantum));
        x.process(quantum);
      }
    },
    power: () => Float32Array.from(view(Float32Array, x.power_ptr(), bins)),
    averageDb: () => Float32Array.from(view(Float32Array, x.average_db(), bins)),
    currentDb: () => Float32Array.from(view(Float32Array, x.current_db(), bins)),
    setColumns(edges) {
      cols = edges.length / 2;
      view(Float32Array, x.edges_ptr(), edges.length).set(edges);
      assert.equal(x.columns(cols), 0);
    },
    live: () => Float32Array.from(view(Float32Array, x.live_ptr(), cols)),
    average: () => Float32Array.from(view(Float32Array, x.average_ptr(), cols)),
  };
}

export const sine = (hz, rmsDb) => {
  const amplitude = Math.SQRT2 * 10 ** (rmsDb / 20);
  return (t) => amplitude * Math.sin(2 * Math.PI * hz * t);
};

export const sum =
  (...signals) =>
  (t) =>
    signals.reduce((acc, s) => acc + s(t), 0);

// Deterministic white noise (xorshift), uniform in [-a, a].
export function noise(rmsDb, seed = 1) {
  let state = seed;
  const a = Math.sqrt(3) * 10 ** (rmsDb / 20);
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) / 0xffffffff) * 2 * a - a;
  };
}

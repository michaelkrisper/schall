// Tones over time: which frequencies are there all along. Four times a second
// the peaks of the latest spectrum (one 341 ms window; an average would let a
// short loud sound linger) are matched to tracks (a tone may drift a little,
// like a motor changing speed), and each track remembers when it was present
// and how loud.
//
// The ranking is by the level a tone reaches at least half of the time within
// the window (its L50, counting the time it is absent as silence): a steady
// hum outranks a short loud sound, which is gone most of the time. Tones
// present less than half of the time follow, by their level while present,
// lowered by how rarely they are there.

import { findPeaks } from './dsp.js';

const RING = 40; // the last 10 s at 4 updates per second
const FLOOR = -150; // dB; the histogram covers FLOOR .. 0 dB
const STEP = 0.5;
const BINS = -FLOOR / STEP;
const MAX_TRACKS = 40;
const CANDIDATES = 12;
// Shorter than a tenth of the window: a click, a word, not a tone worth listing.
const MIN_PRESENCE = 0.1;

const tolerance = (hz, binHz) => Math.max(1.5 * binHz, 0.004 * hz);
const toBin = (db) => Math.min(BINS - 1, Math.max(0, Math.round((db - FLOOR) / STEP)));

// Window in updates for the averaging choice: 1 s, 10 s, since the reset.
export const WINDOWS = [4, RING, Infinity];

export class ToneTracker {
  constructor(binHz) {
    this.binHz = binHz;
    this.reset();
  }

  reset() {
    this.tracks = [];
    this.updates = 0;
  }

  /** One update from the latest spectrum, in dB per bin. */
  update(db, { maxHz = 20000 } = {}) {
    const n = ++this.updates;
    const peaks = findPeaks(db, this.binHz, { maxHz, count: CANDIDATES });
    for (const peak of peaks) {
      let best = null;
      let distance = Number.POSITIVE_INFINITY;
      for (const track of this.tracks) {
        const d = Math.abs(track.hz - peak.hz);
        if (track.seen !== n && d <= tolerance(track.hz, this.binHz) && d < distance) {
          best = track;
          distance = d;
        }
      }
      if (!best) {
        best = newTrack(peak.hz, n);
        this.tracks.push(best);
      }
      best.hz += 0.3 * (peak.hz - best.hz);
      best.seen = n;
      best.ring[n % RING] = peak.db;
      best.histogram[toBin(peak.db)]++;
      best.present++;
    }
    for (const track of this.tracks) {
      if (track.seen !== n) track.ring[n % RING] = Number.NaN;
    }
    this.tidy(n);
  }

  // Tracks that drifted onto each other are one tone; and there is a limit.
  tidy(n) {
    this.tracks.sort((a, b) => a.born - b.born);
    this.tracks = this.tracks.filter(
      (track, i) =>
        !this.tracks
          .slice(0, i)
          .some((older) => Math.abs(older.hz - track.hz) <= tolerance(older.hz, this.binHz)),
    );
    if (this.tracks.length > MAX_TRACKS) {
      this.tracks.sort((a, b) => b.seen - a.seen);
      this.tracks.length = MAX_TRACKS;
    }
    // Long gone and never really there: forget.
    this.tracks = this.tracks.filter((t) => n - t.seen < RING || t.present / (n - t.born + 1) > 0.05);
  }

  /**
   * The strongest tones within `window` updates (see WINDOWS), strongest
   * first: { hz, level (median while present), l50, presence (0..1) }.
   */
  ranked(window, count = 5) {
    const n = this.updates;
    const span = Math.min(window, n);
    if (!span) return [];
    const tones = this.tracks
      .map((track) =>
        window === Number.POSITIVE_INFINITY ? fromHistogram(track, n) : fromRing(track, n, span),
      )
      .filter((tone) => tone.presence >= MIN_PRESENCE);
    for (const tone of tones) {
      tone.score = tone.presence >= 0.5 ? tone.l50 : -1000 + tone.level + 20 * Math.log10(tone.presence);
    }
    tones.sort((a, b) => b.score - a.score);
    return tones.slice(0, count);
  }
}

function newTrack(hz, n) {
  return {
    hz,
    born: n,
    seen: 0,
    present: 0,
    ring: new Float32Array(RING).fill(Number.NaN),
    histogram: new Uint32Array(BINS),
  };
}

// Within the last `span` updates (up to RING), from the ring.
function fromRing(track, n, span) {
  const levels = [];
  for (let u = Math.max(track.born, n - span + 1); u <= n; u++) {
    const v = track.ring[u % RING];
    if (!Number.isNaN(v)) levels.push(v);
  }
  levels.sort((a, b) => b - a);
  const half = Math.ceil(span / 2);
  return {
    hz: track.hz,
    presence: levels.length / span,
    level: levels.length ? levels[(levels.length - 1) >> 1] : FLOOR,
    l50: levels.length >= half ? levels[half - 1] : FLOOR,
  };
}

// Since the reset, from the histogram (0.5 dB steps).
function fromHistogram(track, n) {
  const present = track.present;
  // The k-th highest present level, counting from 1.
  const nth = (k) => {
    let seen = 0;
    for (let b = BINS - 1; b >= 0; b--) {
      seen += track.histogram[b];
      if (seen >= k) return FLOOR + b * STEP;
    }
    return FLOOR;
  };
  const half = Math.ceil(n / 2);
  return {
    hz: track.hz,
    presence: present / n,
    level: present ? nth(Math.ceil(present / 2)) : FLOOR,
    l50: present >= half ? nth(half) : FLOOR,
  };
}

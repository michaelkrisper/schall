// Signal maths shared by the page, the audio worklet setup and the tests.
// No DOM, no Web Audio: everything here runs in Node as well.

const TAU = 2 * Math.PI;

// Pole frequencies of the A and C weighting curves (IEC 61672-1, Annex E).
const F1 = 20.598997;
const F2 = 107.65265;
const F3 = 737.86223;
const F4 = 12194.217;

// Analog second-order section (b2 s² + b1 s + b0) / (a2 s² + a1 s + a0) to a
// digital one by the bilinear transform. Fine for the low poles; near Nyquist
// it squeezes the curve, which is why the 12.2 kHz poles use matchedLowpass.
function bilinear([b2, b1, b0], [a2, a1, a0], fs) {
  const k = 2 * fs;
  const kk = k * k;
  const norm = a2 * kk + a1 * k + a0;
  return [
    (b2 * kk + b1 * k + b0) / norm,
    (2 * b0 - 2 * b2 * kk) / norm,
    (b2 * kk - b1 * k + b0) / norm,
    (2 * a0 - 2 * a2 * kk) / norm,
    (a2 * kk - a1 * k + a0) / norm,
  ];
}

// Critically damped lowpass 1 / (1 + s/ω)² whose magnitude matches the analog
// one up to Nyquist (M. Vicanek, "Matched Second Order Digital Filters", 2016).
function matchedLowpass(f, fs) {
  const w = (TAU * f) / fs;
  const a1 = -2 * Math.exp(-w);
  const a2 = Math.exp(-2 * w);
  const A0 = (1 + a1 + a2) ** 2;
  const A1 = (1 - a1 + a2) ** 2;
  const A2 = -4 * a2;
  const phi1 = Math.sin(w / 2) ** 2;
  const phi0 = 1 - phi1;
  const phi2 = 4 * phi0 * phi1;
  const R1 = (A0 * phi0 + A1 * phi1 + A2 * phi2) * 0.25;
  const B1 = (R1 - A0 * phi0) / phi1;
  const b0 = 0.5 * (Math.sqrt(A0) + Math.sqrt(B1));
  return [b0, Math.sqrt(A0) - b0, 0, a1, a2];
}

// Biquad cascade as [[b0, b1, b2, a1, a2], ...] for the weighting 'A', 'C'
// or 'Z', normalised to 0 dB at 1 kHz.
export function weightingFilter(weighting, fs) {
  // Flat, apart from a 3 Hz highpass against a DC offset of the microphone.
  if (weighting === 'Z') return [bilinear([0, 1, 0], [0, 1, TAU * 3], fs)];
  const w1 = TAU * F1;
  const sections = [bilinear([1, 0, 0], [1, 2 * w1, w1 * w1], fs)];
  if (weighting === 'A') {
    const w2 = TAU * F2;
    const w3 = TAU * F3;
    sections.push(bilinear([1, 0, 0], [1, w2 + w3, w2 * w3], fs));
  }
  sections.push(matchedLowpass(F4, fs));
  const gain = 10 ** (-filterResponse(sections, 1000, fs) / 20);
  sections[0] = sections[0].map((c, i) => (i < 3 ? c * gain : c));
  return sections;
}

// Magnitude of a biquad cascade at f, in dB.
export function filterResponse(sections, f, fs) {
  const w = (TAU * f) / fs;
  const c1 = Math.cos(w);
  const s1 = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  let db = 0;
  for (const [b0, b1, b2, a1, a2] of sections) {
    const num = (b0 + b1 * c1 + b2 * c2) ** 2 + (b1 * s1 + b2 * s2) ** 2;
    const den = (1 + a1 * c1 + a2 * c2) ** 2 + (a1 * s1 + a2 * s2) ** 2;
    db += 10 * Math.log10(num / den);
  }
  return db;
}

// The analog weighting curves themselves, in dB (IEC 61672-1 E.6).
export function weightingCurve(weighting, f) {
  if (weighting === 'Z') return 0;
  const ff = f * f;
  const lowHigh = (F4 * F4 * ff) / ((ff + F1 * F1) * (ff + F4 * F4));
  if (weighting === 'C') return 20 * Math.log10(lowHigh) + 0.0619;
  const mid = ff / Math.sqrt((ff + F2 * F2) * (ff + F3 * F3));
  return 20 * Math.log10(lowHigh * mid) + 2.0;
}

const PASS = [1, 0, 0, 0, 0];

// Filter coefficients in the layout the DSP core expects (wasm/src/lib.rs):
// A and C as three biquads each, C padded with a pass-through, then Z as one.
export function packFilters(fs) {
  const pad = (sections) => [...sections, ...Array(3 - sections.length).fill(PASS)];
  return Float64Array.from(
    [...pad(weightingFilter('A', fs)), ...pad(weightingFilter('C', fs)), ...weightingFilter('Z', fs)].flat(),
  );
}

export const FFT_SIZE = 16384;
export const REPORT_SECONDS = 0.05;

// Samples between two spectra: a multiple of the 128-sample render quantum,
// about 21 ms, so the spectrogram runs at ~47 lines per second at any rate.
export const hopFor = (fs) => 128 * Math.max(1, Math.round(fs / 6000));

// Logarithmic frequency axis from minHz to maxHz over `count` display columns,
// as fractional bin positions [first, last) per column for the DSP core.
export function columnEdges(count, minHz, maxHz, binHz) {
  const edges = new Float32Array(2 * count);
  const ratio = Math.log(maxHz / minHz);
  for (let c = 0; c < count; c++) {
    edges[2 * c] = (minHz * Math.exp((ratio * c) / count)) / binHz;
    edges[2 * c + 1] = (minHz * Math.exp((ratio * (c + 1)) / count)) / binHz;
  }
  return edges;
}

export const powerToDb = (power) => (power > 0 ? 10 * Math.log10(power) : -Infinity);

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B', 'H'];

// Nearest note (German names, A4 = 440 Hz) and the deviation in cents.
export function noteOf(f) {
  const midi = 69 + 12 * Math.log2(f / 440);
  const nearest = Math.round(midi);
  return {
    name: `${NOTE_NAMES[((nearest % 12) + 12) % 12]}${Math.floor(nearest / 12) - 1}`,
    cents: Math.round((midi - nearest) * 100) + 0, // no -0
  };
}

// The strongest tonal components of a spectrum (levels in dB per bin): local
// maxima that stand out from their surroundings, strongest first. Frequency
// and level are refined by a parabola through the top three bins.
export function findPeaks(db, binHz, { minHz = 20, maxHz = 20000, count = 5, prominence = 6 } = {}) {
  const n = db.length;
  // Prefix sums of the levels, for the mean level around each candidate.
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + Math.max(db[i], -200);
  const first = Math.max(2, Math.ceil(minHz / binHz));
  const last = Math.min(n - 3, Math.floor(maxHz / binHz));
  const candidates = [];
  for (let i = first; i <= last; i++) {
    const v = db[i];
    if (!(v > -150 && v > db[i - 1] && v >= db[i + 1] && v > db[i - 2] && v >= db[i + 2])) continue;
    const floor = localFloor(prefix, i, n);
    if (v - floor < prominence) continue;
    const a = db[i - 1];
    const c = db[i + 1];
    const denom = a - 2 * v + c;
    const shift = denom < 0 ? (0.5 * (a - c)) / denom : 0;
    candidates.push({
      hz: (i + shift) * binHz,
      db: v - 0.25 * (a - c) * shift,
      prominence: v - floor,
      bin: i,
    });
  }
  candidates.sort((x, y) => y.db - x.db);
  // The skirt of a strong tone is not a tone of its own, and anything 80 dB
  // below the strongest is window sidelobes or beyond what a microphone hears.
  const peaks = [];
  for (const peak of candidates) {
    if (peak.db < candidates[0].db - 80) break;
    if (peaks.some((p) => Math.abs(p.bin - peak.bin) < 6)) continue;
    peaks.push(peak);
    if (peaks.length === count) break;
  }
  return peaks;
}

// Mean level within about a third of an octave around bin i (at least ±10
// bins), leaving out the peak's own main lobe (±5 bins with Blackman-Harris).
function localFloor(prefix, i, n) {
  const span = Math.max(10, Math.round(i * 0.12));
  const lo = Math.max(0, i - span);
  const hi = Math.min(n, i + span + 1);
  const innerLo = Math.max(lo, i - 5);
  const innerHi = Math.min(hi, i + 6);
  const sum = prefix[hi] - prefix[lo] - (prefix[innerHi] - prefix[innerLo]);
  return sum / (hi - lo - (innerHi - innerLo));
}

// For each peak, the first listed peak it is a whole multiple (2× to 16×) of,
// so the harmonics of a motor or fan can be told apart from other sources.
export function harmonics(peaks, binHz) {
  return peaks.map((peak) => {
    for (let j = 0; j < peaks.length; j++) {
      const base = peaks[j];
      if (base.hz >= peak.hz / 1.5) continue;
      const k = Math.round(peak.hz / base.hz);
      if (k >= 2 && k <= 16 && Math.abs(peak.hz - k * base.hz) <= Math.max(binHz, 0.01 * peak.hz)) {
        return { of: j, k };
      }
    }
    return null;
  });
}

// How loud is that, in everyday terms (for A-weighted levels).
const LEVEL_CLASSES = [
  [25, 'Fast völlige Stille'],
  [35, 'Flüstern'],
  [45, 'Ruhige Wohnung'],
  [55, 'Leises Büro'],
  [65, 'Normales Gespräch'],
  [75, 'Laute Stimmen, Staubsauger'],
  [85, 'Starker Straßenverkehr'],
  [95, 'Gehörschutz bei längerer Dauer'],
  [105, 'Presslufthammer, Disco'],
  [120, 'Konzert – Gehörschutz!'],
  [Infinity, 'Schmerzgrenze'],
];

export function levelClass(db) {
  return LEVEL_CLASSES.find(([limit]) => db < limit)[1];
}

// 0 calm, 1 moderate, 2 loud, 3 harmful.
export function levelZone(db) {
  if (db < 55) return 0;
  if (db < 70) return 1;
  if (db < 85) return 2;
  return 3;
}

export function formatDb(db, digits = 1) {
  if (!Number.isFinite(db)) return '–';
  return db.toFixed(digits).replace('.', ',');
}

export function formatHz(hz) {
  if (hz >= 10000) return `${(hz / 1000).toFixed(1).replace('.', ',')} kHz`;
  if (hz >= 1000) return `${(hz / 1000).toFixed(2).replace('.', ',')} kHz`;
  if (hz >= 100) return `${Math.round(hz)} Hz`;
  return `${hz.toFixed(1).replace('.', ',')} Hz`;
}

export function formatDuration(seconds) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

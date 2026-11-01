// User settings, kept in localStorage.

const KEY = 'schall';

// dB added to levels relative to digital full scale. Phone microphones differ;
// this is a middle value until the user calibrates against a reference.
export const DEFAULT_OFFSET = 100;

// Time span of the strongest frequencies and the history chart, in seconds
// (Infinity: since the reset).
export const SPANS = [1, 10, 30, 60, Number.POSITIVE_INFINITY];

const DEFAULTS = {
  offset: DEFAULT_OFFSET,
  span: 1, // index into SPANS
};

// Always dB(A) and Fast; the stats and the DSP core still have all of them.
const FIXED = { weighting: 0, time: 0 };

export function loadSettings() {
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(KEY));
  } catch {
    // Unreadable: defaults.
  }
  const { offset, span } = { ...DEFAULTS, ...stored };
  return { ...FIXED, offset, span: SPANS[span] ? span : DEFAULTS.span };
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Private mode or full storage: the settings just do not persist.
  }
}

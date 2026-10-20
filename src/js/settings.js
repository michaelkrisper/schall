// User settings, kept in localStorage.

const KEY = 'schall';

// dB added to levels relative to digital full scale. Phone microphones differ;
// this is a middle value until the user calibrates against a reference.
export const DEFAULT_OFFSET = 100;

const DEFAULTS = {
  weighting: 0, // A, C, Z
  time: 0, // Fast, Slow
  offset: DEFAULT_OFFSET,
  averaging: 1, // 1 s, 10 s, since reset
  range: 60, // history chart, seconds
  view: 'level',
};

export function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY)) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Private mode or full storage: the settings just do not persist.
  }
}

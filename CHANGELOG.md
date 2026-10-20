# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [1.1.1] - 2026-10-20

### Changed

- Less work on the main thread during long measurements (profiled on a
  Pixel 4a 5G): the spectrum rows are only sent while the frequency tab is
  open, the level bar updates with new levels (20/s) instead of every frame,
  and the history chart redraws only when it would move by a pixel.

### Added

- Browser test that the app starts and measures offline, from its service
  worker, with the server gone.

## [1.1.0] - 2026-10-20

### Added

- The strongest frequencies take the history into account: tones are
  followed over time and ranked by the level they reach at least half of the
  time (L50), so a steady hum comes before a short loud sound. The bar behind
  each tone shows how steadily it is there. The window follows the averaging
  choice (1 s, 10 s, since the reset), and the history is collected while
  another tab is open, too.
- No pinch or double-tap zoom: the app behaves like a native one.
- Repository: contributing guide, security and privacy policy, issue and pull
  request templates, Dependabot, rustfmt and clippy in CI, and 67 tests (tone
  tracker, consistency checks, more DSP edge cases and browser flows:
  playback, delete, reload).

### Fixed

- The labels on the level tab (weighting, Fast/Slow, LAeq/LAFmax) are right
  when the app starts on another tab.

## [1.0.0] - 2026-10-20

First release.

### Added

- Sound level meter: current level, Leq, maximum, minimum and peak, A/C/Z
  frequency weighting (IEC 61672-1), Fast/Slow time weighting, measuring
  time, history chart over 1 or 10 minutes, everyday description of the level.
- Frequency analysis: the five strongest tonal components from a 1 s, 10 s or
  total average, with note names, cents and harmonic relations; live and
  averaged spectrum with numbered markers; spectrogram of the last ~11 s;
  touch cursor for frequency and level.
- Recordings as 16-bit WAV in IndexedDB, written while recording; playback
  (pauses the measurement), download or share sheet, delete.
- Calibration against a reference reading or by hand in 0.5 dB steps.
- DSP core in Rust compiled to WebAssembly SIMD, running in an AudioWorklet:
  weighting filters, time weighting, 16384-point real FFT, averaging, dB
  conversion and display column pooling. Spectrum and spectrogram in WebGL2.
- Installable PWA with offline app shell and screen wake lock while measuring.
- Tests: the WebAssembly core against reference signals, filter design
  against the IEC 61672 table, statistics, consistency checks, and the app in
  headless Chrome with a fake microphone. CI builds, lints (Biome, rustfmt,
  clippy), tests and deploys to GitHub Pages.

[1.1.1]: https://github.com/michaelkrisper/schall/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/michaelkrisper/schall/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/michaelkrisper/schall/releases/tag/v1.0.0

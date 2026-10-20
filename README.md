# Schall

**Sound level meter and frequency analyser in the browser.** How loud is it on
average, how loud at its worst, and which frequencies dominate: the hum of a
motor, a fan's blade tone, concert pitch A, the drone in an aircraft cabin.
Record it, play it back, save it as a WAV file.

[**Open the app →**](https://michaelkrisper.github.io/schall/)

[![Deploy](https://github.com/michaelkrisper/schall/actions/workflows/deploy.yml/badge.svg)](https://github.com/michaelkrisper/schall/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

<p align="center">
  <img src="docs/screenshot-level.webp" width="260" alt="Level tab: current level, average, maximum, minimum, peak and a one-minute history chart">
  &nbsp;
  <img src="docs/screenshot-spectrum.webp" width="260" alt="Frequency tab: list of the strongest frequencies with note names, spectrum with numbered markers and spectrogram">
  &nbsp;
  <img src="docs/screenshot-recordings.webp" width="260" alt="Recordings tab with a saved recording, play, download and delete buttons">
</p>

## Features

- **Average and maximum.** Leq (energy average since "Neu starten"), maximum
  and minimum with Fast (125 ms) or Slow (1 s) time weighting, peak, duration,
  in dB(A), dB(C) or dB(Z), plus a 1 or 10 minute history chart.
- **The strongest frequencies.** Up to five tonal components from an averaged
  spectrum (1 s, 10 s or everything since the reset), to about 0.1 Hz, with the
  nearest note and cents, and harmonics marked as such ("3× ①"), which tells
  a motor's or fan's overtones apart from separate sources.
- **Spectrum and spectrogram.** Live spectrum, averaged line with numbered
  peak markers, the last ~11 seconds as a spectrogram, all on a logarithmic
  20 Hz - 20 kHz axis. Touch the plot to read frequency and level anywhere.
- **Recordings.** One tap records exactly what is being measured, as 16-bit
  WAV. Stored in the browser (IndexedDB, written as it records, so nothing is
  lost if the app is closed), played back in the app, saved via the share
  sheet on phones ("Save to Files", AirDrop) or downloaded on desktops.
- **Calibration.** Phone microphones are not calibrated. Hold the phone next
  to a sound level meter or a vetted app (e.g. NIOSH SLM), enter its reading,
  done.
- **Private.** No backend, no analytics. The microphone signal never leaves
  the device.

## How it works

Everything heavy runs on the audio thread, in WebAssembly with SIMD:

```
microphone ─► AudioWorklet ─► dsp.wasm (Rust, SIMD128)
                                ├─ A/C weighting: biquads in f64x2 (A and C side by side), Z scalar
                                ├─ Fast/Slow, Leq, min/max, peak: f32x4 lanes (A, C, Z)
                                ├─ real FFT, 16384 points, Blackman-Harris, every ~21 ms:
                                │    radix-4 butterflies 4 at a time, SIMD window + deinterleave
                                ├─ 1 s / 10 s / total power averages, dB via SIMD log
                                └─ max-pooling of 8192 bins into one value per display column
            ─► page: levels (20/s), display rows (47/s), full average (4/s, for the peak list)
            ─► WebGL2: spectrum and spectrogram from float textures (ring of rows, colour map in the shader)
```

The weighting filters follow IEC 61672-1 to within 0.03 dB up to 12.5 kHz
(bilinear transform for the low poles, magnitude-matched sections after
Vicanek for the 12.2 kHz ones, which a plain bilinear transform squeezes). The
whole DSP chain takes about 1 % of one desktop core.

What it cannot do: be a certified instrument. Phone microphones roll off
below ~100 Hz and above ~10 kHz and differ between models; very loud sound
clips the microphone. For relative comparisons and finding frequencies that
does not matter; for absolute levels, calibrate.

## Development

No framework, no bundler: `src/` is the app as deployed. The only build step
is the DSP core; `src/dsp.wasm` is checked in, so Rust is only needed to
change it.

```sh
npm install           # Biome, for linting
npm run serve         # http://localhost:8080 (microphone works on localhost)
npm run wasm          # rebuild src/dsp.wasm (needs: rustup target add wasm32-unknown-unknown)
npm run check         # lint + all tests
npm run icons         # render the PNG icons from src/icons/icon.svg (headless Chrome)
```

Tests (`node:test`, no extra dependencies):

- `test/core.test.js` runs the WebAssembly core in Node against reference
  values: sine levels in A/C/Z at 44.1 and 48 kHz, time weighting, the FFT
  against a plain DFT, SIMD dB conversion, tone frequency/level accuracy, a
  tone 50 dB below another, harmonics, averaging modes, display columns, speed.
- `test/dsp.test.js` checks filter design against the IEC 61672 table, notes,
  peak finding, formatting, statistics and the WAV header.
- `test/app.test.js` runs the app in headless Chrome with a fake microphone
  playing two known tones: levels on screen, the frequency list, the WebGL
  spectrogram, calibration, recording and the recorded WAV file.
  `SCREENSHOTS=1` refreshes the images in `docs/`.

Every push to `main` builds the core, runs everything and deploys to GitHub
Pages (`.github/workflows/deploy.yml`).

## License

[MIT](LICENSE)

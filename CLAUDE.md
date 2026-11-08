# CLAUDE.md

Schall is a sound level meter and frequency analyser PWA: average and maximum level
(dB(A), Fast), the strongest frequencies over time, recordings stored in the browser.
DSP is Rust compiled to WebAssembly with SIMD128 (`wasm/`, no_std, no crates) running in
an AudioWorklet; drawing is WebGL2 and Canvas 2D; the page is plain ES modules without a
bundler. Deployed to GitHub Pages at https://michaelkrisper.github.io/schall/ by CI.
The README covers features, DSP details, accuracy and the test inventory.

## Commands

Node 26 (`.nvmrc`). Rust with `wasm32-unknown-unknown` and `wasm32-wasip1` targets only
for changes under `wasm/`.

```sh
npm ci
npm run serve         # src/ on http://localhost:8080 with gzip (PORT= to change)
npm run lint          # Biome check (JS, CSS, webmanifest, JSON); lint:fix writes
npm run test:unit     # core, dsp, structure tests in Node (no Chrome)
npm test              # all tests incl. tracker and the headless-Chrome app test
npm run check         # lint + all tests, what CI runs
npm run wasm          # cargo build in wasm/, copies the module to src/dsp.wasm
npm run lint:rust     # rustfmt --check + clippy -D warnings
npm run test:rust     # Rust unit tests as WASI in Node
npm run screenshots   # refresh docs/*.webp via the browser test
```

- CI (`.github/workflows/deploy.yml`, "Test and deploy"): `lint:rust`, `test:rust`,
  `wasm`, `check`; on `main` it tags the next patch version, stamps the commit into `sw.js`
  and the version into `index.html` (`__APP_VERSION__`, shown in the settings), deploys `src/` to Pages and smoke-tests the live files (200s, stamped `sw.js`,
  `application/wasm` content type).
- The browser test needs Chrome/Chromium (`CHROME=` to point at it) and is skipped
  without one; let CI run it rather than starting browsers locally.

## Architecture

- `src/` is the app exactly as deployed. `src/dsp.wasm` is committed so the app runs
  without Rust; CI rebuilds it from `wasm/` on every run.
- `wasm/src/lib.rs`: A/C/Z weighting, Fast/Slow, Leq, min/max, 16384-point real FFT
  (radix-4, Blackman-Harris), averages and column pooling. Static memory only.
- `src/js/worklet.js` feeds the core on the audio thread and posts reports;
  `audio.js` wires microphone -> worklet; `main.js` is the UI controller and exposes
  `window.schall` for debugging and tests.
- Pure modules with Node tests: `dsp.js` (filter design, peaks, formatting), `stats.js`
  (statistics, history), `tracker.js` (tone tracker, ranks by L50).
- Views: `level-view.js` (dial, history), `spectrum-view.js` (WebGL2 spectrum and
  spectrogram), `recordings-view.js`; `recorder.js` stores 16-bit WAV chunks in IndexedDB.
- `src/sw.js`: app-shell cache `schall-<commit>`; `__VERSION__` is replaced at deploy.

## Conventions

- Biome: 2 spaces, single quotes, trailing commas, semicolons, line width 110.
  `.editorconfig`: LF, Rust 4 spaces.
- UI text German (`lang="de"`); code, comments and docs English.
- No runtime dependencies; the only dev dependency is Biome. The app must work offline
  and send nothing anywhere.
- Filter, FFT or statistics changes come with a test against an analytic reference value
  in `test/core.test.js` or `test/dsp.test.js`.
- Check layouts at 375x667 and 412x915: nothing may scroll or overflow except the
  recordings list. No pinch/double-tap zoom (blocked on purpose for a native feel).

## Rules and pitfalls

- Never edit version numbers: `package.json`, `wasm/Cargo.toml` and the top entry of
  `CHANGELOG.md` are frozen at 1.3.0 and `test/structure.test.js` asserts they agree.
  Later changes live only in GitHub releases.
- A new file under `src/js/` must go into `SHELL` in `src/sw.js` and, if loaded at
  startup, get a `modulepreload` in `src/index.html`; the structure test checks both.
- The service worker must only delete caches with the `schall-` prefix: other apps share
  the `michaelkrisper.github.io` origin and its cache storage.
- The report layout (`REPORT_LENGTH`) is shared by `write_report` in `wasm/src/lib.rs`,
  `src/js/worklet.js` and `src/js/stats.js`; change all three together.
- Keep `process()` allocation-free. The Rust static state must stay fully
  zero-initialised so it lands in `.bss`; a non-zero initialiser moves it to `.data`
  and grows the module from ~13 KB to hundreds of KB.
- Cargo reads `wasm/.cargo/config.toml` (target, `+simd128`) only with `wasm/` as the
  working directory; use `npm run wasm`, not `cargo build` from the root. After changing
  the core, commit the rebuilt `src/dsp.wasm` with the source.
- Headless Chrome's fake microphone drifts in pitch (~0.5 %): the app test checks
  frequencies to about 1 % and levels to ±6 dB; exactness belongs in the core tests.
- WebGL has no `preserveDrawingBuffer`: read pixels in the same task that drew them
  (the test calls `spectrum.redraw()` synchronously instead of waiting for rAF).
- The default calibration offset (100 dB) is a guess, not a calibrated value.

## Workflow

- Every change starts with a GitHub issue. Branch `<issue>-<slug>` from `main`,
  open a PR with `Closes #<issue>`. Never push to `main` directly.
- PRs auto-merge (squash) once CI and the "Linked ticket" check pass; drafts are not merged.
- Versions exist only as git tags `vX.Y.Z`. Every merge to `main` tags the next patch;
  never edit version numbers in files. Minor/major releases: Actions -> Release.
- Merging to `main` deploys to GitHub Pages automatically.
- Details: CONTRIBUTING.md.

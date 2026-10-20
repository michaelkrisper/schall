# Contributing

Bug reports, measurements that look wrong, ideas and pull requests are
welcome. Please open an issue first for larger changes.

## Setup

Requirements: Node.js 24, and for changes to the DSP core Rust with the
WebAssembly target.

```sh
npm ci
npm run serve                              # http://localhost:8080
rustup target add wasm32-unknown-unknown   # only to change wasm/
npm run wasm                               # rebuild src/dsp.wasm
```

`src/` is the app as deployed, no bundler. `src/dsp.wasm` is checked in so
the app runs without Rust; CI rebuilds it from `wasm/` on every push.

## Before a pull request

```sh
npm run lint:fix     # Biome: format and lint JavaScript, CSS, JSON
npm run lint:rust    # rustfmt and clippy for the DSP core
npm test             # all tests; the browser test needs Chrome (skipped otherwise)
npm run check        # what CI runs
```

If you change the DSP core, run `npm run wasm` and commit `src/dsp.wasm`
together with the source.

Check the layout on a small phone (375 x 667) and a large one (412 x 915) in
the browser's device toolbar: nothing may scroll or overflow, except the
list of recordings.

## Guidelines

- Measurements must stay verifiable: a change to filters, the FFT or the
  statistics comes with a test against an analytic reference value in
  `test/core.test.js` or `test/dsp.test.js`.
- Keep the audio thread allocation-free: no new buffers in `process()`; the
  Rust core uses static memory only.
- New files under `src/js/` go into `SHELL` in `src/sw.js` and, if imported
  at startup, get a `modulepreload` in `src/index.html`.
  `test/structure.test.js` checks both.
- The report layout is shared by `wasm/src/lib.rs` (`write_report`),
  `src/js/worklet.js` and `src/js/stats.js`; change all three together.
- UI text is German, code, comments and documentation are English.
- No new runtime dependencies. The app should keep working offline and send
  nothing anywhere.

## Releases

Bump the version in `package.json` and `wasm/Cargo.toml`, add a section to
`CHANGELOG.md` (the structure test checks that all three agree), push to
`main`. CI deploys to GitHub Pages.

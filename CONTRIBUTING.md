# Contributing

Bug reports, measurements that look wrong, ideas and pull requests are
welcome. Please open an issue first for larger changes.

## Workflow

1. Every change starts with an issue: a bug report or a feature request.
2. Work on a branch named after the issue. `gh issue develop <issue> --checkout`
   creates `<issue>-<title>`.
3. Open a pull request against `main`. The _Tickets_ check links the issue
   (`Closes #<issue>`); a pull request without a ticket fails.
4. CI runs on every pull request. When all checks are green, _Auto-merge_
   squash-merges it. Open the pull request as a draft while it is not ready.
5. The merge closes the issue. `main` always holds the latest valid state
   (trunk-based development).

## Versions and releases

- Versions follow [Semantic Versioning](https://semver.org) and exist only as
  git tags (`vMAJOR.MINOR.PATCH`).
- CI tags every merge to `main` with the next patch version.
- A release bundles the changes since the previous one: run
  _Actions → Release → Run workflow_ and pick `minor` or `major`. It tags
  `main` and publishes a GitHub release listing the merged pull requests and
  closed tickets.

## Setup

Requirements: Node.js 26, and for changes to the DSP core Rust with the
WebAssembly target.

```sh
npm ci
npm run serve                              # http://localhost:8080
rustup target add wasm32-unknown-unknown wasm32-wasip1   # only to change wasm/
npm run wasm                               # rebuild src/dsp.wasm
```

`src/` is the app as deployed, no bundler. `src/dsp.wasm` is checked in so
the app runs without Rust; CI rebuilds it from `wasm/` on every push.

## Before a pull request

```sh
npm run lint:fix     # Biome: format and lint JavaScript, CSS, JSON
npm run lint:rust    # rustfmt and clippy for the DSP core
npm run test:rust    # Rust unit tests for the DSP core
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

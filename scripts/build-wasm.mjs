// Builds the Rust DSP core (wasm/) and puts the module next to the app as
// src/dsp.wasm. Needs rustup's wasm32-unknown-unknown target.

import { execFileSync } from 'node:child_process';
import { copyFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const crate = fileURLToPath(new URL('../wasm/', import.meta.url));
const out = fileURLToPath(new URL('../src/dsp.wasm', import.meta.url));

// cargo reads wasm/.cargo/config.toml (target, +simd128) from the working directory.
execFileSync('cargo', ['build', '--release'], { cwd: crate, stdio: 'inherit' });
copyFileSync(`${crate}target/wasm32-unknown-unknown/release/schall_dsp.wasm`, out);
console.info(`src/dsp.wasm: ${statSync(out).size} bytes`);

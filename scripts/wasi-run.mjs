// Cargo runner for `cargo test --target wasm32-wasip1`: runs the test binary
// under Node's WASI, so the Rust unit tests need no extra runtime.

import { readFileSync } from 'node:fs';
import { WASI } from 'node:wasi';

const [file, ...args] = process.argv.slice(2);
const wasi = new WASI({ version: 'preview1', args: [file, ...args], env: process.env, returnOnExit: true });
const module = await WebAssembly.compile(readFileSync(file));
const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
process.exitCode = wasi.start(instance);

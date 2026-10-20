// Consistency of the parts that are easy to forget: the offline cache, the
// module preloads, element ids, icons, the report layout shared by Rust and
// JavaScript, and version numbers.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { REPORT_LENGTH } from '../src/js/stats.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const html = read('src/index.html');
const sw = read('src/sw.js');
const shell = [...sw.matchAll(/^ {2}'([^']+)',$/gm)].map((m) => m[1]);
const modules = readdirSync(new URL('../src/js/', import.meta.url)).filter((f) => f.endsWith('.js'));

describe('app shell', () => {
  it('caches every module, the DSP core and the styles for offline use', () => {
    for (const file of modules) assert.ok(shell.includes(`js/${file}`), `js/${file} missing in sw.js SHELL`);
    for (const file of ['./', 'index.html', 'styles.css', 'dsp.wasm', 'manifest.webmanifest']) {
      assert.ok(shell.includes(file), `${file} missing in sw.js SHELL`);
    }
  });

  it('removes only its own old caches (other apps share the origin)', () => {
    assert.match(sw, /key\.startsWith\('schall-'\) && key !== CACHE/);
  });

  it('caches only files that exist', () => {
    for (const file of shell.filter((f) => f !== './')) {
      assert.doesNotThrow(() => readFileSync(new URL(`../src/${file}`, import.meta.url)), file);
    }
  });

  it('preloads every module the page imports at startup', () => {
    const preloaded = [...html.matchAll(/rel="modulepreload" href="js\/([^"]+)"/g)].map((m) => m[1]);
    for (const file of modules.filter((f) => !['main.js', 'worklet.js'].includes(f))) {
      assert.ok(preloaded.includes(file), `js/${file} has no modulepreload`);
    }
  });

  it('only looks up element ids that exist', () => {
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const file of modules) {
      const source = read(`src/js/${file}`);
      for (const [, id] of source.matchAll(/(?:\$|getElementById)\('([^']+)'\)/g)) {
        assert.ok(ids.has(id), `${file} uses #${id}, which index.html does not have`);
      }
    }
  });

  it('has the icons the manifest promises, in the stated sizes', () => {
    const manifest = JSON.parse(read('src/manifest.webmanifest'));
    for (const icon of manifest.icons) {
      const data = readFileSync(new URL(`../src/${icon.src}`, import.meta.url));
      if (icon.type !== 'image/png') continue;
      const size = `${data.readUInt32BE(16)}x${data.readUInt32BE(20)}`;
      assert.equal(size, icon.sizes, icon.src);
    }
  });
});

describe('Rust and JavaScript agree', () => {
  it('on the length of a level report', () => {
    const rust = Number(read('wasm/src/lib.rs').match(/const REPORT_LEN: usize = (\d+);/)[1]);
    const worklet = Number(read('src/js/worklet.js').match(/const REPORT_LENGTH = (\d+);/)[1]);
    assert.equal(rust, REPORT_LENGTH);
    assert.equal(worklet, REPORT_LENGTH);
  });

  it('on the largest block, FFT and column count', () => {
    const rust = read('wasm/src/lib.rs');
    const constant = (name) => Number(rust.match(new RegExp(`const ${name}: usize = (\\d+);`))[1]);
    assert.equal(
      constant('MAX_BLOCK'),
      Number(read('src/js/worklet.js').match(/const MAX_BLOCK = (\d+);/)[1]),
    );
    assert.equal(constant('MAX_N'), Number(read('src/js/dsp.js').match(/const FFT_SIZE = (\d+);/)[1]));
    assert.ok(
      constant('MAX_COLS') >= Number(read('src/js/spectrum-view.js').match(/const MAX_COLS = (\d+);/)[1]),
    );
  });
});

describe('versions', () => {
  it('match in package.json, Cargo.toml and the changelog', () => {
    const { version } = JSON.parse(read('package.json'));
    assert.equal(read('wasm/Cargo.toml').match(/^version = "([^"]+)"/m)[1], version);
    assert.equal(read('CHANGELOG.md').match(/^## \[([^\]]+)\]/m)[1], version);
  });
});

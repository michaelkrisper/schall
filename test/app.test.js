// The app in a real browser: headless Chrome over the DevTools protocol with a
// fake microphone that plays a WAV file of two known tones. Checks the levels
// on screen, the frequency list, recording and the recorded file, and saves
// screenshots for the README (SCREENSHOTS=1). Skipped when no Chrome is
// installed (set CHROME to its path if it is not on PATH).

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { powerToDb, weightingCurve } from '../src/js/dsp.js';
import { wavHeader } from '../src/js/recorder.js';
import { DEFAULT_OFFSET } from '../src/js/settings.js';

const ROOT = fileURLToPath(new URL('../src/', import.meta.url));
const DOCS = fileURLToPath(new URL('../docs/', import.meta.url));
const TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};
const TONES = [
  [440, -20],
  [1250, -30],
];

const chrome = [process.env.CHROME, 'google-chrome', 'chromium', 'chromium-browser'].find(
  (bin) => bin && spawnSync(bin, ['--version']).status === 0,
);

function toneFile(path, seconds = 10, rate = 48000) {
  const n = seconds * rate;
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let x = 0;
    for (const [hz, db] of TONES) x += Math.SQRT2 * 10 ** (db / 20) * Math.sin((2 * Math.PI * hz * i) / rate);
    pcm[i] = Math.round(x * 32767);
  }
  writeFileSync(path, Buffer.concat([Buffer.from(wavHeader(n, rate)), Buffer.from(pcm.buffer)]));
}

function serve() {
  const server = createServer(async (req, res) => {
    let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (path.endsWith('/')) path += 'index.html';
    try {
      const body = await readFile(join(ROOT, path));
      res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// A minimal DevTools protocol client over one WebSocket (flat sessions).
async function devtools(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const call = pending.get(message.id);
    if (!call) {
      for (const listener of listeners) listener(message);
      return;
    }
    pending.delete(message.id);
    if (message.error) call.reject(new Error(message.error.message));
    else call.resolve(message.result);
  };
  return {
    send: (method, params = {}, sessionId = undefined) =>
      new Promise((resolve, reject) => {
        pending.set(++id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, sessionId }));
      }),
    on: (listener) => listeners.push(listener),
    close: () => ws.close(),
  };
}

const number = (text) => Number.parseFloat(text.replace(',', '.'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('app in a browser', { skip: !chrome && 'no Chrome found', timeout: 90_000 }, () => {
  let server;
  let browser;
  let cdp;
  let page;
  let work;
  const errors = [];

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await page('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  const waitFor = async (expression, timeout = 15_000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await evaluate(expression)) return;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${expression}`);
  };
  const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent`);
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const screenshot = async (name) => {
    if (!process.env.SCREENSHOTS) return;
    const { data } = await page('Page.captureScreenshot', { format: 'webp', quality: 85 });
    writeFileSync(join(DOCS, `screenshot-${name}.webp`), Buffer.from(data, 'base64'));
  };

  before(async () => {
    server = await serve();
    const origin = `http://127.0.0.1:${server.address().port}`;
    work = mkdtempSync(join(tmpdir(), 'schall-chrome-'));
    const wav = join(work, 'tones.wav');
    toneFile(wav);
    browser = spawn(chrome, [
      '--headless=new',
      '--no-sandbox',
      '--no-first-run',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`,
      '--autoplay-policy=no-user-gesture-required',
      '--remote-debugging-port=0',
      `--user-data-dir=${join(work, 'profile')}`,
      'about:blank',
    ]);
    const url = await new Promise((resolve, reject) => {
      let log = '';
      browser.stderr.on('data', (chunk) => {
        log += chunk;
        const match = log.match(/DevTools listening on (ws:\/\/\S+)\r?\n/);
        if (match) resolve(match[1]);
      });
      browser.on('exit', () => reject(new Error(`Chrome exited:\n${log}`)));
    });
    cdp = await devtools(url);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    page = (method, params) => cdp.send(method, params, sessionId);
    cdp.on(({ method, params }) => {
      if (method === 'Runtime.exceptionThrown') errors.push(params.exceptionDetails.exception?.description);
      if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
        errors.push(params.args.map((a) => a.value ?? a.description).join(' '));
      }
    });
    await page('Runtime.enable');
    await page('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await page('Page.navigate', { url: `${origin}/` });
    await waitFor(`!!window.schall`);
  });

  after(async () => {
    cdp?.close();
    if (browser?.exitCode === null) {
      const exited = new Promise((resolve) => browser.once('exit', resolve));
      browser.kill();
      await exited;
    }
    server?.close();
    // Chrome's helper processes may still be writing for a moment.
    if (work) rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('starts measuring from the start button', async () => {
    if (await evaluate(`!document.getElementById('start').hidden`)) await click('#start-btn');
    await waitFor(`document.body.dataset.state === 'running'`);
    assert.equal(await text('#status'), 'Misst');
  });

  it('shows the level of the tones in dB(A), C and Z', async () => {
    await sleep(3000);
    const power = TONES.reduce((sum, [, db]) => sum + 10 ** (db / 10), 0);
    const expected = (w) =>
      powerToDb(TONES.reduce((sum, [hz, db]) => sum + 10 ** ((db + weightingCurve(w, hz)) / 10), 0)) +
      DEFAULT_OFFSET;
    near(number(await text('#leq')), expected('A'), 0.5, 'LAeq');
    near(number(await text('#now')), expected('A'), 0.5, 'LAF');
    near(number(await text('#max')), expected('A'), 0.6, 'LAFmax');
    await screenshot('level');
    await click('#weighting');
    await click('#weighting');
    assert.equal(await text('#weighting'), 'dB(Z)');
    near(number(await text('#leq')), powerToDb(power) + DEFAULT_OFFSET, 0.5, 'LZeq');
    await click('#weighting');
    assert.equal(await text('#leq-name'), 'LAeq');
  });

  it('lists the two tones as the strongest frequencies', async () => {
    await click('.tab[data-view="spectrum"]');
    await sleep(2500);
    const rows = await evaluate(
      `[...document.querySelectorAll('#peak-list li:not(.empty)')].map((li) => [...li.children].map((c) => c.textContent))`,
    );
    assert.ok(rows.length >= 2, JSON.stringify(rows));
    // The DSP core is exact to 0.01 Hz and 0.3 dB (core.test.js), but headless
    // Chrome bridges its fake microphone and fake output clocks with a drifting
    // resampler: the pitch wanders by up to ~0.5 %, which also smears the tone
    // over a few bins of the 10 s average and lowers its peak.
    const hz = (cell) => number(cell) * (cell.includes('kHz') ? 1000 : 1);
    near(hz(rows[0][1]), 440, 4.4, 'first frequency');
    assert.match(rows[0][2], /^A4 [+−]\d+ ct$/);
    near(number(rows[0][3]), -20 + DEFAULT_OFFSET, 3, 'level of 440 Hz');
    near(hz(rows[1][1]), 1250, 12.5, 'second frequency');
    near(number(rows[1][3]), -30 + DEFAULT_OFFSET, 3, 'level of 1250 Hz');
    // The spectrogram is drawn: WebGL pixels a little below the axis are lit.
    // The buffer is only readable in the frame it was drawn in, so check from
    // animation frames, which run right after the app's render loop.
    const lit = await evaluate(`new Promise((resolve) => {
      const c = document.getElementById('scope-gl');
      const gl = c.getContext('webgl2');
      const px = new Uint8Array(4 * c.width);
      let tries = 0;
      const check = () => {
        gl.readPixels(0, Math.floor(c.height * 0.3), c.width, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let n = 0;
        for (let i = 3; i < px.length; i += 4) if (px[i] > 0) n++;
        if (n / c.width > 0.9 || ++tries > 60) resolve(n / c.width);
        else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    })`);
    assert.ok(lit > 0.9, `spectrogram row coverage ${lit}`);
    await screenshot('spectrum');
  });

  it('records, lists and exports a WAV file', async () => {
    await click('#record');
    await waitFor(`document.body.classList.contains('recording')`);
    await sleep(1600);
    await click('#record');
    await waitFor(`!document.body.classList.contains('recording')`);
    await click('.tab[data-view="recordings"]');
    await waitFor(`document.querySelectorAll('#rec-list .rec').length === 1`);
    assert.match(await text('#rec-list .rec-meta'), /^0:0[12] · Ø \d+,\d · max \d+,\d dB\(A\)$/);
    const file = await evaluate(`(async () => {
      const { listRecordings, recordingFile } = await import('./js/recorder.js');
      const [row] = await listRecordings();
      const file = await recordingFile(row);
      const view = new DataView(await file.arrayBuffer());
      return { name: file.name, size: file.size, rate: view.getUint32(24, true), data: view.getUint32(40, true) };
    })()`);
    assert.match(file.name, /^schall-\d{4}-\d\d-\d\d-\d{6}\.wav$/);
    assert.equal(file.size, 44 + file.data);
    const seconds = file.data / 2 / file.rate;
    assert.ok(seconds > 1.2 && seconds < 2.5, `recorded ${seconds} s`);
    await screenshot('recordings');
  });

  it('calibrates against a reference reading', async () => {
    await click('.tab[data-view="level"]');
    await click('#settings-btn');
    await waitFor(`document.getElementById('settings').open`);
    assert.equal(await text('#cal-state'), 'Nicht kalibriert (Standardwert)');
    await evaluate(`document.getElementById('cal-ref').value = '80,0'`);
    await click('#cal-apply');
    assert.equal(await text('#cal-state'), 'Kalibriert');
    await screenshot('settings');
    await evaluate(`document.getElementById('settings').close()`);
    await sleep(400);
    near(number(await text('#now')), 80, 0.3, 'level after calibration');
    await click('#cal-reset');
    assert.equal(await text('#cal-value'), `+${DEFAULT_OFFSET},0 dB`);
    assert.equal(await evaluate('window.schall.settings.offset'), DEFAULT_OFFSET);
  });

  it('pauses and resumes', async () => {
    await click('.tab[data-view="level"]');
    await click('#toggle');
    await waitFor(`document.body.dataset.state === 'paused'`);
    await click('#toggle');
    await waitFor(`document.body.dataset.state === 'running'`);
  });

  it('logged no errors', () => {
    assert.deepEqual(errors, []);
  });
});

function near(actual, expected, tolerance, what) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: ${actual} is not within ±${tolerance} of ${expected.toFixed(2)}`,
  );
}

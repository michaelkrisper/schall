// Frequenzen tab: the strongest frequencies, the spectrum (live fill, averaged
// line) and the spectrogram. The DSP core already pools its 8192 bins into one
// value per display column; those rows go straight into WebGL2 textures and
// shaders do the rest (scaling, colour map, scrolling via a ring of rows).
// Labels, grid, peak markers and the cursor are a 2D canvas on top.

import { columnEdges, formatDb, formatHz, harmonics, noteOf } from './dsp.js';
import { ToneTracker, WINDOWS } from './tracker.js';

const MIN_HZ = 20;
const ROWS = 512; // spectrogram history, about 11 s
const MAX_COLS = 2048;
const AXIS = 18; // CSS px between spectrum and spectrogram for frequency labels
const SPAN = 90; // dB shown by the spectrum
const GRID = [
  [50, '50'],
  [100, '100'],
  [200, '200'],
  [500, '500'],
  [1000, '1k'],
  [2000, '2k'],
  [5000, '5k'],
  [10000, '10k'],
];
const MARKS = '①②③④⑤';
const PALETTE = [
  [0, [12, 13, 18]],
  [0.15, [30, 20, 70]],
  [0.35, [91, 26, 115]],
  [0.55, [179, 48, 92]],
  [0.72, [236, 106, 43]],
  [0.88, [251, 191, 36]],
  [1, [255, 251, 224]],
];

const VERTEX = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const SPECTRUM = `#version 300 es
precision highp float;
uniform sampler2D live;
uniform sampler2D avg;
uniform float cols;
uniform float width;
uniform vec2 area;   // bottom, height in device px
uniform vec2 range;  // dB at bottom and top
uniform float offset;
uniform float line;
out vec4 color;
float at(sampler2D t, float x) {
  return texelFetch(t, ivec2(clamp(int(x), 0, int(cols) - 1), 0), 0).r + offset;
}
float toY(float db) { return area.x + (db - range.x) / (range.y - range.x) * area.y; }
void main() {
  float x = gl_FragCoord.x / width * cols;
  float y = gl_FragCoord.y;
  float t = clamp((y - area.x) / area.y, 0.0, 1.0);
  vec4 c = vec4(0.0);
  if (y < toY(at(live, x))) c = vec4(0.13, 0.83, 0.93, 1.0) * (0.12 + 0.3 * t);
  // Averaged spectrum as a line through the neighbouring columns.
  float dx = cols / width;
  float a = toY(at(avg, x));
  float l = 0.5 * (a + toY(at(avg, x - dx)));
  float r = 0.5 * (a + toY(at(avg, x + dx)));
  float lo = min(a, min(l, r));
  float hi = max(a, max(l, r));
  float d = max(max(lo - y, y - hi), 0.0);
  float alpha = clamp(0.5 * line + 0.5 - d, 0.0, 1.0);
  color = vec4(0.96, 0.96, 0.97, 1.0) * alpha + c * (1.0 - alpha);
}`;

const SPECTROGRAM = `#version 300 es
precision highp float;
uniform sampler2D rows;
uniform sampler2D lut;
uniform float cols;
uniform float width;
uniform vec2 area;
uniform float head;
uniform float filled;
uniform vec2 range;
uniform float offset;
out vec4 color;
void main() {
  float age = floor((area.x + area.y - gl_FragCoord.y) / area.y * ${ROWS}.0);
  if (age >= filled) { color = vec4(0.0); return; }
  int row = int(mod(head - age + ${ROWS}.0, ${ROWS}.0));
  int col = clamp(int(gl_FragCoord.x / width * cols), 0, int(cols) - 1);
  float db = texelFetch(rows, ivec2(col, row), 0).r + offset;
  color = texture(lut, vec2(clamp((db - range.x) / (range.y - range.x), 0.0, 1.0), 0.5));
}`;

const $ = (id) => document.getElementById(id);

function palette() {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const k = PALETTE.findIndex(([stop]) => stop >= t);
    const [t1, c1] = PALETTE[Math.max(1, k)];
    const [t0, c0] = PALETTE[Math.max(1, k) - 1];
    const f = (t - t0) / (t1 - t0);
    for (let j = 0; j < 3; j++) lut[4 * i + j] = Math.round(c0[j] + (c1[j] - c0[j]) * f);
    lut[4 * i + 3] = 255;
  }
  return lut;
}

export function createSpectrumView() {
  const box = document.querySelector('.scope');
  const glCanvas = $('scope-gl');
  const overlay = $('scope-overlay');
  const list = $('peak-list');
  const o = overlay.getContext('2d');
  const gl = glCanvas.getContext('webgl2', { antialias: false, premultipliedAlpha: true });

  let audio = null;
  let settings = null;
  let visible = false;
  let cols = 0;
  let cssW = 0;
  let cssH = 0;
  let dpr = 1;
  let maxHz = 20000;
  let head = -1;
  let filled = 0;
  let lastAvg = null;
  let peaks = [];
  let tracker = null;
  let harm = [];
  let top = 100;
  let lowerSince = 0;
  let peaksAt = 0;
  let dirty = false;
  let cursorX = null;
  let cursorTimer = 0;

  const items = Array.from({ length: 5 }, (_, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="rank">${i + 1}</span><span class="hz">–</span><span class="meta"></span><span class="db"></span>`;
    list.append(li);
    return { li, hz: li.children[1], meta: li.children[2], db: li.children[3] };
  });

  // --- WebGL ---
  let progSpectrum;
  let progSpectrogram;
  let texLive;
  let texAvg;
  let texRows;
  if (gl) {
    const compile = (source) => {
      const program = gl.createProgram();
      for (const [type, src] of [
        [gl.VERTEX_SHADER, VERTEX],
        [gl.FRAGMENT_SHADER, source],
      ]) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, src);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
        gl.attachShader(program, shader);
      }
      gl.bindAttribLocation(program, 0, 'p');
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      const uniforms = {};
      const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < count; i++) {
        const { name } = gl.getActiveUniform(program, i);
        uniforms[name] = gl.getUniformLocation(program, name);
      }
      return { program, uniforms };
    };
    progSpectrum = compile(SPECTRUM);
    progSpectrogram = compile(SPECTROGRAM);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const texture = (unit, filter) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    texLive = texture(0, gl.NEAREST);
    texAvg = texture(1, gl.NEAREST);
    texRows = texture(2, gl.NEAREST);
    texture(3, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, palette());
  } else {
    box.classList.add('no-gl');
  }

  // --- Layout ---
  const spectrumHeight = () => Math.round((cssH - AXIS) * 0.5);
  const xOf = (hz) => (cssW * Math.log(hz / MIN_HZ)) / Math.log(maxHz / MIN_HZ);
  const hzOf = (x) => MIN_HZ * (maxHz / MIN_HZ) ** (x / cssW);
  const yOf = (db) => spectrumHeight() * (1 - (db - (top - SPAN)) / SPAN);

  function resize() {
    const w = box.clientWidth;
    const h = box.clientHeight;
    if (!w || !h) return;
    const ratio = window.devicePixelRatio || 1;
    if (w === cssW && h === cssH && ratio === dpr && cols) return;
    [cssW, cssH, dpr] = [w, h, ratio];
    for (const canvas of [glCanvas, overlay]) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    cols = Math.min(Math.round(w * dpr), MAX_COLS);
    // Columns must come in fours for the DSP core's SIMD dB conversion.
    cols -= cols % 4;
    head = -1;
    filled = 0;
    lastAvg = null;
    if (gl) {
      const empty = (unit, t, height) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, cols, height, 0, gl.RED, gl.FLOAT, null);
      };
      empty(0, texLive, 1);
      empty(1, texAvg, 1);
      empty(2, texRows, ROWS);
    }
    sendColumns();
    dirty = true;
    drawOverlay();
  }

  function sendColumns() {
    if (!audio || !cols) return;
    maxHz = Math.min(20000, audio.sampleRate / 2);
    audio.send({ type: 'columns', edges: columnEdges(cols, MIN_HZ, maxHz, audio.binHz) });
  }

  function drawGl() {
    if (!gl || !cols) return;
    const W = glCanvas.width;
    const H = glCanvas.height;
    const sH = spectrumHeight() * dpr;
    const gH = (cssH - spectrumHeight() - AXIS) * dpr;
    gl.viewport(0, 0, W, H);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    if (filled === 0) return;
    const off = settings.offset;

    let u = progSpectrum.uniforms;
    gl.useProgram(progSpectrum.program);
    gl.scissor(0, H - sH, W, sH);
    gl.uniform1i(u.live, 0);
    gl.uniform1i(u.avg, 1);
    gl.uniform1f(u.cols, cols);
    gl.uniform1f(u.width, W);
    gl.uniform2f(u.area, H - sH, sH);
    gl.uniform2f(u.range, top - SPAN, top);
    gl.uniform1f(u.offset, off);
    gl.uniform1f(u.line, 1.5 * dpr);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    u = progSpectrogram.uniforms;
    gl.useProgram(progSpectrogram.program);
    gl.scissor(0, 0, W, gH);
    gl.uniform1i(u.rows, 2);
    gl.uniform1i(u.lut, 3);
    gl.uniform1f(u.cols, cols);
    gl.uniform1f(u.width, W);
    gl.uniform2f(u.area, 0, gH);
    gl.uniform1f(u.head, head);
    gl.uniform1f(u.filled, filled);
    gl.uniform2f(u.range, top - 75, top - 5);
    gl.uniform1f(u.offset, off);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function drawOverlay() {
    if (!cssW) return;
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    o.clearRect(0, 0, cssW, cssH);
    o.lineWidth = 1;
    drawGrid();
    drawMarkers();
    if (cursorX !== null && lastAvg) drawCursor();
    o.textAlign = 'left';
  }

  function drawGrid() {
    const sH = spectrumHeight();
    o.font = '10px system-ui, sans-serif';
    o.strokeStyle = 'rgb(255 255 255 / 0.07)';
    o.fillStyle = '#71717a';
    o.textBaseline = 'bottom';
    o.textAlign = 'left';
    for (let d = top - SPAN + 10; d < top; d += 10) {
      const y = Math.round(yOf(d)) + 0.5;
      o.beginPath();
      o.moveTo(0, y);
      o.lineTo(cssW, y);
      o.stroke();
      if (d % 20 === 0) o.fillText(d === top - 10 ? `${d} dB` : String(d), 3, y - 1);
    }
    o.textAlign = 'center';
    o.textBaseline = 'middle';
    for (const [hz, label] of GRID) {
      if (hz >= maxHz) continue;
      const x = Math.round(xOf(hz)) + 0.5;
      o.beginPath();
      o.moveTo(x, 0);
      o.lineTo(x, sH);
      o.stroke();
      o.fillText(label, Math.min(Math.max(x, 10), cssW - 12), sH + AXIS / 2);
    }
  }

  // Numbered markers on the averaged line, the strongest drawn last (on top).
  function drawMarkers() {
    const sH = spectrumHeight();
    o.font = '600 11px system-ui, sans-serif';
    o.textAlign = 'center';
    o.textBaseline = 'middle';
    for (let i = peaks.length - 1; i >= 0; i--) {
      const p = peaks[i];
      const x = xOf(p.hz);
      const y = Math.min(Math.max(yOf(p.db + settings.offset) - 12, 9), sH - 9);
      o.fillStyle = '#fbbf24';
      o.beginPath();
      o.arc(x, y, 8, 0, 2 * Math.PI);
      o.fill();
      o.fillStyle = '#1c1917';
      o.fillText(String(i + 1), x, y + 0.5);
    }
  }

  function drawCursor() {
    const x = Math.round(cursorX) + 0.5;
    o.strokeStyle = 'rgb(255 255 255 / 0.6)';
    o.beginPath();
    o.moveTo(x, 0);
    o.lineTo(x, cssH);
    o.stroke();
    const hz = hzOf(cursorX);
    const col = Math.min(cols - 1, Math.floor((cursorX / cssW) * cols));
    const text = `${formatHz(hz)} · ${formatDb(lastAvg[col] + settings.offset, 0)} dB · ${noteOf(hz).name}`;
    o.font = '600 12px system-ui, sans-serif';
    o.textAlign = 'center';
    o.textBaseline = 'middle';
    const tw = o.measureText(text).width + 14;
    const bx = Math.min(Math.max(cursorX - tw / 2, 2), cssW - tw - 2);
    o.fillStyle = 'rgb(24 24 27 / 0.92)';
    o.beginPath();
    o.roundRect(bx, 4, tw, 22, 6);
    o.fill();
    o.fillStyle = '#f4f4f5';
    o.fillText(text, bx + tw / 2, 15.5);
  }

  // The averaged level near a frequency, for the marker on the averaged line.
  function levelNear(db, hz) {
    const k = Math.round(hz / audio.binHz);
    let max = Number.NEGATIVE_INFINITY;
    for (let i = Math.max(0, k - 2); i <= Math.min(db.length - 1, k + 2); i++) max = Math.max(max, db[i]);
    return max;
  }

  function renderList() {
    const off = settings.offset;
    items.forEach((item, i) => {
      const p = peaks[i];
      item.li.classList.toggle('empty', !p);
      if (!p) {
        item.hz.textContent = '–';
        item.meta.textContent = '';
        item.db.textContent = '';
        item.li.style.setProperty('--w', '0');
        return;
      }
      item.hz.textContent = formatHz(p.hz);
      const h = harm[i];
      let meta = '';
      if (h) meta = `${h.k}× ${MARKS[h.of]}`;
      else if (p.hz >= 27.5 && p.hz <= 4200) {
        const n = noteOf(p.hz);
        meta = `${n.name} ${n.cents >= 0 ? '+' : '−'}${Math.abs(n.cents)} ct`;
      }
      item.meta.textContent = meta;
      item.db.textContent = `${formatDb(p.level + off)} dB`;
      // The bar shows how steadily the tone is there: full = all the time.
      item.li.style.setProperty('--w', String(Math.max(0.04, p.presence)));
    });
  }

  // The spectrum's scale follows the loudest part: up at once, down after 3 s.
  function autoRange(now) {
    if (!lastAvg) return;
    let max = -Infinity;
    for (const v of lastAvg) if (v > max) max = v;
    const target = Math.min(150, Math.max(40, Math.ceil((max + settings.offset + 8) / 10) * 10));
    if (target > top) {
      top = target;
      lowerSince = 0;
    } else if (target < top - 10) {
      lowerSince ||= now;
      if (now - lowerSince > 3000) {
        top = target;
        lowerSince = 0;
      }
    } else lowerSince = 0;
  }

  // Cursor: touch or drag on the plot; stays 2.5 s after letting go.
  overlay.addEventListener('pointerdown', (e) => {
    overlay.setPointerCapture(e.pointerId);
    clearTimeout(cursorTimer);
    cursorX = e.offsetX;
    drawOverlay();
  });
  overlay.addEventListener('pointermove', (e) => {
    if (!overlay.hasPointerCapture(e.pointerId)) return;
    cursorX = Math.min(Math.max(e.offsetX, 0), cssW - 1);
    drawOverlay();
  });
  const release = () => {
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => {
      cursorX = null;
      drawOverlay();
    }, 2500);
  };
  overlay.addEventListener('pointerup', release);
  overlay.addEventListener('pointercancel', release);

  new ResizeObserver(() => visible && resize()).observe(box);

  return {
    attach(next, s) {
      audio = next;
      settings = s;
      cols = 0;
      maxHz = Math.min(20000, audio.sampleRate / 2);
      tracker = new ToneTracker(audio.binHz);
      peaks = [];
      harm = [];
      renderList();
      if (visible) resize();
    },
    detach() {
      audio = null;
    },
    show(on, s) {
      visible = on;
      settings = s;
      if (on) {
        resize();
        drawGl();
        drawOverlay();
      }
    },
    reset() {
      tracker?.reset();
      peaks = [];
      harm = [];
      renderList();
      drawOverlay();
    },
    onSpectrum(live, avg) {
      if (live.length !== cols || !gl) return;
      head = (head + 1) % ROWS;
      filled = Math.min(filled + 1, ROWS);
      gl.activeTexture(gl.TEXTURE0);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, 1, gl.RED, gl.FLOAT, live);
      gl.activeTexture(gl.TEXTURE1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, 1, gl.RED, gl.FLOAT, avg);
      gl.activeTexture(gl.TEXTURE2);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, head, cols, 1, gl.RED, gl.FLOAT, live);
      lastAvg = avg;
      dirty = true;
    },
    /** `db`: the selected average, `current`: the latest spectrum, which the tracker follows. */
    onAverage(db, current) {
      if (!audio) return;
      tracker.update(current, { maxHz });
      peaks = tracker
        .ranked(WINDOWS[settings.averaging])
        .map((tone) => ({ ...tone, db: levelNear(db, tone.hz) }));
      harm = harmonics(peaks, audio.binHz);
      if (!visible) return;
      renderList();
      drawOverlay();
    },
    /** Every animation frame while measuring, visible or not: the tracker needs the whole history. */
    frame(now, s) {
      settings = s;
      if (!audio) return;
      if (now - peaksAt >= 250) {
        peaksAt = now;
        if (visible) autoRange(now);
        audio.send({ type: 'average' });
      }
      if (visible && dirty) {
        drawGl();
        dirty = false;
      }
    },
    redraw(s) {
      settings = s;
      if (!visible) return;
      renderList();
      drawGl();
      drawOverlay();
    },
    /** For the browser test: state and the spectrogram's top edge in GL pixels. */
    debug() {
      return { gl: !!gl, cols, filled, top: (cssH - spectrumHeight() - AXIS) * dpr };
    },
  };
}

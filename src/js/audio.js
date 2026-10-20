// Microphone → AudioWorklet running the WebAssembly DSP core. Everything heavy
// happens on the audio thread; the page only receives levels and spectra.

import { FFT_SIZE, hopFor, packFilters, REPORT_SECONDS } from './dsp.js';

// The raw signal: voice processing would pump the level and bend the spectrum.
const CONSTRAINTS = {
  audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
};

let module;

// The DSP core needs WebAssembly SIMD (Safari 16.4+, Chrome 91+, Firefox 89+).
export function loadDsp() {
  module ??= fetch(new URL('../dsp.wasm', import.meta.url))
    .then((response) => {
      if (!response.ok) throw new Error(`dsp.wasm: HTTP ${response.status}`);
      return response.arrayBuffer();
    })
    .then((bytes) => {
      if (!WebAssembly.validate(bytes)) throw Object.assign(new Error('no SIMD'), { name: 'SimdError' });
      return bytes;
    });
  module.catch(() => {
    module = undefined;
  });
  return module;
}

// Call straight from a tap: the AudioContext is created before the first
// await, so iOS counts it as started by the user.
export async function startAudio({ mode, onLevel, onSpectrum, onAverage, onPcm, onRecordEnd, onEnded }) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw Object.assign(new Error('no getUserMedia'), { name: 'InsecureError' });
  }
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  ctx.resume().catch(() => {});
  let stream;
  try {
    const [bytes] = await Promise.all([
      loadDsp(),
      ctx.audioWorklet.addModule(new URL('worklet.js', import.meta.url)),
    ]);
    stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS);
    const rate = ctx.sampleRate;
    const node = new AudioWorkletNode(ctx, 'schall', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: {
        wasm: bytes,
        filters: packFilters(rate),
        fftSize: FFT_SIZE,
        hop: hopFor(rate),
        reportSamples: Math.round(rate * REPORT_SECONDS),
        mode,
      },
    });
    node.port.onmessage = ({ data }) => {
      if (data.type === 'level') onLevel(data.report);
      else if (data.type === 'spectrum') onSpectrum(data.live, data.average);
      else if (data.type === 'average') onAverage(data.db, data.current);
      else if (data.type === 'pcm') onPcm(data.data);
      else if (data.type === 'record-end') onRecordEnd();
    };
    // The node outputs silence; being connected keeps it running everywhere.
    ctx.createMediaStreamSource(stream).connect(node).connect(ctx.destination);
    const [track] = stream.getAudioTracks();
    track.addEventListener('ended', onEnded);
    return {
      ctx,
      sampleRate: rate,
      binHz: rate / FFT_SIZE,
      send: (message, transfer = []) => node.port.postMessage(message, transfer),
      stop() {
        for (const t of stream.getTracks()) t.stop();
        ctx.close().catch(() => {});
      },
    };
  } catch (error) {
    for (const t of stream?.getTracks() ?? []) t.stop();
    ctx.close().catch(() => {});
    throw error;
  }
}

export function errorText(error) {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Kein Zugriff aufs Mikrofon. Bitte in den Browser-Einstellungen für diese Seite erlauben.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Kein Mikrofon gefunden.';
    case 'NotReadableError':
      return 'Das Mikrofon wird gerade von einer anderen App verwendet.';
    case 'SimdError':
      return 'Dieser Browser ist zu alt (WebAssembly SIMD fehlt). Bitte aktualisieren.';
    case 'InsecureError':
      return 'Das Mikrofon ist nur über HTTPS verfügbar.';
    default:
      return `Start fehlgeschlagen: ${error?.message ?? error}`;
  }
}

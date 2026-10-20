// The audio thread: hands every block from the microphone to the WebAssembly
// DSP core (wasm/src/lib.rs) and posts its results to the page. Kept free of
// imports; everything it needs comes in through processorOptions.

const REPORT_LENGTH = 26;
const MAX_BLOCK = 1024;

class SchallProcessor extends AudioWorkletProcessor {
  constructor({ processorOptions: options }) {
    super();
    const { exports } = new WebAssembly.Instance(new WebAssembly.Module(options.wasm), {});
    this.dsp = exports;
    const memory = exports.memory.buffer;
    new Float64Array(memory, exports.filters_ptr(), options.filters.length).set(options.filters);
    exports.setup(sampleRate, options.fftSize, options.hop, options.reportSamples);
    exports.set_mode(options.mode);
    this.input = new Float32Array(memory, exports.input_ptr(), MAX_BLOCK);
    this.report = new Float64Array(memory, exports.report_ptr(), REPORT_LENGTH);
    this.cols = 0;
    this.port.onmessage = ({ data }) => this.command(data);
  }

  command(data) {
    const dsp = this.dsp;
    if (data.type === 'columns') {
      new Float32Array(dsp.memory.buffer, dsp.edges_ptr(), data.edges.length).set(data.edges);
      this.cols = dsp.columns(data.edges.length / 2) === 0 ? data.edges.length / 2 : 0;
      this.live = new Float32Array(dsp.memory.buffer, dsp.live_ptr(), this.cols);
      this.average = new Float32Array(dsp.memory.buffer, dsp.average_ptr(), this.cols);
    } else if (data.type === 'mode') {
      dsp.set_mode(data.mode);
    } else if (data.type === 'reset') {
      dsp.reset_spectrum();
    } else if (data.type === 'average') {
      const db = new Float32Array(dsp.memory.buffer, dsp.average_db(), dsp.bins()).slice();
      this.port.postMessage({ type: 'average', db }, [db.buffer]);
    } else if (data.type === 'record') {
      if (data.on) {
        this.pcm = new Int16Array(Math.round(sampleRate / 2));
        this.pcmFill = 0;
      } else if (this.pcm) {
        this.flushPcm();
        this.pcm = null;
        this.port.postMessage({ type: 'record-end' });
      }
    }
  }

  // Recording: 16-bit samples in half-second chunks.
  record(channel) {
    const pcm = this.pcm;
    for (let i = 0; i < channel.length; i++) {
      const x = channel[i];
      pcm[this.pcmFill++] = x >= 1 ? 32767 : x <= -1 ? -32768 : Math.round(x * 32767);
      if (this.pcmFill === pcm.length) this.flushPcm();
    }
  }

  flushPcm() {
    if (!this.pcmFill) return;
    const data = this.pcm.slice(0, this.pcmFill);
    this.port.postMessage({ type: 'pcm', data }, [data.buffer]);
    this.pcmFill = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    if (this.pcm) this.record(channel);
    this.input.set(channel);
    const flags = this.dsp.process(channel.length);
    if (flags & 1) {
      const report = this.report.slice();
      this.port.postMessage({ type: 'level', report }, [report.buffer]);
    }
    if (flags & 2 && this.cols) {
      const live = this.live.slice();
      const average = this.average.slice();
      this.port.postMessage({ type: 'spectrum', live, average }, [live.buffer, average.buffer]);
    }
    return true;
  }
}

registerProcessor('schall', SchallProcessor);

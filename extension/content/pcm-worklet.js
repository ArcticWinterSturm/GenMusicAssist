/**
 * sunolift / extension / content / pcm-worklet.js
 * ---------------------------------------------------------------------------
 * AudioWorklet processor for the high-fidelity PCM capture tier.
 *
 * Why a worklet instead of MediaRecorder
 *  - MediaRecorder hands back an opaque encoded blob, so the only place to undo
 *    the page's volume slider is a live GainNode, and the correction is baked in
 *    with whatever headroom decision we made at capture time. With raw frames the
 *    app can divide the recorded gain timeline out of the samples afterwards.
 *  - It also means no ffmpeg on the machine: the app writes a WAV itself.
 *
 * Two things this file deliberately does NOT do
 *  - It does not apply gain. Correction belongs to the recorded data + the
 *    metadata timeline, so a wrong timeline can be detected and re-run.
 *  - It does not post per-quantum. 128 samples every 2.7 ms would be ~370
 *    postMessage calls a second and the tab would spend its life cloning
 *    buffers. We accumulate to ~1 s and send one interleaved Float32 block,
 *    and `flush` lets the caller drain the tail at stop time.
 */

const TARGET_FRAMES = 48000;   // ~1 s at 48 kHz

class GenMusicAssistTapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const ch = Math.max(1, (options && options.numberOfInputs && options.channelCount) || 2);
    this.channels = ch;
    // The sample rate the audio thread is running at. `sampleRate` is a global
    // in AudioWorkletGlobalScope, but reading it bare is the kind of thing that
    // throws inside the audio thread (where the only symptom is silence), so it
    // is resolved once, defensively, and carried on the message.
    this.rate = Number(options?.processorOptions?.sampleRate) || Number(globalThis.sampleRate) || 48000;
    this.accum = new Float32Array(TARGET_FRAMES * ch);
    this.filled = 0;
    this.total = 0;
    this.peak = 0;
    this.clipped = 0;
    this.active = options?.processorOptions?.active !== false;
    this.captureId = null;
    this.seq = 0;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === 'config') this.active = d.active !== false;
      if (d.type === 'start') {
        this.captureId = d.captureId;
        this.filled = 0; this.total = 0; this.seq = 0; this.peak = 0; this.clipped = 0;
        this.active = true;
      }
      if (d.type === 'stop' && d.captureId === this.captureId) {
        this.active = false;
        if (this.filled) this.emit(false);
        this.port.postMessage({ type: 'flushed', captureId: this.captureId, total: this.total });
      }
      if (d.type === 'flush') this.emit(true);
    };
  }

  emit(force) {
    if (!this.filled && !force) return;
    const n = this.filled;
    const out = this.accum.subarray(0, n * this.channels);
    // copy, because accum is re-used immediately by the audio thread
    this.port.postMessage({
      type: 'pcm', captureId: this.captureId, seq: this.seq++, samples: n, channels: this.channels,
      rate: this.rate || Number(globalThis.sampleRate) || 48000,
      peak: this.peak, clipped: this.clipped, total: this.total,
      buffer: out.slice(0),
    });
    this.filled = 0;
  }

  process(inputs) {
    const inp = inputs[0];
    if (!this.active || !inp || !inp.length) return true;
    const n = inp[0].length;
    if (this.filled + n > TARGET_FRAMES) this.emit(false);
    const base = this.filled * this.channels;
    for (let c = 0; c < this.channels; c++) {
      const src = inp[c] || inp[0];
      for (let i = 0; i < n; i++) {
        const v = src[i];
        const a = v < 0 ? -v : v;
        if (a > this.peak) this.peak = a;
        if (a > 1) this.clipped++;
        this.accum[base + i * this.channels + c] = v;
      }
    }
    this.filled += n;
    this.total += n;
    return true;
  }
}

registerProcessor('sunolift-tap', GenMusicAssistTapProcessor);

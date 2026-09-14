/**
 * sunolift / shared / dsp.js
 * ---------------------------------------------------------------------------
 * Pure-JS audio DSP shared by the browser extension (MAIN-world tap) and the
 * desktop app. No Node or DOM APIs, so it runs identically in both.
 *
 * THE PROBLEM THIS SOLVES
 * Suno's web player applies the on-screen volume slider to the HTMLMediaElement
 * itself (`element.volume`), *upstream* of any Web Audio tap. Chrome's
 * MediaElementAudioSourceNode therefore hands us an already-attenuated signal:
 * set the UI to 10% and a naive recorder writes a -20 dB file. That is the
 * "recording follows the volume on the screen" failure the capture tool must
 * not inherit from Audacity.
 *
 * THE FIX
 * We sample `element.volume` on a clock, keep it as a GainTimeline, and undo it
 * with sample-accurate interpolation (`invertInto`). Undoing a slider is only
 * valid while the slider is the *only* unknown, so the timeline is part of the
 * recorded metadata and any segment that was captured at gain 0 is flagged
 * unusable rather than silently normalised (division by zero would explode).
 * Afterwards we measure loudness to ITU-R BS.1770-4 and normalise to a target,
 * so two takes of the same song at different slider positions converge on the
 * same file.
 */

import { round, clamp } from './util.js';

export const CLIP_DB = -1.0;           // ceiling we never print past, dBFS
export const DEFAULT_TARGET_LUFS = -14.0; // streaming loudness target
export const ABSOLUTE_GATE_LUFS = -70.0;  // BS.1770 gating

/* ------------------------------------------------------------------ *
 * Gain timeline                                                      *
 * ------------------------------------------------------------------ */

/**
 * Records the UI gain (0..1) the media element was set to, over time.
 * Points are `[tSeconds, gain]` and must stay sorted by t.
 */
export class GainTimeline {
  constructor() { this.points = []; }

  /** @param {number} t monotonic seconds (media clock or perf clock) @param {number} g linear gain 0..1 */
  add(t, g) {
    const gain = clamp(Number(g) || 0, 0, 1);
    const p = this.points;
    if (p.length && t - p[p.length - 1][0] < 0.008 && Math.abs(p[p.length - 1][1] - gain) < 1e-4) return;
    p.push([t, gain]);
    return this;
  }

  at(t) {
    const p = this.points;
    if (!p.length) return 1;
    if (t <= p[0][0]) return p[0][1];
    if (t >= p[p.length - 1][0]) return p[p.length - 1][1];
    // binary search for the bracketing pair, then linearly interpolate
    let lo = 0, hi = p.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (p[mid][0] <= t) lo = mid; else hi = mid;
    }
    const [t0, g0] = p[lo], [t1, g1] = p[hi];
    const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
    return g0 + (g1 - g0) * f;
  }

  /** True when any sampled gain was 0: inversion is impossible for those samples. */
  hasSilence() { return this.points.some(([, g]) => g <= 1e-4); }

  min() { return this.points.length ? Math.min(...this.points.map(([, g]) => g)) : 1; }
  max() { return this.points.length ? Math.max(...this.points.map(([, g]) => g)) : 1; }

  /** Slider moves, for the metadata record. */
  ramps(minDelta = 0.01) {
    const out = [];
    for (let i = 1; i < this.points.length; i++) {
      const [ta, ga] = this.points[i - 1], [tb, gb] = this.points[i];
      if (Math.abs(gb - ga) >= minDelta) out.push({ t: tb, from: round(ga, 4), to: round(gb, 4) });
    }
    return out;
  }

  toJSON() {
    return {
      sample_count: this.points.length,
      min: round(this.min(), 4),
      max: round(this.max(), 4),
      had_zero_gain: this.hasSilence(),
      ramps: this.ramps(),
      points: this.points.map(([t, g]) => [round(t, 3), round(g, 4)]),
    };
  }

  static fromJSON(o) {
    const g = new GainTimeline();
    for (const [t, v] of (o && o.points) || []) g.points.push([t, v]);
    return g;
  }
}

/**
 * Undo the UI gain in place. `startT`/`frameStep` let us map audio frames to
 * the wall/media clock the timeline was sampled against.
 *
 * Inversion is clamped: lifting a -40 dB slider by 40 dB also lifts anything
 * the player dithered into the noise floor. `MAX_LIFT_DB` bounds the damage and
 * the amount actually applied is returned so the caller can record it.
 */
export const MAX_LIFT_DB = 24;
export function invertGainInto(ch, timeline, startT = 0, sampleRate = 48000, maxLiftDb = MAX_LIFT_DB) {
  const cap = dbToGain(maxLiftDb);
  let appliedSum = 0, n = 0, clipped = 0;
  if (!ch || !ch.length || !timeline || !timeline.points.length) return { appliedGain: 1, clippedSamples: 0 };
  for (let i = 0; i < ch.length; i++) {
    const g = timeline.at(startT + i / sampleRate);
    if (g <= 1e-4) continue;                 // silence: nothing to recover, leave as-is
    let k = Math.min(1 / g, cap);
    if (1 / g > cap) clipped++;
    ch[i] = ch[i] * k;
    appliedSum += k; n++;
  }
  return { appliedGain: n ? appliedSum / n : 1, clippedSamples: clipped };
}

/* ------------------------------------------------------------------ *
 * Level / loudness                                                   *
 * ------------------------------------------------------------------ */

/**
 * Biquad, direct form I, `a0 == 1`:
 *   y[n] = b0 x[n] + b1 x[n-1] + b2 x[n-2] - a1 y[n-1] - a2 y[n-2]
 * NOTE the sign convention: ITU-R BS.1770-4's published tables store a1/a2 with
 * the *opposite* sign (they are written as `+ a1 y[n-1]`). `K_WEIGHTING_48K`
 * below is the raw table, so we negate when constructing. Getting this backwards
 * turns a meter into a resonator that reads -73 dB.
 */
class Biquad {
  constructor(b0, b1, b2, a1, a2) { this.b0 = b0; this.b1 = b1; this.b2 = b2; this.a1 = a1; this.a2 = a2; this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
  reset() { this.x1 = this.x2 = this.y1 = this.y2 = 0; }
}

/** ITU-R BS.1770-4 §2 tables for fs=48000, [b0,b1,b2,a1,a2] in the doc's sign convention. */
export const K_WEIGHTING_48K = {
  shelf: [1.53512485958697, -2.69169618940638, 1.19839281780617, 1.69065929318241, -0.73248077421585],
  highpass: [1.0, -2.0, 1.0, 1.99004745483398, -0.99011997587561],
};

/** Frequency response (linear magnitude) of one biquad section, table convention. */
export function biquadMagnitude(coeffs, freqHz, sampleRate) {
  const [b0, b1, b2, a1, a2] = coeffs, w = (2 * Math.PI * freqHz) / sampleRate;
  const re = b0 + b1 * Math.cos(w) + b2 * Math.cos(2 * w);
  const im = -(b1 * Math.sin(w) + b2 * Math.sin(2 * w));
  const dre = 1 - a1 * Math.cos(w) - a2 * Math.cos(2 * w);
  const dim = a1 * Math.sin(w) + a2 * Math.sin(2 * w);
  return Math.hypot(re, im) / Math.hypot(dre, dim);
}

/** K-weighting magnitude in dB, both stages cascaded. */
export function kWeightingDb(freqHz, sampleRate = 48000) {
  const s = kWeightCoeffsAt(sampleRate);
  return 20 * Math.log10(biquadMagnitude(s.shelf, freqHz, sampleRate) * biquadMagnitude(s.highpass, freqHz, sampleRate));
}

function kWeightCoeffsAt(sampleRate) {
  if (Math.abs(sampleRate - 48000) < 1) return K_WEIGHTING_48K;
  // Other rates: re-derive with the same analog prototypes (prewarped bilinear).
  // Deviation vs the 48 kHz table is < 0.02 dB in the audio band; we resample to
  // 48 kHz before measuring anyway so this path is only used for odd-rate inputs.
  const f0 = 1681.974450955533, Gdb = 3.999843853973347, Qs = 0.7071752369554196;
  const K = Math.tan(Math.PI * f0 / sampleRate), Vh = 10 ** (Gdb / 20), Vb = Vh ** 0.4996667741545416;
  const t = 2 * Math.sqrt(Vb) * K * Qs, a0 = (Vb + 1) + (Vb - 1) * K + t;
  const shelf = [
    Vh * ((Vb + 1) + (Vb - 1) * K + t) / a0, (2 * Vh * ((Vb - 1) + (Vb + 1) * K)) / a0,
    Vh * ((Vb + 1) + (Vb - 1) * K - t) / a0, -(2 * ((Vb - 1) + (Vb + 1) * K)) / a0,
    -((Vb + 1) + (Vb - 1) * K - t) / a0,
  ];
  const F = 39.99967, Qh = 0.5001529668551885;
  const K2 = Math.tan(Math.PI * F / sampleRate), den = 1 + K2 / Qh + K2 * K2;
  const highpass = [1 / den, -2 / den, 1 / den, -(2 * (K2 * K2 - 1)) / den, -((1 - K2 / Qh + K2 * K2)) / den];
  return { shelf, highpass };
}

/**
 * Fresh K-weighting chain (shelf -> RLB high-pass) for a sample rate.
 * Biquad ctor takes the minus-feedback convention, so negate the table's a1/a2.
 */
export function makeKWeighting(sampleRate) {
  const c = kWeightCoeffsAt(sampleRate);
  const mk = ([b0, b1, b2, a1, a2]) => new Biquad(b0, b1, b2, -a1, -a2);
  return [mk(c.shelf), mk(c.highpass)];
}

/**
 * Integrated loudness, LUFS, per ITU-R BS.1770-4 with gating.
 * @param {Float32Array[]} channels interleaved-as-planar blocks of mono data
 */
export function measureLoudness(channels, sampleRate) {
  const chn = channels.filter((c) => c && c.length);
  if (!chn.length) return { integratedLufs: -Infinity, momentary: [], blockCount: 0 };
  const blocks = Math.floor(0.4 * sampleRate), step = Math.floor(blocks / 2);
  const chains = chn.map(() => makeKWeighting(sampleRate));
  // Channel weighting: stereo L/R are 1.0. Mono is L (1.0).
  const weights = chn.map((_, i) => (i === 2 || i === 3 ? 1.5 : 1.0));
  const z = [];
  for (let start = 0; start + blocks <= chn[0].length; start += step) {
    let power = 0;
    for (let c = 0; c < chn.length; c++) {
      const [a, b] = chains[c];
      a.reset(); b.reset();
      let acc = 0;
      const src = chn[c];
      for (let i = start; i < start + blocks; i++) { const y = b.process(a.process(src[i])); acc += y * y; }
      power += weights[c] * (acc / blocks);
    }
    z.push(power);
  }
  if (!z.length) return { integratedLufs: -Infinity, momentary: [], blockCount: 0 };
  const lufsOf = (p) => (p > 0 ? -0.691 + 10 * Math.log10(p) : -Infinity);
  const absGate = z.filter((p) => lufsOf(p) > ABSOLUTE_GATE_LUFS);
  if (!absGate.length) return { integratedLufs: -Infinity, momentary: z.map(lufsOf), blockCount: z.length };
  const meanAbs = absGate.reduce((a, b) => a + b, 0) / absGate.length;
  const relThreshold = lufsOf(meanAbs) - 10;
  const gated = absGate.filter((p) => lufsOf(p) > relThreshold);
  const mean = gated.reduce((a, b) => a + b, 0) / (gated.length || 1);
  return { integratedLufs: lufsOf(mean), momentary: z.map(lufsOf), blockCount: z.length, gated_blocks: gated.length };
}

/** Apply a gain and soft-protect the peak (cheap brickwall + fade-free clamp). */
export function normalizeToLoudness(channels, targetLufs = DEFAULT_TARGET_LUFS, currentLufs = null, sampleRate = 48000) {
  const cur = currentLufs === null ? measureLoudness(channels, sampleRate).integratedLufs : currentLufs;
  if (!isFinite(cur)) return { gain: 1, applied: false, reason: 'unmeasurable' };
  let gain = dbToGain(targetLufs - cur);
  const peak = peakLinear(channels);
  const ceiling = dbToGain(CLIP_DB);
  let limited = false;
  if (peak * gain > ceiling) { gain = ceiling / Math.max(peak, 1e-9); limited = true; }
  for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i] = clamp(ch[i] * gain, -1, 1);
  return { gain, applied: true, peakLimited: limited, beforeLufs: cur, peakAfter: peak * gain };
}

export function peakLinear(channels) {
  let p = 0;
  for (const ch of channels) if (ch) for (let i = 0; i < ch.length; i++) { const v = Math.abs(ch[i]); if (v > p) p = v; }
  return p;
}

export function rms(ch) {
  if (!ch || !ch.length) return 0;
  let s = 0; for (let i = 0; i < ch.length; i++) s += ch[i] * ch[i];
  return Math.sqrt(s / ch.length);
}

/* ------------------------------------------------------------------ *
 * Geometry helpers                                                   *
 * ------------------------------------------------------------------ */

export const dbToGain = (db) => 10 ** (db / 20);
export const gainToDb = (g) => (g > 0 ? 20 * Math.log10(g) : -Infinity);
export { clamp, round };

/** Linear resample a mono Float32Array. Used to get to the encoder's rate. */
export function resampleMono(src, fromRate, toRate) {
  if (fromRate === toRate || !src.length) return src;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.max(1, Math.floor(src.length / ratio)));
  for (let i = 0; i < out.length; i++) {
    const p = i * ratio, i0 = Math.floor(p), i1 = Math.min(src.length - 1, i0 + 1), f = p - i0;
    out[i] = src[i0] * (1 - f) + src[i1] * f;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * WAV container (pure JS — no ffmpeg needed for the archive format) *
 * ------------------------------------------------------------------ */

/** @returns {Uint8Array} 16-bit PCM stereo (or mono) WAV */
export function encodeWav(channels, sampleRate, { bitDepth = 16 } = {}) {
  const planar = channels.filter((c) => c && c.length);
  const nCh = Math.max(1, planar.length);
  const frames = planar.length ? Math.max(...planar.map((c) => c.length)) : 0;
  const bytesPerSample = bitDepth >> 3;
  const blockAlign = nCh * bytesPerSample;
  const dataLen = frames * blockAlign;
  const buf = new DataView(new ArrayBuffer(44 + dataLen));
  const w = (off, s) => { for (let i = 0; i < s.length; i++) buf.setUint8(off + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); buf.setUint32(4, 36 + dataLen, true); w(8, 'WAVE');
  w(12, 'fmt '); buf.setUint32(16, 16, true); buf.setUint16(20, 1, true);
  buf.setUint16(22, nCh, true); buf.setUint32(24, sampleRate >>> 0, true);
  buf.setUint32(28, sampleRate * blockAlign, true); buf.setUint16(32, blockAlign, true);
  buf.setUint16(34, bitDepth, true);
  w(36, 'data'); buf.setUint32(40, dataLen, true);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nCh; c++) {
      const src = planar[c];
      let v = src && i < src.length ? src[i] : 0;
      // Symmetric +-32767 scale: avoids the -32768 asymmetry that makes a naive
      // 0x8000/0x7fff encode cost up to 1 LSB of extra error on decode.
      buf.setInt16(o, Math.round(clamp(v, -1, 1) * 32767), true); o += 2;
    }
  }
  return new Uint8Array(buf.buffer);
}

/** Minimal WAV reader so tests can round-trip what we wrote. */
export function decodeWav(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE buffer');
  let o = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (o + 8 <= dv.byteLength) {
    const id = tag(o), size = dv.getUint32(o + 4, true);
    if (id === 'fmt ') fmt = {
      format: dv.getUint16(o + 8, true), channels: dv.getUint16(o + 10, true), sampleRate: dv.getUint32(o + 12, true),
      bits: dv.getUint16(o + 22, true),
    };
    else if (id === 'data') { dataOff = o + 8; dataLen = size; }
    o += 8 + size + (size % 2);
  }
  if (!fmt || dataOff < 0) throw new Error('missing fmt/data');
  const nCh = fmt.channels, frames = Math.floor(dataLen / (nCh * (fmt.bits >> 3)));
  const chs = Array.from({ length: nCh }, () => new Float32Array(frames));
  let p = dataOff;
  for (let i = 0; i < frames; i++) for (let c = 0; c < nCh; c++) { chs[c][i] = dv.getInt16(p, true) / 32767; p += 2; }
  return { channels: chs, sampleRate: fmt.sampleRate, frames, bits: fmt.bits };
}

/* ------------------------------------------------------------------ *
 * Streaming WAV writer (used by the PCM capture tier)                *
 * ------------------------------------------------------------------ */

/**
 * Emits a valid WAV byte stream incrementally so a browser can push 48 kHz
 * stereo to the desktop app without buffering a whole song, and without
 * needing an encoder. Header sizes are patched in the final chunk - which is
 * why `finish()` must always be called.
 *
 * `runningPeak/runningRms` are kept online so the app can meter live and still
 * do a second offline pass for loudness.
 */
export class WavStream {
  constructor(sampleRate = 48000, channels = 2, bitDepth = 16) {
    this.sampleRate = sampleRate; this.channels = channels; this.bitDepth = bitDepth;
    this.frames = 0; this.peak = 0; this.sqSum = 0; this.sampleCount = 0;
    this.gainApplied = 0; this.clipped = 0;
  }
  header() {
    const b = new DataView(new ArrayBuffer(44));
    const w = (o, str) => { for (let i = 0; i < str.length; i++) b.setUint8(o + i, str.charCodeAt(i)); };
    w(0, 'RIFF'); b.setUint32(4, 36, true); w(8, 'WAVE'); w(12, 'fmt ');
    b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, this.channels, true);
    b.setUint32(24, this.sampleRate, true); b.setUint32(28, this.sampleRate * this.channels * 2, true);
    b.setUint16(32, this.channels * 2, true); b.setUint16(34, this.bitDepth, true);
    w(36, 'data'); b.setUint32(40, 0, true);
    return new Uint8Array(b.buffer);
  }
  /** @param {Float32Array[]} planar @returns {Uint8Array} interleaved 16-bit PCM */
  push(planar, gain = 1) {
    const n = Math.max(...planar.map((c) => c.length));
    const out = new Uint8Array(n * this.channels * 2);
    const dv = new DataView(out.buffer);
    const ch = Math.min(this.channels, planar.length);
    let o = 0;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < this.channels; c++) {
        const src = planar[c % ch];
        let v = src && i < src.length ? src[i] * gain : 0;
        const a = Math.abs(v);
        if (a > this.peak) this.peak = a;
        if (a > 1) { this.clipped++; v = v > 0 ? 1 : -1; }
        this.sqSum += v * v; this.sampleCount++;
        dv.setInt16(o, Math.round(clamp(v, -1, 1) * 32767), true);
        o += 2;
      }
    }
    this.frames += n;
    return out;
  }
  /** Final chunk: the patched header, re-emitted as a RIFF size update is not possible
   *  mid-stream, so the app rewrites it from `sizes()`; we still return a trailer-safe view. */
  finish() { return { frames: this.frames, bytes: 44 + this.frames * this.channels * 2, stats: this.stats() }; }
  stats() {
    return {
      frames: this.frames,
      duration_s: round(this.frames / this.sampleRate, 3),
      peak_linear: round(this.peak, 5),
      peak_db: round(gainToDb(this.peak), 2),
      rms_db: round(gainToDb(Math.sqrt(this.sqSum / Math.max(1, this.sampleCount))), 2),
      clipped_samples: this.clipped,
      gain_applied_db: round(gainToDb(this.gainApplied || 1), 2),
    };
  }
}

/* ------------------------------------------------------------------ *
 * Level meter (AnalyserNode time-domain -> UI)                       *
 * ------------------------------------------------------------------ */

export function meterFromTimeDomain(td) {
  const r = rms(td);
  return {
    rms_db: round(gainToDb(r), 1),
    peak_db: round(gainToDb(peakLinear([td])), 1),
    db_per_segment: round(clamp(20 * Math.log10(Math.max(r, 1e-6)), -80, 0), 1),
    clipped: peakLinear([td]) >= 0.999,
  };
}

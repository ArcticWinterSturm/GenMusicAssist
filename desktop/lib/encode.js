/**
 * sunolift / desktop / lib / encode.js
 * ---------------------------------------------------------------------------
 * The offline pass the browser cannot do well: read the take as PCM, undo the
 * page's volume slider sample-accurately using the recorded gain timeline,
 * normalise to a target loudness (ITU-R BS.1770-4), write WAV in pure JS, and
 * only reach for ffmpeg when a lossy container is asked for.
 *
 * Fallback policy matters: a capture tool that silently requires ffmpeg ends up
 * like the exporters that "worked" until a container change and then produced
 * unusable files. Here, if ffmpeg is missing the WAV + full metadata still land
 * on disk and the requested lossy format is reported as skipped, with the reason.
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import {
  decodeWav, encodeWav, measureLoudness, normalizeToLoudness, invertGainInto,
  GainTimeline, peakLinear, round, gainToDb,
} from '../../shared/dsp.js';

export function hasFfmpeg(tools) { return Boolean(tools?.ffmpeg); }

/** Decode any container to planar Float32 @48 kHz. Requires ffmpeg for non-WAV. */
export async function decodeToPcm(file, { ffmpeg } = {}) {
  if (/\.wav$/i.test(file) && existsSync(file)) {
    const w = decodeWav(new Uint8Array(readFileSync(file)));
    return { channels: w.channels, sampleRate: w.sampleRate, via: 'pure-js' };
  }
  if (!ffmpeg) throw new Error(`ffmpeg is required to decode ${/\.(\w+)$/.exec(file)?.[1] || 'this container'}; WAV takes need none`);
  const tmp = join(dirname(file), `.${Date.now()}.pcm`);
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '2', '-ar', '48000', '-y', tmp]);
  const raw = readFileSync(tmp);
  const { unlinkSync } = await import('node:fs');
  try { unlinkSync(tmp); } catch { /* best effort */ }
  const n = Math.floor(raw.length / 4);
  const L = new Float32Array(n), R = new Float32Array(n);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  for (let i = 0, o = 0; i < n; i++) { L[i] = dv.getInt16(o, true) / 32767; R[i] = dv.getInt16(o + 2, true) / 32767; o += 4; }
  return { channels: [L, R], sampleRate: 48000, via: 'ffmpeg' };
}

function run(file, args) {
  return new Promise((res, rej) => {
    const p = spawn(file, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', rej);
    p.on('exit', (c) => (c === 0 ? res(true) : rej(new Error(`${file} exited ${c}: ${err.slice(0, 300)}`))));
  });
}

/**
 * @param {object} p
 * @param {string} p.input        captured file (wav always works; others need ffmpeg)
 * @param {object} p.record       the capture record (needs audio.gain_timeline)
 * @param {number} p.targetLufs
 * @param {boolean} p.invertGain  undo the UI slider (default true)
 */
/**
 * @param {object} o
 * @param {string} o.input      the raw take (webm/opus/noisy wav/raw f32)
 * @param {object} o.record     the library record (gain timeline, clip, listen)
 * @param {string} [o.outDir]   where the normalised WAV goes. Defaults to the
 *                              input's directory, but the autopilot passes
 *                              `<library>/captures` so derivatives stay in the
 *                              library even after the raw take is quarantined —
 *                              output paths must not depend on where a reject
 *                              happened to be moved to.
 */
export async function processTake({ input, record, targetLufs = -14, invertGain = true, ffmpeg = null, outDir = null }) {
  const t0 = Date.now();
  const { channels, sampleRate, via } = await decodeToPcm(input, { ffmpeg });
  const before = measureLoudness(channels, sampleRate);
  const peakBefore = peakLinear(channels);
  const timeline = record?.audio?.gain_timeline?.points?.length ? GainTimeline.fromJSON(record.audio.gain_timeline) : null;

  let gainInfo = { appliedGain: 1, clippedSamples: 0 };
  if (invertGain && timeline) {
    // `invertGainInto` returns a per-run report, so the loop used to overwrite
    // it every channel: the numbers written into the library were the LAST
    // channel's, and a take that clipped only in the left channel reported
    // clippedSamples: 0. Fold across channels instead.
    let applied = 1, clipped = 0, gainSum = 0, gainN = 0;
    for (const ch of channels) {
      const info = invertGainInto(ch, timeline, 0, sampleRate);
      if (info) {
        if (Number.isFinite(info.appliedGain)) { gainSum += info.appliedGain; gainN++; }
        if (Number.isFinite(info.clippedSamples)) clipped += info.clippedSamples;
      }
    }
    applied = gainN ? gainSum / gainN : 1;
    gainInfo = { appliedGain: applied, clippedSamples: clipped, channels: channels.length };
  }

  const afterInvert = invertGain && timeline ? measureLoudness(channels, sampleRate).integratedLufs : before.integratedLufs;
  const norm = normalizeToLoudness(channels, targetLufs, afterInvert, sampleRate);
  const finalLufs = measureLoudness(channels, sampleRate).integratedLufs;

  const base = basename(input).replace(/\.[^.]+$/, '');
  const dir = outDir || dirname(input);
  const outWav = join(dir, `${base}.normalized.wav`);
  writeFileSync(outWav, encodeWav(channels, sampleRate));

  const res = {
    wav: outWav,
    decoded_via: via,
    sample_rate: sampleRate,
    frames: channels[0].length,
    duration_s: round(channels[0].length / sampleRate, 3),
    measured_lufs_before: round(before.integratedLufs, 2),
    measured_lufs_after_gain: round(afterInvert, 2),
    measured_lufs_after: round(finalLufs, 2),
    target_lufs: targetLufs,
    peak_before_db: round(gainToDb(peakBefore), 2),
    peak_after_db: round(gainToDb(peakLinear(channels)), 2),
    applied_gain_db: round(gainToDb(gainInfo.appliedGain), 2),
    gain_normalized_db: round(norm.gain !== 1 ? gainToDb(norm.gain) : 0, 2),
    peak_limited: Boolean(norm.peakLimited),
    unmeasurable: norm.applied === false,
    gain_timeline_points: timeline ? timeline.points.length : 0,
    wav_bytes: statSync(outWav).size,
    ms: Date.now() - t0,
  };
  res.clipping_risk = res.peak_after_db > -0.15;
  return res;
}

/** Container conversion. Returns { ok, file, reason } - never throws for "no ffmpeg". */
export async function convertTo({ source, format = 'm4a', bitrateK = 128, ffmpeg = null, out = null }) {
  if (!existsSync(source)) return { ok: false, reason: `source missing: ${source}` };
  const target = out || source.replace(/\.normalized\.wav$|\.wav$|\.webm$|\.ogg$/, '') + `.${format}`;
  if (!ffmpeg) {
    return { ok: false, reason: 'ffmpeg not found - WAV + metadata written, lossy format skipped', target_skipped: target, wav: source };
  }
  const args = ['-hide_banner', '-loglevel', 'error', '-i', source, '-vn', '-y'];
  if (format === 'm4a' || format === 'mp4') args.push('-c:a', 'aac', '-b:a', `${bitrateK}k`, '-movflags', '+faststart');
  else if (format === 'mp3') args.push('-c:a', 'libmp3lame', '-q:a', '2');
  else if (format === 'opus' || format === 'ogg') args.push('-c:a', 'libopus', '-b:a', `${bitrateK}k`);
  else if (format === 'flac') args.push('-c:a', 'flac', '-compression_level', '8');
  else if (format === 'wav') args.push('-c:a', 'pcm_s16le');
  else return { ok: false, reason: `unsupported format ${format}` };
  args.push(target);
  try {
    await run(ffmpeg, args);
    return { ok: true, file: target, bytes: statSync(target).size };
  } catch (e) {
    return { ok: false, reason: String(e.message || e), target_skipped: target };
  }
}

/**
 * ID3-ish metadata for the lossy formats: WAV gets a LIST/INFO chunk written by
 * hand (no dependency), everything else gets sidecar files (which is what the
 * reference exporter did, and what most players actually read for Suno).
 */
export function writeWavMetadataTag(file, tags) {
  if (!/\.wav$/i.test(file) || !existsSync(file)) return false;
  const buf = readFileSync(file);
  const pairs = Object.entries(tags).filter(([, v]) => v != null && v !== '');
  let body = Buffer.alloc(0);
  for (const [k, v] of pairs) {
    const key = Buffer.alloc(4); key.write(k.slice(0, 4).toUpperCase(), 'ascii');
    const txt = Buffer.from(String(v) + '\0', 'latin1');
    const sz = Buffer.alloc(4); sz.writeUInt32LE(txt.length);
    // RIFF chunks must be word-aligned: an odd payload gets a pad byte that is
    // counted by the parent LIST size but not by the chunk's own size field.
    // Skipping this shifts every following key by one byte (silently corrupt
    // tags - exactly the class of bug that makes sidecar data untrustworthy).
    const pad = txt.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
    body = Buffer.concat([body, key, sz, txt, pad]);
  }
  const chunkId = Buffer.from('LIST', 'ascii');
  const listType = Buffer.from('INFO', 'ascii');
  const size = Buffer.alloc(4); size.writeUInt32LE(4 + body.length);
  const out = Buffer.concat([buf, chunkId, size, listType, body]);
  // grow the RIFF size field
  out.writeUInt32LE(out.length - 8, 4);
  writeFileSync(file, out);
  return true;
}

/** Read back a LIST/INFO chunk to prove the tag is actually there. */
export function readWavMetadataTag(file) {
  if (!existsSync(file)) return null;
  const b = readFileSync(file);
  const i = b.indexOf('LIST');
  if (i < 0 || b.slice(i + 8, i + 12).toString('ascii') !== 'INFO') return null;
  const size = b.readUInt32LE(i + 4);
  const end = Math.min(b.length, i + 8 + size);
  const out = {};
  let o = i + 12;
  while (o + 8 <= end) {
    const key = b.slice(o, o + 4).toString('ascii');
    const len = b.readUInt32LE(o + 4);
    out[key] = b.slice(o + 8, o + 8 + len).toString('latin1').replace(/\0+$/, '');
    o += 8 + len + (len % 2);
  }
  return out;
}

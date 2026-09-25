/**
 * sunolift / desktop / server.js
 * ===========================================================================
 * The local sidecar. Two jobs:
 *   1. receive takes from the extension (webm or raw PCM), do the offline
 *      volume-inversion + loudness normalisation, write audio + sidecars
 *   2. be the capture engine when the browser cannot be: OS loopback ("reflect")
 *
 * No dependencies on purpose: this has to run on a machine where the user has
 * just installed nothing, at 1 a.m., during a generation binge.
 *
 * Listens on 127.0.0.1 only. CORS is `*` because the client is either an
 * extension service worker or the user's own browser tab on localhost.
 */
import { createServer } from 'node:http';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { Library } from './lib/library.js';
import { processTake, convertTo, writeWavMetadataTag, readWavMetadataTag } from './lib/encode.js';
import { probe, ReflectCapture } from './lib/reflect.js';
import { Autopilot, loadConfig, saveConfig, keepsFolder } from './lib/autopilot.js';
import { encodeWav, measureLoudness, round, peakLinear } from '../shared/dsp.js';
import { makeCaptureRecord, triageScore, SCHEMA_VERSION } from '../shared/metadata.js';
import { API_PROD, parseDownloadQuota } from '../shared/suno-api.js';

export const VERSION = '1.0.5';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.wav': 'audio/wav', '.webm': 'audio/webm', '.txt': 'text/plain; charset=utf-8', '.cue': 'text/plain; charset=utf-8', '.png': 'image/png' };

export async function createApp({ root, port = 8787, host = '127.0.0.1', quiet = false, autopilot = true } = {}) {
  const lib = new Library(root);
  const tools = (await probe().catch(() => ({ tools: {}, can_capture: false })));
  const log = (...a) => { if (!quiet) console.log('[sunolift]', ...a); };
  const events = [];                                  // ring buffer for /autopilot
  const pilot = new Autopilot({
    root: lib.root, tools, log,
    onEvent: (e) => { events.unshift({ ...e, at: e.at || new Date().toISOString() }); if (events.length > 200) events.pop(); },
  });

  const pcm = new Map();     // captureId -> { stream, path, seq:Set, bytes, hash, started, chans, rate }
  let reflect = null;        // active ReflectCapture
  const started = Date.now();

  /* ---------------- helpers ---------------- */
  const json = (res, code, obj) => { const b = Buffer.from(JSON.stringify(obj)); res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'content-length': b.length }); res.end(b); };
  const bytes = (res, code, buf, type = 'application/octet-stream') => { res.writeHead(code, { 'content-type': type, 'access-control-allow-origin': '*', 'content-length': buf.length }); res.end(buf); };
  const readBody = (req, limit = 64 << 20) => new Promise((res, rej) => {
    const parts = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { rej(new Error('body too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => res(Buffer.concat(parts)));
    req.on('error', rej);
  });
  const readJson = async (req) => { const b = await readBody(req); if (!b.length) return {}; try { return JSON.parse(b.toString('utf8')); } catch (e) { throw Object.assign(new Error('invalid JSON body'), { cause: e }); } };

  /**
   * MediaRecorder muxes WebM live, sequentially — no Duration element, no Cues
   * (seek index), every cluster sized "unknown". The file is a live stream in a
   * file container: Chrome's <audio> plays it fine, but VLC and ffprobe see
   * duration=0 and seeking is impossible. ffmpeg exit 3199971767
   * ("EBML header parsing failed") on every one of these.
   *
   * Fix: stream-copy remux through ffmpeg, which writes a real Duration, Cues,
   * and closes cluster sizes. No re-encode, no quality loss, ~1 s for a 4 MB file.
   *
   * Failure is non-fatal — the original file stays on disk (still playable in
   * Chrome), and we return so the capture isn't blocked by a fix that can only
   * help.
   */
  async function remuxWebm(file) {
    if (!/\.webm$/i.test(file)) return;
    if (!tools.tools.ffmpeg) return;
    const tmp = `${file}.remuxing.webm`;
    try {
      await new Promise((res, rej) => {
        const p = spawn(tools.tools.ffmpeg, ['-y', '-v', 'error', '-i', file, '-c', 'copy', tmp]);
        let err = '';
        p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
        p.on('error', rej);
        p.on('exit', (c) => c === 0 ? res() : rej(new Error(`ffmpeg remux exit ${c}: ${err}`)));
      });
      renameSync(tmp, file);
      log('remuxed webm:', file);
    } catch (e) {
      log('remux failed (keeping original):', e.message);
      try { unlinkSync(tmp); } catch { /* best effort */ }
    }
  }

  async function sunoFetch(path, { method = 'GET', body } = {}) {
    const cookie = lib.cookieHeader();
    if (!cookie) throw Object.assign(new Error('no session: click "Extract session" in the extension, or set SUNO_COOKIE'), { status: 412 });
    const r = await fetch(API_PROD + path, {
      method,
      headers: {
        cookie, origin: 'https://suno.com', referer: 'https://suno.com/', accept: 'application/json',
        'content-type': 'application/json', 'device-id': lib.loadSession()?.device_id || 'sunolift',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { __raw: text.slice(0, 300) }; }
    if (!r.ok) throw Object.assign(new Error(`suno ${r.status} on ${path}`), { status: r.status, data });
    return data;
  }

  /* ---------------- routes ---------------- */
  const routes = {
    'GET /ping': async () => ({
      ok: true, version: VERSION, app: 'sunolift', uptime_s: Math.round((Date.now() - started) / 1000),
      root: lib.root, ffmpeg: Boolean(tools.tools.ffmpeg), backends: tools.backends || [],
      can_reflect: Boolean(tools.can_capture), reflect_active: Boolean(reflect),
      stats: lib.stats(),
    }),

    'GET /library': async () => ({ records: lib.all().slice(-200).reverse(), clips: lib.byClip(), stats: lib.stats() }),

    'GET /export.csv': async () => {
      const { path } = lib.exportCsv();
      return bytes200(path, 'text/csv; charset=utf-8');
    },

    'POST /capture/meta': async (req, res) => {
      const meta = await readJson(req);
      if (!meta?.captureId) return json(res, 400, { ok: false, error: 'captureId required' });
      const p = pcm.get(meta.captureId);
      if (p) p.meta = meta; else pcm.set(meta.captureId, { meta, pending: true });
      return json(res, 200, { ok: true, capture_id: meta.captureId, note: p ? 'merged with live pcm stream' : 'awaiting audio' });
    },

    /** whole take as an encoded blob (webm/ogg/mp4) - the browser-only path */
    'POST /capture/audio': async (req, res, q) => {
      const id = q.get('capture_id') || q.get('captureId');
      if (!id) return json(res, 400, { ok: false, error: 'capture_id required' });
      const buf = await readBody(req);
      const ext = (q.get('mime') || '').includes('mp4') ? 'mp4' : (q.get('mime') || '').includes('ogg') ? 'ogg' : 'webm';
      const file = lib.audioPath(id, ext);
      writeFileSync(file, buf);
      const hash = createHash('sha256').update(buf).digest('hex').slice(0, 32);
      const entry = pcm.get(id) || {};
      entry.file = file; entry.bytes = buf.length; entry.hash = hash; entry.ext = ext;
      pcm.set(id, entry);
      // MediaRecorder produces a "live" WebM — no Duration, no Cues — that breaks
      // VLC/ffprobe. Remux asynchronously so the extension gets its ACK without
      // waiting for ffmpeg; on failure the original stays on disk still playable.
      if (ext === 'webm') remuxWebm(file).catch(() => {});
      return json(res, 200, { ok: true, file, bytes: buf.length, sha256: hash });
    },

    /** raw PCM from the worklet: append with sequence numbers so loss is visible */
    'POST /capture/pcm': async (req, res, q) => {
      const id = q.get('capture_id');
      if (!id) return json(res, 400, { ok: false, error: 'capture_id required' });
      const seq = Number(q.get('seq') || 0);
      // The worklet streams Float32 (no pre-quantisation before the offline gain
      // pass, which is what keeps a low-slider take recoverable); s16le is
      // supported too because that is what the OS loopback backends hand us.
      const fmt = (q.get('fmt') || 'f32le').toLowerCase();
      if (!['f32le', 's16le'].includes(fmt)) return json(res, 400, { ok: false, error: `unsupported fmt ${fmt}` });
      let s = pcm.get(id);
      if (!s) {
        const chans = Math.max(1, Number(q.get('channels') || 2));
        const rate = Math.max(8000, Number(q.get('rate') || 48000));
        const file = lib.pathFor(id, 'raw');
        s = { file, stream: createWriteStream(file), seqs: new Set(), bytes: 0, chans, rate, fmt, started: Date.now(), gaps: 0 };
        pcm.set(id, s);
      } else if (s.fmt !== fmt) {
        return json(res, 409, { ok: false, error: `stream already open as ${s.fmt}, cannot mix in ${fmt}` });
      }
      if (s.lastSeq !== undefined && seq !== s.lastSeq + 1) s.gaps++;
      s.lastSeq = seq;
      s.seqs.add(seq);
      const buf = await readBody(req);
      s.bytes += buf.length;
      s.hasher = (s.hasher || createHash('sha256')).update(buf);
      s.stream.write(buf);
      return json(res, 200, { ok: true, received: s.bytes, seq, gaps: s.gaps });
    },

    'POST /capture/pcm-end': async (req, res, q) => {
      const id = q.get('capture_id');
      const s = pcm.get(id);
      if (!s) return json(res, 404, { ok: false, error: 'no such live stream' });
      const meta = (await readJson(req).catch(() => ({}))) || {};
      await new Promise((r) => { if (s.stream.writableEnded) { r(); return; } s.stream.end(r); });
      const pcmFile = s.file;
      const wavFile = lib.pathFor(id, 'wav');
      // Reconstruct the planar float arrays from whatever wire format the
      // producer used, then hand them to the pure-JS WAV writer.
      // `let`, not `const`: the tail-padding path below reassigns this. It was
      // a const, so ANY take whose byte count was not a whole number of frames
      // (a worklet flush mid-quantum, a truncated s16le block from a loopback
      // tool) threw "Assignment to constant variable" inside the route handler
      // and the take was lost — with the file already half-written.
      let raw = readFileSync(pcmFile);
      const bytesPer = s.fmt === 'f32le' ? 4 : 2;
      const frameBytes = bytesPer * s.chans;
      const n = Math.floor(raw.length / frameBytes);
      // A take with no frames is a FAILURE (suspended context / blocked
      // worklet), not a song. Writing a 44-byte header-only WAV used to
      // masquerade as a successful capture and polluted the library. Refuse.
      if (n < 4800) {  // < 0.1 s at any sane rate
        // WriteStream has no close(); destroy() is the one that actually
        // releases the fd, and without it the raw file stayed locked on Windows
        // and the unlink below silently failed.
        try { s.stream.destroy(); } catch { /* already gone */ }
        try { unlinkSync(pcmFile); } catch { /* ok */ }
        pcm.delete(id);
        return json(res, 422, {
          ok: false, error: `PCM stream held ${n} frames (${raw.length} bytes) — the AudioWorklet delivered no audio. Likely a suspended AudioContext; press play on the player once, then retry.`,
          frames: n, bytes: raw.length,
        });
      }
      const trailing = raw.length % frameBytes;
      if (trailing) {
        // Zero-pad the final partial frame. Allocating `frameBytes` extra (not
        // a whole frame's worth of trailing) keeps the sample count at exactly
        // `n` frames — the same `n` the planar read below iterates.
        const padded = Buffer.alloc(n * frameBytes + frameBytes);
        raw.copy(padded, 0);
        raw = padded;
      }
      const planar = Array.from({ length: s.chans }, () => new Float32Array(n));
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      for (let i = 0, o = 0; i < n; i++) for (let c = 0; c < s.chans; c++) {
        planar[c][i] = s.fmt === 'f32le' ? dv.getFloat32(o, true) : dv.getInt16(o, true) / 32767;
        o += bytesPer;
      }
      writeFileSync(wavFile, encodeWav(planar, s.rate));
      const loud = measureLoudness(planar, s.rate);
      const rec = buildRecord(id, { ...meta }, {
        bytes: statSync(wavFile).size, mime: 'audio/wav', container: 'wav', codec: 'pcm',
        sample_rate: s.rate, channels: s.chans, duration_s: n / s.rate,
        measured_lufs_before: loud.integratedLufs, peak_before_db: round(20 * Math.log10(peakLinear(planar) || 1e-6), 2),
        source: meta.source || 'webaudio-pcm-worklet', gaps: s.gaps, sha256: s.hasher?.digest('hex').slice(0, 32),
        ui_gain: meta.ui_gain ?? null, gain_timeline: meta.gain_timeline || null,
      });
      const saved = lib.save(rec);
      // Release the stream slot. Without this the map grew for the life of the
      // process and a later take reusing the id inherited a dead stream handle.
      pcm.delete(id);
      kickAutopilot(saved.capture_id);
      log(`pcm take finalised: ${id} ${n} frames, ${s.gaps} gap(s), ${loud.integratedLufs.toFixed(2)} LUFS`);
      return json(res, 200, { ok: true, capture: saved, wav: wavFile, frames: n, pcm_gaps: s.gaps });
    },

    /** finalize a take that arrived via /capture/audio (encoded blob path) */
    'POST /capture/finalize': async (req, res) => {
      const body = await readJson(req);
      const id = body.capture_id || body.captureId;
      const s = pcm.get(id) || {};
      // /capture/meta may contain richer canonical metadata than the final
      // transport message. Merge it, but let explicit final fields win.
      const stored = s.meta || {};
      const incoming = body.meta || body;
      const merged = { ...stored, ...incoming, clip: incoming.clip || stored.clip || null };
      const rec = buildRecord(id, merged, {
        bytes: body.bytes || s.bytes || 0, mime: body.mime || 'audio/webm;codecs=opus',
        container: s.ext || 'webm', codec: 'opus', sample_rate: body.sample_rate || 48000, channels: 2,
        duration_s: (body.durationMs || 0) / 1000 || 0,
        ui_gain: body.ui_gain ?? null, gain_timeline: body.gain_timeline || null,
        source: 'webaudio-tap',
      });
      if (s.file) rec.files = { ...(rec.files || {}), audio_inbox: s.file };
      const saved = lib.save(rec);
      pcm.delete(id);
      kickAutopilot(saved.capture_id);
      return json(res, 200, { ok: true, capture: saved, path: lib.pathFor(id, saved.audio.container) });
    },

    /** the offline pass: invert the slider, normalise, write WAV (+ optional format) */
    'POST /capture/process': async (req, res) => {
      const { capture_id, target_lufs = -14, invert_gain = true, formats = [] } = await readJson(req);
      const rec = lib.all().find((r) => r.capture_id === capture_id);
      if (!rec) return json(res, 404, { ok: false, error: 'unknown capture_id' });
      const input = rec.files?.audio || lib.audioPath(capture_id, rec.audio?.container || 'webm');
      if (!existsSync(input)) {
        // Say what is actually true. The old hint ("the take stayed in the
        // browser") blamed the extension for every cause, including a take that
        // the autopilot had quarantined or a record whose path is simply stale.
        const known = rec.files || {};
        const elsewhere = Object.entries(known).find(([, p]) => typeof p === 'string' && p !== input && existsSync(p));
        if (elsewhere) {
          return json(res, 409, {
            ok: false,
            error: `audio file not on disk: ${input}`,
            found_at: elsewhere[1],
            hint: `the take is at ${elsewhere[0]} (${elsewhere[1]}); re-run to process that copy`,
          });
        }
        return json(res, 409, { ok: false, error: `audio file not on disk: ${input}`, hint: 'the take stayed in the browser: enable "also save a copy via Chrome downloads" in the extension settings' });
      }
      let out;
      try { out = await processTake({ input, record: rec, targetLufs: target_lufs, invertGain: invert_gain, ffmpeg: tools.tools.ffmpeg }); }
      catch (e) { return json(res, 500, { ok: false, error: String(e.message || e), input }); }
      const tag = { INAM: rec.song?.title || 'Untitled', TITL: rec.song?.title || 'Untitled', IART: 'Suno AI', IGNR: (rec.song?.style_tags || '').slice(0, 60), ICMT: `suno clip ${rec.clip_id}; heard ${round(rec.listen_state?.accrued_seconds || 0, 1)}s; coverage ${Math.round((rec.listen_state?.coverage || 0) * 100)}%; captured with sunolift`, ICOP: 'Suno AI (personal use)', ICRD: (rec.song?.created_at || '').slice(0, 10) };
      writeWavMetadataTag(out.wav, tag);
      const convs = [];
      for (const f of formats) convs.push({ format: f, ...(await convertTo({ source: out.wav, format: f, ffmpeg: tools.tools.ffmpeg })) });
      const updated = lib.update(capture_id, {
        audio: {
          ...rec.audio, normalized_wav: out.wav, bytes_normalized: out.wav_bytes,
          measured_lufs_before: out.measured_lufs_before, measured_lufs_after: out.measured_lufs_after,
          applied_gain_db: out.applied_gain_db, gain_normalized_db: out.gain_normalized_db,
          peak_after_db: out.peak_after_db, peak_limited: out.peak_limited, duration_s: out.duration_s,
        },
        processing: out, conversions: convs,
      });
      return json(res, 200, { ok: true, result: out, conversions: convs, wav_tags: readWavMetadataTag(out.wav), capture: updated });
    },

    'POST /triage': async (req, res) => {
      const { capture_id, verdict, note } = await readJson(req);
      if (!capture_id) return json(res, 400, { ok: false, error: 'capture_id required' });
      if (verdict && !['keep', 'maybe', 'discard', 'recapture', 'skip-unheard'].includes(verdict)) {
        return json(res, 400, { ok: false, error: `unknown verdict "${verdict}"`, allowed: ['keep', 'maybe', 'discard', 'recapture', 'skip-unheard'] });
      }
      // A human verdict is DATA, not a scratch field. The old route wrote
      // `curation_patch` onto the record and let lib.update() recompute
      // `curation` from the listen state, which immediately discarded the
      // verdict — so Keep/Drop in the review UI silently did nothing.
      const rec = lib.setVerdict(capture_id, { verdict, note, source: 'human' });
      if (!rec) return json(res, 404, { ok: false, error: 'unknown capture_id' });
      return json(res, 200, { ok: true, capture_id, verdict: rec.curation?.verdict, score: rec.curation?.score, clips: lib.byClip().slice(0, 12) });
    },

    'POST /journal': async (req, res) => {
      const { events } = await readJson(req);
      const list = Array.isArray(events) ? events : [events];
      for (const e of list) if (e) lib.journalAppend(e);
      return json(res, 200, { ok: true, appended: list.length, total: lib.journalEvents(100000).length });
    },

    'GET /journal': async () => jsonify(lib.journalEvents(2000)),

    'POST /session': async (req, res) => {
      const s = await readJson(req);
      if (!Array.isArray(s.cookies) || !s.cookies.length) return json(res, 400, { ok: false, error: 'cookies[] required' });
      const r = lib.saveSession({ cookies: s.cookies, device_id: s.device_id, at: s.at });
      log(`session accepted (${r.cookies} cookies) -> ${r.path}`);
      return json(res, 200, { ok: true, ...r });
    },

    'GET /quota': async () => {
      try { return jsonify(parseDownloadQuota(await sunoFetch('/api/billing/info/'))); }
      catch (e) { return { ok: false, error: String(e.message || e), status: e.status }; }
    },

    'GET /structure': async (req, res, q) => {
      const id = q.get('clip_id');
      if (!id) return json(res, 400, { ok: false, error: 'clip_id required' });
      const out = { clip_id: id };
      const grab = async (name, path, fn = (x) => x) => { try { out[name] = fn(await sunoFetch(path)); } catch (e) { out[name] = { error: String(e.message || e), status: e.status }; } };
      await Promise.all([
        grab('waveform', `/api/gen/${id}/waveform-aggregates`),
        grab('sections', `/api/gen/${id}/novelty-sections`),
        grab('downbeats', `/api/gen/${id}/downbeats`),
        grab('lyrics', `/api/gen/${id}/aligned_lyrics/v2/`),
        grab('clip', `/api/clip/${id}`),
      ]);
      return jsonify(out);
    },

    /** official exports; the m4a zip path does not consume Suno quota */
    'POST /export/official': async (req, res) => {
      const { clip_ids = [], format = 'm4a', force = false } = await readJson(req);
      if (!clip_ids.length) return json(res, 400, { ok: false, error: 'clip_ids[] required' });
      if (format !== 'm4a' && !force) return json(res, 402, { ok: false, error: `${format} consumes Suno download credits; pass force:true after showing the user the remaining quota`, costs_quota: true });
      const r = await sunoFetch('/api/download/clips/zip/prepare', { method: 'POST', body: { clip_ids: clip_ids.slice(0, 200), workspace_name: null, format } });
      const url = r?.download_url;
      if (!url) return json(res, 502, { ok: false, error: 'no download_url from Suno', raw: r });
      const dest = join(lib.root, 'exports', `suno-${format}-${Date.now()}.zip`);
      mkdirSync(join(lib.root, 'exports'), { recursive: true });
      const f = await fetch(url);
      if (!f.ok) return json(res, 502, { ok: false, error: `download failed ${f.status}` });
      writeFileSync(dest, Buffer.from(await f.arrayBuffer()));
      return json(res, 200, { ok: true, file: dest, bytes: statSync(dest).size, format, clips: clip_ids.length, failed: r.failed_clips || [] });
    },

    /* ---------------- reflect (OS loopback) ---------------- */
    'GET /reflect/status': async () => ({
      active: Boolean(reflect), info: { backends: tools.backends, can_capture: tools.can_capture, devices: tools.devices, auto_device: tools.auto_device, ffmpeg_version: tools.ffmpeg_version },
      ...(reflect ? { started_at: reflect.meta?.started_at, seconds: reflect.meta ? (Date.now() - reflect.startedAt) / 1000 : null, file: reflect.outFile, notes: reflect.meta?.notes } : {}),
    }),

    'POST /reflect/start': async (req, res) => {
      if (reflect) return json(res, 409, { ok: false, error: 'a reflect capture is already running', file: reflect.outFile });
      if (!tools.can_capture) return json(res, 503, { ok: false, error: 'no loopback backend: install ffmpeg (or sox / pipewire)', probed: Object.keys(tools.tools) });
      const { capture_id, max_seconds = 0, device = null, out_file = null } = await readJson(req);
      const file = out_file || lib.pathFor(capture_id || `reflect-${Date.now()}`, 'wav');
      reflect = new ReflectCapture({ outFile: file, maxSeconds: Number(max_seconds) || 0, device: device || null });
      try {
        const r = await reflect.start();
        log('reflect started', r.backend, r.device, file);
        return json(res, 200, { ok: true, ...r, capture_id });
      } catch (e) {
        reflect = null;
        return json(res, 500, { ok: false, error: String(e.message || e) });
      }
    },

    'POST /reflect/stop': async (req, res) => {
      if (!reflect) return json(res, 409, { ok: false, error: 'not capturing' });
      const current = reflect;                  // the capture THIS request stops
      const r = await current.stop();
      const file = current.outFile;
      const meta = current.meta;
      // Read the diagnostics BEFORE dropping the reference: the "no file" branch
      // is precisely the one that needs ffmpeg's stderr, and it used to run
      // after `reflect = null`, so the report was always an empty string.
      const stderr = String(current.stderr || '').slice(-600);
      // Only clear the slot if it is still the capture we stopped: a /reflect/start
      // that landed while stop() was awaiting must not be silently discarded.
      if (reflect === current) reflect = null;
      if (!existsSync(file)) return json(res, 500, { ok: false, error: 'backend produced no file', meta, stderr });
      let proc = null;
      try { proc = await processTake({ input: file, record: {}, targetLufs: -14, invertGain: false, ffmpeg: tools.tools.ffmpeg }); }
      catch (e) { return json(res, 200, { ok: true, file, meta, process_error: String(e.message || e) }); }
      const id = `reflect-${Date.now().toString(36)}`;
      const rec = buildRecord(id, { reflect: meta }, {
        bytes: statSync(proc.wav).size, mime: 'audio/wav', container: 'wav', codec: 'pcm',
        sample_rate: proc.sample_rate, channels: 2, duration_s: proc.duration_s,
        measured_lufs_before: proc.measured_lufs_before, measured_lufs_after: proc.measured_lufs_after,
        source: `reflect:${meta.backend}`, usable: proc.duration_s > 0.5,
      });
      rec.song = { ...(rec.song || {}), title: 'OS loopback reflect take' };
      rec.reflect = meta;
      const saved = lib.save({ ...rec, files: { ...(rec.files || {}), audio: proc.wav } });
      return json(res, 200, { ok: true, file: proc.wav, meta, processing: proc, capture: saved });
    },

    /** mirror a browser-side reflect run so a tab-only capture still ends up here */
    'POST /reflect/from-browser': async (req, res) => {
      const { capture_id, reason = 'browser-blocked' } = await readJson(req);
      if (!tools.can_capture) return json(res, 503, { ok: false, error: 'no loopback backend available' });
      return json(res, 200, { ok: true, capture_id, reason, hint: 'call POST /reflect/start with {capture_id} to begin the loopback take', backends: tools.backends });
    },

    'GET /files': async (req, res, q) => {
      const p = q.get('path') || '';
      const abs = resolve(lib.root, p);
      const base = resolve(lib.root);
      // `startsWith(base)` alone accepts "/root-evil" for root "/root" and is
      // case-sensitive where the filesystem is not. Compare on a separator.
      const inside = abs === base || abs.startsWith(base + sep);
      if (!inside) return json(res, 403, { ok: false, error: 'path outside library root', root: base });
      if (!existsSync(abs)) return json(res, 404, { ok: false, error: 'not found' });
      const st = statSync(abs);
      if (st.isDirectory()) return json(res, 200, { ok: true, entries: readdirSync(abs).slice(0, 500) });
      return bytes(res, 200, readFileSync(abs), MIME[extname(abs).toLowerCase()] || 'application/octet-stream');
    },

    /* ---------------- autopilot: the unattended pipeline ---------------- */
    'GET /autopilot': async () => ({ ok: true, ...pilot.status(), events: events.slice(0, 40), keeps_folder: keepsFolder(lib.root) }),

    'POST /autopilot/start': async (req, res) => {
      const body = await readJson(req).catch(() => ({}));
      pilot.cfg = saveConfig(lib.root, { enabled: true, ...(body.config || {}) });
      return json(res, 200, { ok: true, ...pilot.start() });
    },

    'POST /autopilot/stop': async () => ({ ok: true, ...pilot.stop() }),

    'POST /autopilot/config': async (req, res) => {
      const body = await readJson(req).catch(() => ({}));
      pilot.cfg = saveConfig(lib.root, body || {});
      return json(res, 200, { ok: true, config: pilot.cfg });
    },

    /** One synchronous pass — the "do it now" button, and what `sunolift auto --once` calls. */
    'POST /autopilot/once': async () => ({ ok: true, result: await pilot.runOnce(), status: pilot.status() }),

    'POST /autopilot/official': async (req, res) => {
      const body = await readJson(req).catch(() => ({}));
      return json(res, 200, await pilot.downloadOfficial({ force: Boolean(body.force) }));
    },

    'GET /autopilot/report': async () => {
      const p = join(lib.root, 'SESSION.md');
      return { ok: true, exists: existsSync(p), report: existsSync(p) ? readFileSync(p, 'utf8') : null };
    },

    'POST /autopilot/report': async () => pilot._writeSessionReport(),

    'GET /sidecars': async (req, res, q) => {
      const id = q.get('capture_id');
      const out = {};
      for (const ext of ['txt', 'cue', 'json']) {
        const p = lib.pathFor(id, ext);
        out[ext] = existsSync(p) ? readFileSync(p, 'utf8') : null;
      }
      return out;
    },
  };

  /**
   * Nudge the pipeline for one capture without making the extension wait for a
   * full pass. This is what makes the tool feel automatic: the take is
   * normalised, ranked and filed before the next song finishes.
   */
  function kickAutopilot(captureId) {
    if (!pilot.running) return;
    setTimeout(() => {
      pilot.runOnce().catch((e) => log('autopilot kick failed', captureId, e.message));
    }, 50);
  }

  const jsonify = (obj) => obj;
  function bytes200(path, type) { return { __raw: true, file: path, type }; }

  function buildRecord(captureId, meta, audio) {
    // Accept both tap metadata and an already-canonical capture record. The
    // extension posts the canonical record to /capture/meta before the audio;
    // older code ignored it during /capture/finalize and rebuilt the sidecar
    // from a null `clip`, erasing metadata that had already been recovered.
    const song = meta.song || {};
    const media = meta.media || {};
    const id = meta.clip?.id || meta.clipId || meta.clip_id || song.id || null;
    const clip = meta.clip || {
      id,
      title: meta.title || song.title || null,
      duration_s: song.duration_s || audio.duration_s || null,
      model_name: song.model_name || null,
      major_model_version: song.major_model_version || null,
      created_at: song.created_at || null,
      image_url: song.image_url || null,
      explicit: song.explicit ?? false,
      is_download_unlocked: song.is_download_unlocked ?? null,
      audio_url: media.audio_url || null,
      media_urls: media.media_urls || [],
      metadata: {
        duration: song.duration_s || audio.duration_s || null,
        tags: song.style_tags || null,
        gpt_description_prompt: song.style_prompt || null,
        prompt: song.lyrics || null,
        make_instrumental: song.instrumentals ?? false,
      },
    };
    const rec = makeCaptureRecord({
      clip, session: { capture_id: captureId },
      listen: meta.listen || meta.listen_state || null,
      audio: { ...audio, target_lufs: meta.target_lufs ?? -14, correction_mode: meta.correction || 'live', cdn_expiry: meta.cdn_expiry || null },
      cues: meta.cues || [], origin: 'desktop', sunoTelemetry: meta.suno_telemetry || null,
    });
    rec.curation = triageScore(rec);
    rec.app = { version: VERSION, schema: SCHEMA_VERSION, processed_at: new Date().toISOString() };
    return rec;
  }

  /* ---------------- the server ---------------- */
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const key = `${req.method} ${u.pathname}`;
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' });
        return res.end();
      }
      if (u.pathname === '/' || u.pathname === '/index.html') {
        const f = join(import.meta.dirname, 'ui', 'index.html');
        return existsSync(f) ? bytes(res, 200, readFileSync(f), 'text/html; charset=utf-8') : bytes(res, 200, Buffer.from('<h1>sunolift</h1><p>ui/index.html missing</p>'), 'text/html');
      }
      const h = routes[key];
      if (!h) return json(res, 404, { ok: false, error: `no route ${key}`, routes: Object.keys(routes) });
      const r = await h(req, res, u.searchParams);
      if (r && r.__raw) return bytes(res, 200, readFileSync(r.file), r.type);
      if (r !== undefined && !res.headersSent) json(res, 200, r);
    } catch (e) {
      log('error', key, e.message);
      if (!res.headersSent) json(res, e.status || 500, { ok: false, error: String(e.message || e), route: key });
    }
  });

  if (autopilot && loadConfig(lib.root).enabled) pilot.start();

  /**
   * Shutting the HTTP server down must shut the autopilot down with it.
   * The engine holds a poll timer; left running it keeps the Node process
   * alive forever (every test file that boots a sidecar hung on exit, and so
   * does Ctrl-C in the CLI). One owner, one teardown path.
   */
  const close = async () => {
    try { pilot.stop(); } catch { /* never started */ }
    await new Promise((resolve) => {
      if (!server.listening) { resolve(); return; }
      server.close(() => resolve());
      // keep-alive sockets from the extension would otherwise hold the close open
      setImmediate(() => { if (typeof server.closeAllConnections === 'function') server.closeAllConnections(); });
    });
  };
  server.on('close', () => { try { pilot.stop(); } catch { /* never started */ } });

  return { server, lib, tools, pilot, routes: Object.keys(routes), port, host, close };
}

export async function serve(opts = {}) {
  const app = await createApp(opts);
  app.server.listen(opts.port || 8787, opts.host || '127.0.0.1');
  await once(app.server, 'listening');
  const a = app.server.address();
  console.log(`sunolift sidecar  http://${a.address}:${a.port}   root: ${app.lib.root}`);
  console.log(`  capture backends: ${app.tools.backends?.join(', ') || 'none (in-browser capture still works)'}`);
  console.log(`  ffmpeg: ${app.tools.tools.ffmpeg ? app.tools.ffmpeg_version : 'not found (WAV + metadata only, no m4a/mp3 transcode)'}`);
  console.log(`  loopback device: ${app.tools.auto_device || 'not detected'}`);
  return app;
}

/* ------------------------------------------------------------------ *
 * direct entry point                                                 *
 * ------------------------------------------------------------------ */
/**
 * `node desktop/server.js serve [--port 8787] [--root DIR] [--quiet]`
 *
 * The launchers ("Please start.py", SunoLift.bat) start the sidecar this way.
 * Without an entry point the module loaded, found nothing to do, and exited —
 * the launcher then waited ten seconds for /ping and reported "did not answer
 * within 10 s", which every reader blamed on the capture side.
 */
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (name, fallback = null) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
  };
  const root = arg('--root') || process.env.SUNOLIFT_ROOT || process.env.GENMUSICASSIST_ROOT || undefined;
  const port = Number(arg('--port', process.env.SUNOLIFT_PORT || 8787)) || 8787;
  const host = arg('--host') || process.env.SUNOLIFT_HOST || '127.0.0.1';
  const autopilot = !argv.includes('--no-autopilot');
  const app = await serve({ root, port, host, quiet: argv.includes('--quiet'), autopilot });
  const a = app.pilot.status();
  console.log(`  autopilot: ${a.running ? `running every ${a.config.poll_ms} ms` : 'off (autopilot.json)'}`);
  console.log(`  keeps:     ${keepsFolder(app.lib.root)}`);
  const bye = async () => { console.log('\n[sunolift] shutting down…'); await app.close(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

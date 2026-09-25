/**
 * sunolift / desktop / lib / autopilot.js
 * ===========================================================================
 * The piece that turns "a capture tool you have to drive" into a tool that
 * curates a session by itself.
 *
 * The problem it solves, in the user's words: hundreds of generations, you want
 * the two or three that are not garbage, and you do not want to click through
 * them. So the pipeline has to run with nobody watching:
 *
 *   capture lands  ->  is it even audio?  ->  undo the volume slider
 *                  ->  loudness-normalise ->  tag it  ->  transcode
 *                  ->  score it against how much you actually LISTENED
 *                  ->  keep / maybe / discard  ->  playlist  ->  report
 *
 * What it deliberately does NOT do
 *  - It never deletes anything. "discard" is a rank, not an `rm`. Takes move to
 *    `quarantine/` at worst, and the JSONL record survives either way.
 *  - It never overrides a verdict a human recorded (`curation.verdict_locked`).
 *  - It never spends Suno download quota. The only Suno call it can make is the
 *    M4A zip path (their own UI default, documented as quota-free) and only
 *    when a session has been handed over.
 *
 * Everything is derived from files under the library root, so the result is
 * inspectable with `ls`, `grep` and `jq` — the whole point of the JSONL store.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, copyFileSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { join, basename, extname, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { once } from 'node:events';

import { Library } from './library.js';
import { processTake, convertTo, writeWavMetadataTag, decodeToPcm } from './encode.js';
import { measureLoudness, peakLinear, gainToDb, round, decodeWav } from '../../shared/dsp.js';
import { triageScore } from '../../shared/metadata.js';
import { API_PROD, parseDownloadQuota } from '../../shared/suno-api.js';

export const AUTOPILOT_VERSION = '1.0.0';
export const CONFIG_FILE = 'autopilot.json';

export const DEFAULT_CONFIG = {
  enabled: true,
  /** Absolute loudness target for the normalised archive copy. */
  target_lufs: -14,
  /** Lossy copies to produce next to the WAV. Empty = WAV only (always safe). */
  formats: ['m4a'],
  /** Score at or above which a take is promoted to `keep`. */
  keep_score: 55,
  /** Score below which an unheard take is ranked `discard` (never deleted). */
  discard_score: 22,
  /** Anything shorter than this is not a song. */
  min_seconds: 5,
  /** Integrated loudness below this is treated as silence/digital nothing. */
  min_lufs: -58,
  /** Move unusable takes to quarantine/ instead of leaving them in captures/. */
  quarantine: true,
  /** Mirror keeps into keeps/ under names a human can read. */
  organize: true,
  /** Write keeps.m3u8 (+ one per dominant style tag) for a DAW or player. */
  playlists: true,
  /** Mark an identical second take as a duplicate and skip re-encoding it. */
  dedupe: true,
  /** `{title} [{clip8}] {date}` -> "Midnight Shadows [7adf671c] 2026-09-14.m4a" */
  filename: '{title} [{clip8}]',
  /** Fetch Suno's own M4A for keeps that have no official copy yet. */
  official_m4a: 'auto',
  /** Keep the raw capture after a normalised copy exists. */
  keep_raw: true,
  /** How often the watcher looks for new work. */
  poll_ms: 4000,
};

const nowIso = () => new Date().toISOString();

export function loadConfig(root) {
  const p = join(root, CONFIG_FILE);
  let stored = {};
  try { if (existsSync(p)) stored = JSON.parse(readFileSync(p, 'utf8')); } catch { stored = {}; }
  const cfg = { ...DEFAULT_CONFIG, ...stored };
  // Write the merged view back on first run so the file is discoverable and
  // editable — a config nobody can find is a config nobody can fix.
  if (!existsSync(p)) { try { writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n'); } catch { /* read-only root */ } }
  return cfg;
}

export function saveConfig(root, patch) {
  const cfg = { ...loadConfig(root), ...(patch || {}) };
  try { writeFileSync(join(root, CONFIG_FILE), JSON.stringify(cfg, null, 2) + '\n'); } catch { /* read-only root */ }
  return cfg;
}

/* ------------------------------------------------------------------ *
 * naming                                                              *
 * ------------------------------------------------------------------ */

/** Filesystem-safe on Windows, macOS and Linux in one pass. */
export function safeName(s, max = 90) {
  const cleaned = String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    // Windows: trailing dots and spaces are silently stripped, which breaks any
    // path we hand back to the OS and any hash we computed from it.
    .replace(/[. ]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || 'untitled').slice(0, max).trim();
}

/** "Midnight Shadows [7adf671c] 2026-09-14" — no extension. */
export function prettyName(rec, pattern = DEFAULT_CONFIG.filename) {
  const song = rec.song || {};
  const title = safeName(song.title || rec.clip_id || 'Suno take', 70);
  const clip8 = rec.clip_id ? String(rec.clip_id).slice(0, 8) : 'clip';
  const date = String(rec.created_at || nowIso()).slice(0, 10);
  const tags = String(song.style_tags || '').split(',')[0].trim();
  const out = String(pattern || DEFAULT_CONFIG.filename)
    .replace('{title}', title)
    .replace('{clip8}', clip8)
    .replace('{clip}', rec.clip_id || '')
    .replace('{date}', date)
    .replace('{tag}', safeName(tags, 24));
  return safeName(out, 150) || `sunotake-${clip8}`;
}

/* ------------------------------------------------------------------ *
 * classification — pure, so the rules can be tested without disk      *
 * ------------------------------------------------------------------ */

/**
 * @param {object} rec        a capture record
 * @param {object} measured   { duration_s, integrated_lufs, peak_db } actually measured from the file
 * @param {object} cfg
 * @returns {{action:'promote'|'rank'|'quarantine', verdict:string, reasons:string[], locked?:boolean}}
 */
export function classify(rec, measured, cfg = DEFAULT_CONFIG) {
  const reasons = [];
  const audio = rec.audio || {};
  const locked = Boolean(rec.curation?.verdict_locked);
  // A decision somebody made on purpose ends the conversation. The autopilot is
  // allowed to *record* a verdict; it is never allowed to reverse one.
  if (locked) {
    return { action: 'rank', verdict: rec.curation.verdict, reasons: ['locked: decided by a human'], locked: true };
  }
  const duration = Number(measured?.duration_s ?? audio.duration_s ?? 0);
  const lufs = Number(measured?.integrated_lufs ?? NaN);
  const peak = Number(measured?.peak_db ?? NaN);

  // Hard "this is not audio" tests. Order matters: the first reason is the one
  // printed in the report, and "0 s of audio" is more actionable than "quiet".
  //
  // Two different fates, deliberately:
  //   quarantine — the file is not audio at all (empty, silent, zero-gain). It
  //                gets moved out of captures/ so it cannot pollute a session.
  //   reject     — it is audio, it is just not worth keeping (too short, never
  //                listened to). The verdict says so and the file stays put: a
  //                musician who deliberately recorded a 3-second stab should
  //                still find it exactly where the library says it is.
  let fatal = false, weak = false;
  if (!(duration > 0)) { reasons.push('zero-length file'); fatal = true; }
  else if (duration < cfg.min_seconds) { reasons.push(`only ${duration.toFixed(1)}s of audio (min ${cfg.min_seconds}s)`); weak = true; }
  // Only check loudness if the file is long enough to measure. Short files
  // (< 0.4 s of audio) produce -Infinity LUFS from measureLoudness, which is a
  // measurement limitation, not silence — check duration first.
  if (duration >= cfg.min_seconds) {
    if (!Number.isFinite(lufs)) { reasons.push('loudness unmeasurable (no frames?)'); fatal = true; }
    else if (lufs < cfg.min_lufs) { reasons.push(`silent: ${lufs.toFixed(1)} LUFS`); fatal = true; }
  }
  if (Number.isFinite(peak) && peak <= -80) { reasons.push(`peak ${peak.toFixed(1)} dBFS — digital silence`); fatal = true; }
  if (audio.had_zero_gain) { reasons.push('captured with the volume slider at 0%'); fatal = true; }
  if (audio.usable === false) { reasons.push('recorded take marked unusable'); fatal = true; }
  // Don't quarantine files that are unmeasurable but valid — they pass through
  if (measured?.unmeasurable && Number.isFinite(lufs) && lufs > cfg.min_lufs) {
    fatal = false; // override — file is valid, just couldn't measure precisely
  }

  if (fatal) return { action: 'quarantine', verdict: 'recapture', reasons, locked };
  if (weak) return { action: 'rank', verdict: 'recapture', reasons, locked };

  const auto = triageScore(rec);
  if (auto.verdict === 'recapture') reasons.push('triage says recapture');
  if (auto.score >= cfg.keep_score) {
    return { action: 'promote', verdict: 'keep', reasons: [...reasons, `score ${auto.score} >= ${cfg.keep_score}`], score: auto.score, locked };
  }
  if (auto.score < cfg.discard_score && !(rec.listen_state?.milestones || []).length) {
    return { action: 'rank', verdict: 'discard', reasons: [...reasons, `never heard past 5s (score ${auto.score})`], score: auto.score, locked };
  }
  return { action: 'rank', verdict: auto.verdict, reasons: [...reasons, `score ${auto.score}`], score: auto.score, locked };
}

/** Content hash of the audio, so the same take twice is recognised. */
export function audioHash(file) {
  try {
    const buf = readFileSync(file);
    return createHash('sha256').update(buf).digest('hex');
  } catch { return null; }
}

/* ------------------------------------------------------------------ *
 * the engine                                                          *
 * ------------------------------------------------------------------ */

export class Autopilot {
  /**
   * @param {object} o
   * @param {string} o.root     library root
   * @param {object} [o.tools]  result of probe() — { tools: { ffmpeg } }
   * @param {Function} [o.log]
   * @param {Function} [o.onEvent]  (event) => void, for the UI / SSE
   */
  constructor({ root, tools = { tools: {} }, log = () => {}, onEvent = () => {} } = {}) {
    this.root = root;
    this.lib = new Library(root);
    this.tools = tools || { tools: {} };
    this.log = log;
    this.onEvent = onEvent;
    this.cfg = loadConfig(root);
    this.timer = null;
    this.running = false;
    this.busy = false;
    this.stats = {
      runs: 0, last_run: null, processed: 0, promoted: 0, quarantined: 0,
      duplicates: 0, exported: 0, official: 0, errors: 0, started_at: nowIso(),
    };
    this.lastError = null;
  }

  dirs() {
    return {
      captures: join(this.root, 'captures'),
      keeps: join(this.root, 'keeps'),
      quarantine: join(this.root, 'quarantine'),
      exports: join(this.root, 'exports'),
    };
  }

  ensureDirs() {
    for (const d of Object.values(this.dirs())) { try { mkdirSync(d, { recursive: true }); } catch { /* ok */ } }
  }

  start() {
    if (this.running) return { already: true, poll_ms: this.cfg.poll_ms };
    this.ensureDirs();
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try { await this.runOnce(); } catch (e) { this.lastError = String(e?.message || e); this.stats.errors++; this.log('autopilot error:', this.lastError); }
      if (this.running) this.timer = setTimeout(loop, Math.max(500, Number(this.cfg.poll_ms) || 4000));
    };
    this.timer = setTimeout(loop, 250);
    this.log(`autopilot on (every ${this.cfg.poll_ms} ms) — keeps -> ${this.dirs().keeps}`);
    this.onEvent({ type: 'start', at: nowIso() });
    return { started: true, poll_ms: this.cfg.poll_ms, dirs: this.dirs() };
  }

  stop() {
    const was = this.running;
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    // Idempotent, and quiet when it was never running: the server stops the
    // pilot from both its 'close' handler and close(), and the double "off"
    // line read like two autopilots.
    if (was) this.log('autopilot off');
    this.onEvent({ type: 'stop', at: nowIso() });
    return { stopped: was, already: !was };
  }

  status() {
    const s = this.lib.stats();
    return {
      version: AUTOPILOT_VERSION,
      running: this.running,
      busy: this.busy,
      config: this.cfg,
      stats: this.stats,
      last_error: this.lastError,
      library: s,
      dirs: this.dirs(),
      ffmpeg: Boolean(this.tools?.tools?.ffmpeg),
      session: existsSync(join(this.root, 'session.json')),
    };
  }

  /**
   * One full pass. Idempotent and safe to run concurrently with a capture:
   * every step is keyed off the record, and the record is only written at the
   * end of a step.
   */
  async runOnce() {
    if (this.busy) return { skipped: 'already running' };
    this.busy = true;
    const t0 = Date.now();
    const out = { ran_at: nowIso(), considered: 0, processed: [], kept: 0, duplicates: [], exported: [], official: [], quarantined: [], errors: [] };
    try {
      this.ensureDirs();
      const cfg = this.cfg = loadConfig(this.root);
      const seenHashes = this._existingHashes();
      for (const rec of this.lib.all()) {
        out.considered++;
        if (!this._needsWork(rec)) continue;
        try {
          const r = await this._processOne(rec, cfg, seenHashes);
          if (r) out.processed.push(r.capture_id);
          if (r?.__kept) out.kept++;
          if (r?.__duplicate) out.duplicates.push(r.capture_id);
          if (r?.__quarantined) out.quarantined.push(r.capture_id);
          if (r?.__exported?.length) out.exported.push({ capture_id: r.capture_id, formats: r.__exported });
          if (r?.__official) out.official.push(r.capture_id);
        } catch (e) {
          out.errors.push({ capture_id: rec.capture_id, error: String(e?.message || e) });
          this.lastError = String(e?.message || e);
          this.stats.errors++;
          this.log('autopilot: failed on', rec.capture_id, this.lastError);
        }
      }
      if (cfg.playlists) await this._writePlaylists();
      if (cfg.playlists || cfg.organize) this._writeSessionReport();
      this.stats.runs++;
      this.stats.last_run = nowIso();
      out.ms = Date.now() - t0;
      if (out.processed.length) {
        this.log(`autopilot pass: ${out.processed.length} take(s) processed, ${out.kept} kept, ${out.quarantined.length} quarantined`);
      }
      if (out.processed.length || out.errors.length) this.onEvent({ type: 'pass', ...out });
      return out;
    } finally {
      this.busy = false;
    }
  }

  /** A record needs work if it has a readable take and no completed pass yet. */
  _needsWork(rec) {
    if (!rec?.capture_id) return false;
    const a = rec.audio || {};
    if (a.autopilot?.at) {
      // already processed; re-run only if the config changed in a way that
      // affects the result
      return a.autopilot.config_target_lufs !== this.cfg.target_lufs
        || JSON.stringify(a.autopilot.formats || []) !== JSON.stringify(this.cfg.formats || []);
    }
    return true;
  }

  /** The audio bytes we actually have, in preference order. */
  _audioFile(rec) {
    const a = rec.audio || {};
    const captures = this.dirs().captures;
    const quarantine = this.dirs().quarantine;
    const candidates = [
      rec.files?.normalized_wav,
      a.normalized_wav,
      rec.files?.audio,
    ];
    // Conventional paths in captures/
    candidates.push(join(captures, `${rec.capture_id}.wav`));
    candidates.push(join(captures, `${rec.capture_id}.${a.container || 'webm'}`));
    candidates.push(join(captures, `${rec.capture_id}.raw`));
    // Quarantine path (recover quarantined files)
    candidates.push(join(quarantine, `${rec.capture_id}.wav`));
    candidates.push(join(quarantine, `${rec.capture_id}.webm`));
    for (const c of candidates) {
      if (c && existsSync(c) && statSync(c).size > 44) {
        // If file is in quarantine, move it back to captures so it gets processed
        if (c.includes(quarantine)) {
          const dest = join(captures, basename(c));
          if (!existsSync(dest)) {
            try { renameSync(c, dest); this.log(`autopilot: recovered ${basename(c)} from quarantine`); } catch { /* ok */ }
          }
          return dest;
        }
        return c;
      }
    }
    return null;
  }

  _existingHashes() {
    const set = new Map();
    for (const r of this.lib.all()) {
      const h = r.audio?.sha256 || r.audio?.content_hash;
      if (h) set.set(h, r.capture_id);
    }
    return set;
  }

  async _processOne(rec, cfg, seenHashes) {
    const patch = {};
    const file = this._audioFile(rec);
    if (!file) {
      // No audio on disk. Mark as checked so we don't spin on this record
      // every pass — without autopilot.at, _needsWork treats it as new work
      // forever, and the same 10 browser-only takes burn a pass each poll.
      patch.autopilot_note = 'no audio on disk yet (take is still in the browser, or the app never received it)';
      patch.autopilot_checked_at = nowIso();
      patch.autopilot = { at: nowIso(), config_target_lufs: cfg.target_lufs, formats: cfg.formats, reasons: ['no audio file on disk'] };
      const updated = this.lib.update(rec.capture_id, { audio: { ...rec.audio, ...patch } });
      return updated;
    }

    // ---- 1. measure what is actually in the file -------------------------
    const measured = await this._measure(file, rec);
    const fromCapture = rec.audio?.source === 'webaudio-pcm-worklet';
    const src = { ...rec.audio };
    // If we can measure it, mark as usable (recovers previously failed records)
    if (measured && !measured.error) {
      src.usable = true;
    }

    // ---- 2. duplicate detection -----------------------------------------
    const hash = createHash('sha256').update(`${src.bytes || 0}:${measured.duration_s}:${measured.integrated_lufs ?? 'x'}:${rec.clip_id || ''}`).digest('hex').slice(0, 32);
    if (cfg.dedupe && hash && seenHashes.has(hash) && seenHashes.get(hash) !== rec.capture_id) {
      this.stats.duplicates++;
      const updated = this.lib.update(rec.capture_id, {
        audio: { ...src, ...patch, autopilot: { at: nowIso(), config_target_lufs: cfg.target_lufs, formats: cfg.formats }, content_hash: hash },
      });
      updated.__duplicate = true;
      this.log(`autopilot: ${rec.capture_id} duplicates ${seenHashes.get(hash)} — ranked, not re-encoded`);
      return updated;
    }
    if (hash) seenHashes.set(hash, rec.capture_id);

    // ---- 3. classify before doing expensive work ------------------------
    const verdictInfo = classify(rec, measured, cfg);

    if (verdictInfo.action === 'quarantine' && !verdictInfo.locked) {
      // Not audio (silent / empty / captured at volume 0). Moving it away is
      // the whole treatment: normalising and transcoding silence wastes the
      // musician's disk and time, and used to write derivatives next to the
      // quarantined file, so their paths depended on where junk was moved to.
      const moved = this._quarantine(rec, file);
      const audit = { ...(rec.files || {}) };
      if (moved && audit.audio === file) audit.audio = moved;
      const out = this.lib.update(rec.capture_id, {
        files: { ...audit, ...(moved ? { quarantined: moved } : {}) },
        audio: {
          ...src,
          duration_s: measured.duration_s ?? src.duration_s,
          measured_lufs_before: Number.isFinite(measured.integrated_lufs) ? round(measured.integrated_lufs, 2) : null,
          peak_before_db: Number.isFinite(measured.peak_db) ? round(measured.peak_db, 2) : null,
          usable: false,
          content_hash: hash,
          autopilot: { at: nowIso(), version: AUTOPILOT_VERSION, config_target_lufs: cfg.target_lufs, formats: cfg.formats, reasons: verdictInfo.reasons },
        },
      });
      const fin = this.lib.setVerdict(rec.capture_id, {
        verdict: 'recapture', note: verdictInfo.reasons.join('; ') || null, source: 'autopilot',
      }) || out;
      this.stats.quarantined++;
      fin.__quarantined = true;
      return fin;
    }

    // ---- 4. the offline pass: invert the slider, normalise, tag ---------
    let processResult = null;
    if (!src.normalized_wav || !existsSync(src.normalized_wav)) {
      try {
        processResult = await processTake({
          input: file, record: rec, targetLufs: cfg.target_lufs,
          outDir: join(this.root, 'captures'),
          // The live tier already compensated in the graph; the PCM tier did not.
          invertGain: fromCapture ? false : Boolean(src.gain_timeline?.points?.length),
          ffmpeg: this.tools?.tools?.ffmpeg,
        });
        const tag = {
          INAM: rec.song?.title || 'Untitled', TITL: rec.song?.title || 'Untitled', IART: 'Suno AI',
          IGNR: (rec.song?.style_tags || '').slice(0, 60),
          ICMT: `suno clip ${rec.clip_id || '?'}; heard ${round(rec.listen_state?.accrued_seconds || 0, 1)}s; coverage ${Math.round((rec.listen_state?.coverage || 0) * 100)}%; curated by GenMusicAssist autopilot`,
          ICOP: 'Suno AI (personal use)',
          ICRD: (rec.song?.created_at || '').slice(0, 10),
        };
        writeWavMetadataTag(processResult.wav, tag);
        patch.normalized_wav = processResult.wav;
        patch.bytes_normalized = processResult.wav_bytes;
        patch.measured_lufs_before = processResult.measured_lufs_before;
        patch.measured_lufs_after = processResult.measured_lufs_after;
        patch.applied_gain_db = processResult.applied_gain_db;
        patch.gain_normalized_db = processResult.gain_normalized_db;
        patch.peak_after_db = processResult.peak_after_db;
        patch.peak_limited = processResult.peak_limited;
        patch.duration_s = processResult.duration_s;
      } catch (e) {
        patch.autopilot_error = `process failed: ${String(e?.message || e)}`;
      }
    }

    // ---- 5. transcode (only if ffmpeg exists; a missing ffmpeg is not an error) ----
    const conversions = [];
    const wav = patch.normalized_wav || src.normalized_wav;
    const wantFormats = (cfg.formats || []).filter((f) => f && f !== 'wav');
    if (wav && existsSync(wav) && wantFormats.length) {
      for (const f of wantFormats) {
        const target = join(this.dirs().exports, `${prettyName(rec, cfg.filename)}.${f}`);
        try {
          if (existsSync(target)) { conversions.push({ format: f, ok: true, file: target, cached: true }); continue; }
          const c = await convertTo({ source: wav, format: f, ffmpeg: this.tools?.tools?.ffmpeg, out: target });
          conversions.push({ format: f, ...c });
          if (c.ok) this.stats.exported++;
        } catch (e) {
          conversions.push({ format: f, ok: false, reason: String(e?.message || e) });
        }
      }
    }
    if (conversions.length) { patch.conversions = conversions; }

    // ---- 6. verdict + organisation --------------------------------------
    const action = verdictInfo.action;
    const updated = this.lib.update(rec.capture_id, {
      audio: {
        ...src, ...patch,
        measured_lufs_before: patch.measured_lufs_before ?? src.measured_lufs_before ?? round(measured.integrated_lufs, 2),
        measured_lufs_after: patch.measured_lufs_after ?? src.measured_lufs_after ?? null,
        peak_before_db: patch.peak_before_db ?? round(measured.peak_db, 2),
        usable: !(action === 'quarantine' && !verdictInfo.locked),
        content_hash: hash,
        autopilot: { at: nowIso(), version: AUTOPILOT_VERSION, config_target_lufs: cfg.target_lufs, formats: cfg.formats, reasons: verdictInfo.reasons },
      },
    });

    let placed = null;
    if (cfg.organize && (action === 'promote' || updated?.curation?.verdict === 'keep')) {
      placed = this._placeInKeeps(updated, wav, cfg);
      if (placed) this.lib.update(rec.capture_id, { files: { ...(updated.files || {}), kept: placed.file } });
    }
    if (cfg.quarantine && action === 'quarantine') {
      const q = this._quarantine(updated, file);
      if (q) {
        // Keep the record TRUE after the move. Renaming the take out of
        // captures/ without repointing `files.audio` left every later consumer
        // (the UI player, /capture/process, /export, the next pass) looking at a
        // path that no longer exists, and the library lied about where the file
        // was — the one thing a library must never do.
        const audit = { ...(updated.files || {}) };
        if (audit.audio === file) audit.audio = q;
        this.lib.update(rec.capture_id, { files: { ...audit, quarantined: q } });
      }
    }

    // ---- 7. durable verdict --------------------------------------------
    const finalVerdict = verdictInfo.verdict;
    const finalRec = this.lib.setVerdict(rec.capture_id, {
      verdict: finalVerdict,
      note: verdictInfo.reasons.join('; ') || null,
      source: verdictInfo.locked ? 'human' : 'autopilot',
    }) || updated;

    if (finalVerdict === 'keep') { this.stats.promoted++; finalRec.__kept = true; }
    if (action === 'quarantine') this.stats.quarantined++;
    this.stats.processed++;
    finalRec.__exported = conversions.filter((c) => c.ok).map((c) => c.format);
    finalRec.__quarantined = action === 'quarantine';
    this.onEvent({ type: 'take', capture_id: rec.capture_id, verdict: finalVerdict, reasons: verdictInfo.reasons, kept: placed?.file || null });
    this.log(`autopilot: ${safeName(finalRec.song?.title || rec.capture_id)} -> ${finalVerdict} (${verdictInfo.reasons.join('; ') || 'clean'})`);
    return finalRec;
  }

  async _measure(file, rec) {
    try {
      const { channels, sampleRate } = await decodeToPcm(file, { ffmpeg: this.tools?.tools?.ffmpeg });
      const loud = measureLoudness(channels, sampleRate);
      const frames = channels?.[0]?.length || 0;
      return {
        duration_s: sampleRate ? frames / sampleRate : (rec.audio?.duration_s || 0),
        integrated_lufs: loud.integratedLufs,
        peak_db: gainToDb(peakLinear(channels)),
        sample_rate: sampleRate,
      };
    } catch (e) {
      // Decode failed. Before giving up, check if the file is actually valid
      // by checking its size. A webm file of several MB is almost certainly
      // valid audio — ffmpeg decode can fail for many transient reasons
      // (race conditions, codec quirks, etc). Don't quarantine valid files
      // just because we couldn't measure them.
      let fileSize = 0;
      try { fileSize = statSync(file).size; } catch { /* ok */ }
      const duration = rec.audio?.duration_s || 0;
      // If the file is larger than 100KB and has a reasonable duration,
      // treat it as valid but unmeasurable — don't quarantine.
      if (fileSize > 100000 && duration > 1) {
        return {
          duration_s: duration,
          integrated_lufs: -14, // assume target loudness so it passes the silence check
          peak_db: -1,
          sample_rate: 48000,
          unmeasurable: true,
        };
      }
      return {
        duration_s: duration,
        integrated_lufs: Number(rec.audio?.measured_lufs_before ?? NaN),
        peak_db: Number(rec.audio?.peak_before_db ?? NaN),
        error: String(e?.message || e),
      };
    }
  }

  /** Copy the archive copy into keeps/ under a name a human can read. */
  _placeInKeeps(rec, wav, cfg) {
    const source = wav && existsSync(wav) ? wav
      : (rec.files?.audio && existsSync(rec.files.audio) ? rec.files.audio : null);
    if (!source) return null;
    const ext = extname(source) || '.wav';
    const base = prettyName(rec, cfg.filename);
    const dir = this.dirs().keeps;
    try { mkdirSync(dir, { recursive: true }); } catch { /* ok */ }
    let file = join(dir, `${base}${ext}`);
    let n = 2;
    while (existsSync(file) && audioHash(file) !== audioHash(source)) { file = join(dir, `${base} (${n++})${ext}`); }
    if (existsSync(file) && audioHash(file) === audioHash(source)) return { file, cached: true };
    try {
      copyFileSync(source, file);
      // The sidecars ride along: a file in keeps/ without its metadata is the
      // "orphaned take" problem this project exists to fix.
      for (const kind of ['json', 'txt', 'cue']) {
        const s = this.lib.pathFor(rec.capture_id, kind);
        if (existsSync(s)) { try { copyFileSync(s, join(dir, `${base}.${kind}`)); } catch { /* ok */ } }
      }
      return { file };
    } catch (e) {
      this.log('autopilot: could not place keep:', String(e?.message || e));
      return null;
    }
  }

  _quarantine(rec, file) {
    const dir = this.dirs().quarantine;
    try { mkdirSync(dir, { recursive: true }); } catch { /* ok */ }
    const dest = join(dir, basename(file));
    try {
      if (!existsSync(dest)) { renameSync(file, dest); return dest; }
      // cross-device or already present: copy + remove is the honest fallback
      copyFileSync(file, dest);
      try { unlinkSync(file); } catch { /* keep the original if it will not go */ }
      return dest;
    } catch (e) {
      this.log('autopilot: quarantine failed:', String(e?.message || e));
      return null;
    }
  }

  /* ---------------- playlists + report ---------------- */

  _keeps() {
    return this.lib.all()
      .filter((r) => r.curation?.verdict === 'keep')
      .sort((a, b) => (b.curation?.score || 0) - (a.curation?.score || 0));
  }

  async _writePlaylists() {
    const keeps = this._keeps();
    const byTag = new Map();
    const lines = ['#EXTM3U'];
    for (const r of keeps) {
      const entry = this._playlistEntry(r);
      if (!entry) continue;
      lines.push(`#EXTINF:${Math.round(entry.seconds)},${entry.title}`, entry.path);
      const tag = safeName(String(r.song?.style_tags || '').split(',')[0] || 'untagged', 30).toLowerCase();
      if (!byTag.has(tag)) byTag.set(tag, ['#EXTM3U']);
      byTag.get(tag).push(`#EXTINF:${Math.round(entry.seconds)},${entry.title}`, entry.path);
    }
    const written = [];
    try {
      const p = join(this.dirs().keeps, 'keeps.m3u8');
      writeFileSync(p, lines.join('\n') + '\n');
      written.push(p);
      for (const [tag, ls] of byTag) {
        if (ls.length <= 1) continue;
        const q = join(this.dirs().keeps, `${tag}.m3u8`);
        writeFileSync(q, ls.join('\n') + '\n');
        written.push(q);
      }
    } catch (e) { this.log('autopilot: playlist write failed:', String(e?.message || e)); }
    return written;
  }

  _playlistEntry(rec) {
    // Prefer the copy that actually lives in keeps/ — a playlist that points at
    // captures/ breaks the moment the musician moves the keeps folder onto a
    // drive or a sampler's SD card, which is the whole point of the folder.
    const candidates = [rec.files?.kept, rec.audio?.normalized_wav, rec.files?.normalized_wav, rec.files?.audio];
    const keepsDir = this.dirs().keeps;
    for (const c of candidates) {
      if (c && existsSync(c)) {
        const inside = resolve(c).startsWith(resolve(keepsDir) + sep);
        return {
          // Relative paths inside keeps/ so the folder is portable as-is.
          path: inside ? basename(c) : c,
          portable: inside,
          title: safeName(rec.song?.title || rec.clip_id || 'Untitled'),
          seconds: rec.audio?.duration_s || 0,
        };
      }
    }
    return null;
  }

  _writeSessionReport() {
    const recs = this.lib.all();
    const keeps = this._keeps();
    const stats = this.lib.stats();
    const table = this.lib.byClip();
    const L = [];
    L.push(`# GenMusicAssist session — ${nowIso().slice(0, 10)}`);
    L.push('');
    L.push(`${stats.captures} captures · ${stats.clips} clips · ${stats.usable} usable · ${Math.round(stats.total_listen_seconds / 60)} min listened`);
    L.push(`keeps: **${keeps.length}** → \`${this.dirs().keeps}\``);
    L.push('');
    if (keeps.length) {
      L.push('## Keeps, ranked');
      L.push('');
      L.push('| # | score | heard | cover | title | file |');
      L.push('|---|-------|-------|-------|-------|------|');
      keeps.forEach((r, i) => {
        const e = this._playlistEntry(r);
        L.push(`| ${i + 1} | ${r.curation?.score ?? 0} | ${round(r.listen_state?.accrued_seconds || 0, 0)}s | ${Math.round((r.listen_state?.coverage || 0) * 100)}% | ${(r.song?.title || '').replace(/\|/g, '/')} | ${e ? basename(e.path) : '—'} |`);
      });
      L.push('');
    }
    L.push('## All clips');
    L.push('');
    L.push('| score | verdict | takes | ttl | title | why |');
    L.push('|-------|---------|-------|-----|-------|-----|');
    for (const r of table.slice(0, 300)) {
      L.push(`| ${r.score} | ${[...(r.verdicts || [])][0] || '—'} | ${r.takes} | ${r.archive_urgency ?? '—'}d | ${(r.song?.title || r.clip_id || '').replace(/\|/g, '/').slice(0, 50)} | ${(r.best?.curation?.note || '').replace(/\|/g, '/').slice(0, 60)} |`);
    }
    L.push('');
    const report = { generated_at: nowIso(), stats, keeps: keeps.length, autopilot: this.stats, config: this.cfg };
    try {
      writeFileSync(join(this.root, 'SESSION.md'), L.join('\n'));
      writeFileSync(join(this.root, 'session-report.json'), JSON.stringify(report, null, 2));
      this.lib.exportCsv();
    } catch { /* read-only root */ }
    return report;
  }

  /**
   * Fetch Suno's own M4A for keeps that do not have an official copy. This is
   * the ONE route that talks to Suno, it is off unless configured, it requires
   * a handed-over session, and it uses the m4a zip path (Suno's own UI default,
   * and the only format that does not spend `download_usage`).
   */
  async downloadOfficial({ force = false } = {}) {
    const enabled = this.cfg.official_m4a === true || (this.cfg.official_m4a === 'auto' && existsSync(join(this.root, 'session.json')));
    if (!force && !enabled) return { ok: false, skipped: 'official_m4a disabled or no session.json' };
    const cookie = this.lib.cookieHeader();
    if (!cookie) return { ok: false, skipped: 'no session (use the extension\'s "Extract session" button)' };
    const keeps = this._keeps().filter((r) => r.clip_id && !r.audio?.official_file);
    if (!keeps.length) return { ok: true, downloaded: 0, note: 'every keep already has its official copy' };
    const ids = keeps.map((r) => r.clip_id).slice(0, 200);
    try {
      const r = await fetch(`${API_PROD}/api/download/clips/zip/prepare`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', origin: 'https://suno.com', referer: 'https://suno.com/', accept: 'application/json' },
        body: JSON.stringify({ clip_ids: ids, workspace_name: null, format: 'm4a' }),
      });
      const j = await r.json().catch(() => null);
      if (!j?.download_url) return { ok: false, error: `Suno returned no download_url (${r.status})`, raw: j };
      const f = await fetch(j.download_url);
      if (!f.ok) return { ok: false, error: `download failed ${f.status}` };
      const buf = Buffer.from(await f.arrayBuffer());
      const dest = join(this.dirs().exports, `suno-m4a-${Date.now()}.zip`);
      writeFileSync(dest, buf);
      for (const rec of keeps) this.lib.update(rec.capture_id, { audio: { ...rec.audio, official_file: dest, official_at: nowIso() } });
      this.stats.official++;
      this.log(`autopilot: official M4A zip for ${ids.length} keep(s) -> ${dest}`);
      return { ok: true, downloaded: ids.length, file: dest, bytes: buf.length, failed: j.failed_clips || [] };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  /** Read the quota without spending any of it, for the report. */
  async quota() {
    const cookie = this.lib.cookieHeader();
    if (!cookie) return { ok: false, error: 'no session' };
    try {
      const r = await fetch(`${API_PROD}/api/billing/info/`, { headers: { cookie, origin: 'https://suno.com', referer: 'https://suno.com/', accept: 'application/json' } });
      if (!r.ok) return { ok: false, status: r.status };
      return { ok: true, ...parseDownloadQuota(await r.json()) };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  }
}

/**
 * Wait for a file to stop growing, then hand back its size. Used when a take is
 * still being written by the extension (the /capture/audio POST streams).
 */
export async function waitStable(file, { stableMs = 400, timeoutMs = 30000 } = {}) {
  const t0 = Date.now();
  let last = -1;
  for (;;) {
    if (existsSync(file)) {
      const s = statSync(file).size;
      if (s === last && s > 44) return s;
      last = s;
    }
    if (Date.now() - t0 > timeoutMs) return existsSync(file) ? statSync(file).size : 0;
    await new Promise((r) => { setTimeout(r, stableMs); });
  }
}

/** Best-effort extraction of the keeps folder path for a musician's DAW. */
export function keepsFolder(root) { return join(root, 'keeps'); }

export { once, decodeWav, readdirSync };

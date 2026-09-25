/**
 * sunolift / shared / metadata.js
 * ---------------------------------------------------------------------------
 * The listen/capture metadata model, plus sidecar writers.
 *
 * WHY THE SHAPE IS LIKE THIS
 * Suno's own player already answers "how much of this song did I actually hear",
 * and it does it with a specific, quirky algorithm that I reverse-engineered from
 * the shipped bundle (module 723530):
 *
 *   thresholds = [{5,"5s"},{30,"30s"},{60,"60s"}]  + "completed"
 *   on timeupdate: d = currentTime - lastPosition
 *                  if (d <= 0 || d > 2) ignore it      <-- seeks/skips discarded
 *                  accruedSeconds += d                  <-- only while isPlaying
 *                  fire each unfired threshold crossed
 *
 * i.e. milestones are *accrued listening seconds*, not the playhead position. A
 * song you scrubbed to 3:00 and immediately paused has accrued ~0 s. We reproduce
 * that exactly (`ListenAccumulator`) so our curation ranking is comparable with
 * Suno's own engagement signal, then extend it with the things Suno does not
 * record for you: per-interval coverage, replays, loop counts and rate.
 *
 * For a 100-generation session where you want one non-garbage track, "heard past
 * 60 s and replayed the hook twice" is the only honest ranking there is.
 */

import { round, clamp01, num, fmtClock } from './util.js';

/** `fmt` is the name every sidecar writer uses; fmtClock is the canonical impl. */
const fmt = fmtClock;

export const SCHEMA_VERSION = 'sunolift.capture/1';

/**
 * A different UUID from the player/network is a definitive track transition.
 * Deliberately accepts no duration: generated songs often have equal or nearly
 * equal lengths, so duration is corroborating telemetry, never identity.
 */
export function shouldRolloverCapture(currentId, candidateId, source) {
  const strong = source === 'network' || String(source || '').startsWith('active-');
  return Boolean(strong && currentId && candidateId && currentId !== candidateId);
}

/**
 * Decide whether a media element is stable enough to start a new take.
 *
 * Suno's MSE player has a real handoff state between adjacent songs: it first
 * selects the next queue UUID and POSTs playbar_state="paused" at 0 seconds,
 * then (several seconds later) publishes the new finite duration and POSTs
 * playbar_state="playing".  Browser `play` events and stale readyState values
 * can occur inside that gap. Starting a recorder there produces the exact
 * zero-byte phantom capture seen in the field.
 */
export function captureStartGate({
  duration,
  currentTime = 0,
  readyState = 0,
  ended = false,
  clipId = null,
  networkClipId = null,
  networkState = null,
  networkAgeMs = Infinity,
  identityPending = false,
} = {}) {
  const d = Number(duration);
  if (!Number.isFinite(d) || d <= 0) return { ok: false, reason: 'duration-unavailable' };
  if (Number(readyState) < 3) return { ok: false, reason: 'media-not-ready' };
  // MSE can leave `ended` true while replacing its source. Match the playback
  // loop's semantics: only trust ended when the playhead is actually near end.
  if (ended && d - Number(currentTime || 0) < 3) return { ok: false, reason: 'media-ended' };

  const freshQueueState = networkClipId && Number(networkAgeMs) < 10000;
  const atStart = !Number.isFinite(Number(currentTime)) || Number(currentTime) <= 0.25;
  if (atStart && identityPending) return { ok: false, reason: 'identity-pending' };
  if (freshQueueState && atStart && networkState && networkState !== 'playing') {
    return { ok: false, reason: `playbar-${networkState}` };
  }
  return { ok: true, reason: 'ready' };
}
export const MILESTONE_THRESHOLDS = [
  { threshold: 5, milestone: '5s', actionName: 'SongPlayed5s' },
  { threshold: 30, milestone: '30s', actionName: 'SongPlayed30s' },
  { threshold: 60, milestone: '60s', actionName: 'SongPlayed60s' },
];
/** Max timeupdate delta still counted as playback (Suno uses 2 s). */
export const MAX_CONTIGUOUS_DELTA = 2.0;

/* ------------------------------------------------------------------ *
 * Listen accumulator (Suno-identical semantics + extras)             *
 * ------------------------------------------------------------------ */

export class ListenAccumulator {
  constructor(onMilestone) {
    this.accruedSeconds = 0;
    this.lastPosition = null;
    this.fired = new Set();
    this.onMilestone = onMilestone || (() => {});
    /** extra, beyond Suno: coverage + behaviour */
    this.intervals = [];
    this.openInterval = null;
    this.seeks = [];
    this.replays = 0;
    this.maxRate = 1;
    this.completed = false;
    this.startedAt = null;
  }

  /** @param {number} position media currentTime (s) @param {boolean} isPlaying @param {number} now wall clock ms */
  tick(position, isPlaying, now = Date.now(), rate = 1) {
    if (!isFinite(position)) return null;
    if (isPlaying && this.startedAt === null) this.startedAt = now;
    const prev = this.lastPosition;
    this.lastPosition = position;
    if (prev === null) { if (isPlaying) this._open(position, now); return null; }
    if (!isPlaying) { this._close(now); return null; }
    const d = position - prev;
    if (d <= 0) {
      // going backwards = a seek-back / loop / repeat of earlier material
      if (d < -0.35) { this.seeks.push({ at: round(position, 3), delta: round(d, 3), kind: 'rewind' }); this.replays++; }
      this._close(now); this._open(position, now);
      return null;
    }
    if (d > MAX_CONTIGUOUS_DELTA) { this.seeks.push({ at: round(position, 3), delta: round(d, 3), kind: 'skip' }); this._close(now); this._open(position, now); return null; }
    this.accruedSeconds += d;
    this.maxRate = Math.max(this.maxRate, rate || 1);
    if (this.openInterval) this.openInterval.end = position;
    else this._open(position, now);
    this._evaluate();
    return null;
  }

  _open(position) { this.openInterval = { start: position, end: position, since: Date.now() }; }
  _close(now = Date.now()) {
    if (!this.openInterval) return;
    const { start, end, since } = this.openInterval;
    if (end > start) this.intervals.push({ start: round(start, 3), end: round(end, 3), ms: now - since });
    this.openInterval = null;
  }

  _evaluate() {
    for (const { threshold, milestone, actionName } of MILESTONE_THRESHOLDS) {
      if (this.accruedSeconds >= threshold && !this.fired.has(milestone)) {
        this.fired.add(milestone);
        this.onMilestone(milestone, actionName, this.accruedSeconds);
      }
    }
  }

  /** Suno fires `completed` separately (fireSongCompletedListenMilestone). */
  markCompleted() {
    this._close();
    if (this.fired.has('completed')) return;
    this.completed = true;
    this.fired.add('completed');
    this.onMilestone('completed', 'SongCompleted', this.accruedSeconds);
  }

  coverageOf(duration) {
    if (!duration || duration <= 0) return 0;
    const merged = mergeIntervals(this.intervals.concat(this.openInterval ? [this.openInterval] : []));
    return round(Math.min(1, merged.reduce((a, s) => a + (Math.min(s.end, duration) - s.start), 0) / duration), 4);
  }

  toJSON(duration) {
    const intervals = mergeIntervals(this.intervals.concat(this.openInterval ? [this.openInterval] : []));
    return {
      accrued_seconds: round(this.accruedSeconds, 3),
      milestones: MILESTONE_THRESHOLDS.map((m) => m.milestone).filter((m) => this.fired.has(m)).concat(this.fired.has('completed') ? [] : []),
      completed: this.completed || this.fired.has('completed'),
      coverage: this.coverageOf(duration),
      covered_intervals: intervals.map((s) => ({ start: round(s.start, 3), end: round(s.end, 3), seconds: round(s.end - s.start, 3) })),
      heard_through: lastHeardThrough(intervals, duration),
      heard_to_end: reachesEnd(intervals, duration),
      seek_events: this.seeks,
      replay_count: this.replays,
      max_playback_rate: round(this.maxRate, 3),
      listen_wall_ms: this.startedAt ? Date.now() - this.startedAt : 0,
    };
  }
}

/** Merge overlapping/adjacent [start,end] spans; coalesces gaps < `tol`. */
export function mergeIntervals(list, tol = 0.25) {
  const s = (list || []).filter((x) => x && isFinite(x.start) && isFinite(x.end) && x.end > x.start).map((x) => [x.start, x.end]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of s) {
    if (out.length && a - out[out.length - 1][1] <= tol) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    else out.push([a, b]);
  }
  return out.map(([start, end]) => ({ start, end }));
}

/**
 * The start of the unbroken run that reaches the end of the song (0 = never).
 * "heard_through: 200" means the listener ran 200 s -> end without a gap, which
 * is the single strongest keep signal for a 4.5 minute generation.
 */
export function reachesEnd(intervals, duration) {
  if (!duration) return false;
  return (intervals || []).some((s) => s.end >= duration - 1.5);
}

export function lastHeardThrough(intervals, duration) {
  if (!duration) return 0;
  let reach = 0;
  for (const s of intervals) if (Math.abs(s.end - duration) < 1.5 || s.end >= duration) reach = Math.max(reach, s.start);
  return round(reach, 3);
}

/* ------------------------------------------------------------------ *
 * Segment map: fuse our playhead with Suno's structural analysis      *
 * ------------------------------------------------------------------ */

/**
 * @param {object} p
 * @param {number} p.duration
 * @param {Array<{start:number,end:number}>} p.covered
 * @param {Array} [p.sections]   from /api/gen/{id}/novelty-sections
 * @param {Array} [p.downbeats]  from /api/gen/{id}/downbeats  [[t,strength],...]
 * @param {Array} [p.lyrics]     from /api/gen/{id}/aligned_lyrics/v2
 */
export function buildSegmentMap({ duration, covered = [], sections = [], downbeats = [], lyrics = [] }) {
  const bounds = new Set([0, duration || 0]);
  for (const s of sections) { const t = num(s.start_time ?? s.start ?? s.t); if (t != null) bounds.add(round(t, 3)); }
  for (const line of lyrics) { const t = num(line.start_time ?? line.start); if (t != null) bounds.add(round(t, 3)); }
  const times = [...bounds].filter((t) => isFinite(t) && t >= 0 && (!duration || t <= duration + 0.01)).sort((a, b) => a - b);
  const segs = [];
  for (let i = 0; i < times.length - 1; i++) {
    const start = times[i], end = times[i + 1];
    if (end - start < 0.2) continue;
    const heard = covered.reduce((a, s) => a + Math.max(0, Math.min(end, s.end) - Math.max(start, s.start)), 0);
    const beats = downbeats.filter((d) => { const t = Array.isArray(d) ? d[0] : num(d.time); return t >= start && t < end; }).length;
    const words = lyrics.filter((l) => { const t = num(l.start_time ?? l.start); return t >= start && t < end; });
    segs.push({
      index: segs.length,
      start: round(start, 3),
      end: round(end, 3),
      seconds: round(end - start, 3),
      heard_seconds: round(heard, 3),
      heard_ratio: round((end - start) > 0 ? heard / (end - start) : 0, 4),
      downbeats: beats,
      label: labelForSegment(sections, lyrics, start),
      text: words.map((w) => w.text ?? w.word ?? '').join(' ').trim().slice(0, 240) || undefined,
    });
  }
  return segs;
}

function labelForSegment(sections, lyrics, t) {
  for (const s of sections || []) {
    const a = num(s.start_time ?? s.start), b = num(s.end_time ?? s.end);
    if (a != null && b != null && t >= a && t < b) return s.label || s.section || s.type || 'section';
  }
  const line = (lyrics || []).find((l) => (num(l.start_time ?? l.start) ?? 0) <= t);
  return line ? (line.section || line.block || 'lyric') : 'segment';
}

/* ------------------------------------------------------------------ *
 * Curation scoring                                                    *
 * ------------------------------------------------------------------ */

/**
 * Rank a generation by *revealed preference* instead of by hoping the prompt
 * worked. Weights are deliberately coarse: this is a triage order, not a score
 * to be interpreted. Everything is derived from what the user actually did.
 */
export const DEFAULT_WEIGHTS = {
  past60: 34, past30: 16, past5: 6, completed: 26,
  coverage: 40, replay: 9, keptLoop: 8, skipPenalty: 14,
  audioQuality: 10, silencePenalty: 22, ratePenalty: 12,
};

export function triageScore(capture, weights = DEFAULT_WEIGHTS) {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const l = (capture.listen_state) || {};
  const dur = capture.song?.duration_s || 0;
  const cov = clamp01(l.coverage ?? coverageFromIntervals(l.covered_intervals, dur));
  const s = {
    past5: (l.milestones || []).includes('5s') ? w.past5 : 0,
    past30: (l.milestones || []).includes('30s') ? w.past30 : 0,
    past60: (l.milestones || []).includes('60s') ? w.past60 : 0,
    completed: l.completed ? w.completed : 0,
    coverage: cov * w.coverage,
    replay: Math.min(4, l.replay_count || 0) * w.replay,
    keptLoop: Math.min(3, (capture.cues || []).filter((c) => c.kind === 'loop').length) * w.keptLoop,
    skipPenalty: -(Math.min(6, (l.seek_events || []).filter((e) => e.kind === 'skip').length)) * w.skipPenalty,
    audioQuality: (capture.audio?.usable ? w.audioQuality : 0),
    silencePenalty: capture.audio?.had_zero_gain ? -w.silencePenalty : 0,
    ratePenalty: (l.max_playback_rate || 1) > 1.05 ? -w.ratePenalty : 0,
  };
  // Rewards are clamped *first*, then penalties subtract: otherwise a perfect
  // 100-point listen hides the fact that the recorded take is unusable.
  const positives = s.past5 + s.past30 + s.past60 + s.completed + s.coverage + s.replay + s.keptLoop + s.audioQuality;
  const penalties = s.skipPenalty + s.silencePenalty + s.ratePenalty;
  const total = Math.round(Math.max(0, Math.min(100, positives)) + penalties);
  return { score: Math.max(0, Math.min(100, total)), parts: s, verdict: verdict(total, cov, l, capture.audio) };
}

function coverageFromIntervals(intervals, dur) {
  if (!dur || !intervals || !intervals.length) return 0;
  return Math.min(1, intervals.reduce((a, s) => a + Math.max(0, Math.min(dur, s.end) - s.start), 0) / dur);
}

function verdict(raw, coverage, listen, audio = {}) {
  // No matter how much you liked it, a take captured at zero gain or with no
  // audio is not salvageable - say so instead of pretending it is a keeper.
  if (audio.usable === false || audio.had_zero_gain) return 'recapture';
  if (coverage >= 0.985 && listen.completed) return 'keep';
  if (raw >= 62) return 'keep';
  if (raw >= 34) return 'maybe';
  if ((listen.milestones || []).length === 0) return 'skip-unheard';
  return 'discard';
}

export { clamp01 };

/* ------------------------------------------------------------------ *
 * The capture record                                                  *
 * ------------------------------------------------------------------ */

/**
 * Whether Suno's own master is loudness-normalised. Two signals: the generation
 * request's `disable_volume_normalization` flag, and Suno's rule that disables it
 * outright for upload/edit-sourced clips (clipEditsDisableVolumeNormalization).
 */
function volNorm(clip) {
  const md = (clip && clip.metadata) || {};
  if (md.disable_volume_normalization === true) return false;
  const task = md.task || '';
  if (['upload', 'upload_extend', 'rendered_context_window', 'studio_export', 'studio_export_extend'].includes(task)) return false;
  return md.disable_volume_normalization === false ? true : null;
}

export function makeCaptureRecord({ clip, session, listen, audio, cues = [], sunoTelemetry, origin, error }) {
  const duration = num(clip?.duration_s ?? clip?.metadata?.duration) ?? audio?.duration_s ?? 0;
  const tl = audio?.gain_timeline;
  const uiGain = audio?.ui_gain ?? (tl?.points?.length ? tl.points[tl.points.length - 1][1] : null);
  const minTimelineGain = tl?.points?.length ? Math.min(...tl.points.map((p) => p[1])) : null;
  const zeroGain = Boolean(
    audio?.had_zero_gain
    || tl?.had_zero_gain
    || (uiGain != null && Number(uiGain) === 0)
    || (minTimelineGain != null && minTimelineGain <= 1e-4),
  );
  const rec = {
    schema: SCHEMA_VERSION,
    capture_id: session.capture_id,
    created_at: new Date().toISOString(),
    origin: origin || 'extension',
    clip_id: clip?.id || null,
    song: {
      id: clip?.id || null,
      title: clip?.title || null,
      duration_s: round(duration, 3),
      model_name: clip?.model_name || null,
      major_model_version: clip?.major_model_version || null,
      created_at: clip?.created_at || null,
      style_tags: clip?.metadata?.tags ?? clip?.display_tags ?? null,
      style_prompt: clip?.metadata?.gpt_description_prompt ?? null,
      lyrics: clip?.metadata?.prompt ?? null,
      instrumentals: clip?.metadata?.make_instrumental ?? false,
      explicit: clip?.explicit ?? false,
      image_url: clip?.image_url || null,
      workspace: clip?.metadata?.create_surface || null,
      volume_normalized: volNorm(clip),
      is_download_unlocked: clip?.is_download_unlocked ?? null,
    },
    media: {
      // What Suno exposed *at capture time*, kept verbatim for forensics: the
      // extension that blindly used clip.audio_url wrote a 403 body to disk.
      audio_url: clip?.audio_url ?? null,
      audio_url_is_sentinel: clip?.audio_url ? isForbiddenMediaUrl(clip.audio_url) : false,
      media_urls: clip?.media_urls ?? [],
      cdn_expiry: audio?.cdn_expiry || null,
    },
    audio: {
      bytes: audio?.bytes ?? 0,
      mime: audio?.mime ?? 'audio/webm;codecs=opus',
      container: audio?.container ?? 'webm',
      codec: audio?.codec ?? 'opus',
      sample_rate: audio?.sample_rate ?? 48000,
      channels: audio?.channels ?? 2,
      duration_s: round(audio?.duration_s ?? duration, 3),
      target_lufs: audio?.target_lufs ?? -14,
      measured_lufs_before: audio?.measured_lufs_before ?? null,
      measured_lufs_after: audio?.measured_lufs_after ?? null,
      peak_before_db: audio?.peak_before_db ?? null,
      applied_gain_db: audio?.applied_gain_db ?? null,
      gain_normalized_db: audio?.gain_normalized_db ?? null,
      ui_gain: uiGain,
      had_zero_gain: zeroGain,
      // The timeline is not debug noise: the offline pass divides the page's
      // slider back out of the samples with it. Drop it and the take is stuck at
      // whatever loudness the UI happened to be at.
      gain_timeline: audio?.gain_timeline ?? null,
      gain_timeline_points: audio?.gain_timeline?.points?.length ?? 0,
      source: audio?.source ?? 'webaudio-tap',
      // A take captured at zero gain is not usable, whatever its byte count
      // says. `usable: true` on a silent file let any consumer that only checks
      // this flag present it as a finished take.
      usable: zeroGain ? false : (audio?.usable ?? true),
      sha256: audio?.sha256 || null,
      bitrate_kbps: audio?.duration_s && audio.bytes ? round((audio.bytes * 8) / audio.duration_s / 1000, 1) : null,
    },
    listen_state: listen ?? { accrued_seconds: 0, milestones: [], coverage: 0, covered_intervals: [] },
    segments: audio?.segments ?? [],
    cues,
    suno_telemetry: sunoTelemetry ?? null,
    error: error || null,
  };
  return rec;
}

/**
 * Suno returns `audio_url: "https://studio-api.prod.suno.com/api/forbidden"` for
 * v6 clips. Any consumer that treats audio_url as a real asset now writes an
 * S3 AccessDenied XML body to disk and calls it a download.
 */
export function isForbiddenMediaUrl(u) {
  try { return new URL(u).pathname === '/api/forbidden'; } catch { return typeof u === 'string' && u.includes('/api/forbidden'); }
}

/* ------------------------------------------------------------------ *
 * Sidecar writers                                                     *
 * ------------------------------------------------------------------ */

export function sidecarTxt(rec) {
  const s = rec.song || {}, l = rec.listen_state || {}, a = rec.audio || {};
  const lines = [];
  const L = (k, v) => { if (v !== null && v !== undefined && v !== '') lines.push(`${k}: ${v}`); };
  lines.push(s.title || 'Untitled');
  lines.push('='.repeat(Math.min(72, Math.max(8, (s.title || 'Untitled').length))));
  L('Clip ID', rec.clip_id);
  L('Capture ID', rec.capture_id);
  L('Generated', s.created_at);
  L('Captured', rec.created_at);
  L('Model', [s.major_model_version, s.model_name].filter(Boolean).join(' / '));
  L('Duration', fmt(s.duration_s));
  L('Style / tags', s.style_tags);
  L('Style prompt', s.style_prompt);
  L('Instrumental', s.instrumentals ? 'yes' : 'no');
  L('Suno loudness normalization', s.volume_normalized === null ? 'unknown' : s.volume_normalized ? 'on' : 'off');
  L('Download unlocked on Suno', s.is_download_unlocked === null ? 'unknown' : s.is_download_unlocked ? 'yes' : 'no');
  lines.push('');
  lines.push('-- LISTENED --');
  L('Accrued listening', `${round(l.accrued_seconds, 1)}s`);
  L('Milestones hit', (l.milestones || []).join(', ') || 'none');
  L('Completed', l.completed ? 'yes' : 'no');
  L('Coverage of song', `${round((l.coverage || 0) * 100, 1)}%`);
  L('Heard through', l.heard_through ? `${fmt(l.heard_through)} -> end` : 'n/a');
  L('Replays / rewinds', l.replay_count || 0);
  L('Skips', (l.seek_events || []).filter((e) => e.kind === 'skip').length);
  L('Max rate', l.max_playback_rate || 1);
  if (l.covered_intervals?.length) lines.push(`Heard spans: ${l.covered_intervals.map((i) => `${fmt(i.start)}-${fmt(i.end)}`).join(', ')}`);
  lines.push('');
  lines.push('-- CAPTURE --');
  L('Source', a.source);
  L('Format', `${a.container}/${a.codec} ${a.channels}ch ${a.sample_rate}Hz`);
  L('Size', `${(a.bytes / 1024).toFixed(1)} KiB`);
  L('Bitrate', a.bitrate_kbps ? `${a.bitrate_kbps} kbps` : null);
  L('Loudness', a.measured_lufs_before != null ? `${round(a.measured_lufs_before, 2)} -> ${round(a.measured_lufs_after, 2)} LUFS (target ${a.target_lufs})` : null);
  L('UI volume at capture', a.ui_gain != null ? `${round(a.ui_gain * 100, 1)}%` : null);
  L('Gain correction', a.applied_gain_db != null ? `+${round(a.applied_gain_db, 2)} dB` : 'none needed');
  L('Volume-invariant', a.had_zero_gain ? 'NO - captured at zero gain' : 'yes');
  if (a.cdn_expiry) L('Suno CDN object expires', a.cdn_expiry);
  lines.push('');
  if (rec.segments?.length) {
    lines.push('-- SEGMENTS --');
    for (const g of rec.segments) lines.push(`${fmt(g.start)} - ${fmt(g.end)}  heard ${String(Math.round(g.heard_ratio * 100)).padStart(3)}%  ${g.label}${g.text ? '  | ' + g.text.slice(0, 80) : ''}`);
    lines.push('');
  }
  if (rec.cues?.length) { lines.push('-- CUES --'); for (const c of rec.cues) lines.push(`${fmt(c.t)}  ${c.kind}${c.note ? '  ' + c.note : ''}`); lines.push(''); }
  if (l.milestones?.length || l.completed) {
    const last = (l.milestones || []).length ? (l.milestones[l.milestones.length - 1]) : '5s';
    lines.push(`// Suno would have POSTed /api/gen/${rec.clip_id}/listen_milestone {"milestone":"${last}"} for this listen.`);
  }
  return lines.join('\n') + '\n';
}

export function sidecarCue(rec, audioFilename = null) {
  const title = (rec.song?.title || 'Untitled').replace(/"/g, "'");
  const file = String(audioFilename || `${title}.${rec.audio?.container || 'webm'}`).replace(/"/g, "'");
  const out = [`PERFORMER "Suno AI"`, `TITLE "${title}"`, `REM SUNO_CLIP_ID ${rec.clip_id || ''}`, `REM CAPTURE_ID ${rec.capture_id || ''}`, `REM LISTEN_ACCRUED ${rec.listen_state?.accrued_seconds ?? 0}`, `REM COVERAGE ${rec.listen_state?.coverage ?? 0}`, `FILE "${file}" WAVE`];
  (rec.segments || []).forEach((g, i) => out.push(`  TRACK ${String(i + 1).padStart(2, '0')} AUDIO`, `    TITLE "${g.label} ${fmt(g.start)}-${fmt(g.end)}"`, `    INDEX 01 ${mmssCue(g.start)}`));
  if (!out.length) out.push('  TRACK 01 AUDIO', '    INDEX 01 00:00:00');
  return out.join('\n') + '\n';
}

export function sidecarJson(rec, pretty = true) { return pretty ? JSON.stringify(rec, null, 2) : JSON.stringify(rec); }

export function sidecarRows(recs) {
  const head = ['capture_id', 'clip_id', 'title', 'captured_at', 'duration_s', 'accrued_s', 'milestones', 'completed', 'coverage', 'heard_through', 'replays', 'skips', 'bytes', 'kbps', 'lufs_after', 'ui_gain', 'source', 'verdict', 'score'];
  const rows = recs.map((r) => [
    r.capture_id, r.clip_id, (r.song?.title || '').replace(/[",\n]/g, ' ').replace(/\s+/g, ' ').trim(), r.created_at, r.song?.duration_s ?? '',
    r.listen_state?.accrued_seconds ?? '', (r.listen_state?.milestones || []).join('|'), r.listen_state?.completed ? 1 : 0,
    r.listen_state?.coverage ?? '', r.listen_state?.heard_through ?? '', r.listen_state?.replay_count ?? 0,
    (r.listen_state?.seek_events || []).filter((e) => e.kind === 'skip').length, r.audio?.bytes ?? 0, r.audio?.bitrate_kbps ?? '',
    r.audio?.measured_lufs_after ?? '', r.audio?.ui_gain ?? '', r.audio?.source ?? '', r.curation?.verdict ?? '', r.curation?.score ?? '',
  ].join(','));
  return [head.join(','), ...rows].join('\n') + '\n';
}


function mmssCue(sec) {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60), f = Math.floor((sec % 1) * 75);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}

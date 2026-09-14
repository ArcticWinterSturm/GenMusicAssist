/**
 * sunolift / desktop / lib / library.js
 * ---------------------------------------------------------------------------
 * The on-disk curation store. JSONL, append-mostly, one file per capture plus
 * sidecars. Chosen over SQLite deliberately: a 200-generation session is ~40 MB
 * of metadata, and the user must be able to `grep`/`jq`/`git` their own review
 * history. A broken extension that "helpfully" hides the data is the failure
 * mode we are replacing.
 *
 * Layout under --root (default ~/GenMusicAssist):
 *   library.jsonl                 one capture record per line (append-only)
 *   captures/<capture_id>.<ext>   audio
 *   captures/<capture_id>.json    full metadata
 *   captures/<capture_id>.txt     human sidecar (like the exporter's .txt)
 *   captures/<capture_id>.cue     cue sheet of the heard segments
 *   journal.jsonl                 reflect-tier playhead/milestone events
 *   session.json                  0600, browser session handed over on demand
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, statSync, renameSync, chmodSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { triageScore, sidecarTxt, sidecarJson, sidecarCue, sidecarRows, SCHEMA_VERSION } from '../../shared/metadata.js';

export const DEFAULT_ROOT = process.env.SUNOLIFT_ROOT || join(homedir(), 'GenMusicAssist');
/** Suno's CloudFront objects carry an ~31 day lifecycle rule (observed x-amz-expiration). */
export const CDN_TTL_DAYS = 31;

export class Library {
  constructor(root = DEFAULT_ROOT) {
    // `--root` with no value arrives as null/undefined; fall back rather than
    // blowing up inside path.join with an ERR_INVALID_ARG_TYPE stack trace.
    this.root = (typeof root === 'string' && root.trim()) ? root : DEFAULT_ROOT;
    this.dir = join(this.root, 'captures');
    this.file = join(this.root, 'library.jsonl');
    this.journal = join(this.root, 'journal.jsonl');
    mkdirSync(this.dir, { recursive: true });
    if (!existsSync(this.file)) writeFileSync(this.file, '');
  }

  /* ---- records ---- */
  all() {
    if (!existsSync(this.file)) return [];
    const out = [];
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* torn line from a killed write; skip */ }
    }
    // last write wins (append-only log)
    const byId = new Map();
    for (const r of out) byId.set(r.capture_id, r);
    return [...byId.values()];
  }

  save(rec) {
    if (!rec?.capture_id) throw new Error('capture_id required');
    rec.schema = rec.schema || SCHEMA_VERSION;
    if (!rec.curation) rec.curation = triageScore(rec);
    const audioPath = this.audioPath(rec.capture_id, rec.audio?.container || 'webm');
    const jsonPath = this.pathFor(rec.capture_id, 'json');
    writeFileSync(jsonPath, sidecarJson(rec));
    writeFileSync(this.pathFor(rec.capture_id, 'txt'), sidecarTxt(rec));
    writeFileSync(this.pathFor(rec.capture_id, 'cue'), sidecarCue(rec));
    rec.files = {
      ...(rec.files || {}),
      audio: rec.files?.audio || (existsSync(audioPath) ? audioPath : null),
      json: jsonPath,
      txt: this.pathFor(rec.capture_id, 'txt'),
      cue: this.pathFor(rec.capture_id, 'cue'),
    };
    appendFileSync(this.file, JSON.stringify(rec) + '\n');
    return rec;
  }

  update(captureId, patch) {
    const all = this.all();
    const i = all.findIndex((r) => r.capture_id === captureId);
    if (i < 0) return null;
    all[i] = { ...all[i], ...patch, updated_at: new Date().toISOString() };
    // Recompute the score, but never let the automatic pass overwrite a verdict
    // that a human (or the autopilot acting on a human rule) recorded.
    const prev = all[i].curation || {};
    const auto = triageScore(all[i]);
    all[i].curation = prev.verdict_locked
      ? { ...auto, verdict: prev.verdict, verdict_source: prev.verdict_source, verdict_locked: true, note: prev.note ?? null, decided_at: prev.decided_at ?? null }
      : { ...auto, ...(prev.note ? { note: prev.note } : {}) };
    this._rewrite(all);
    const rec = all[i];
    this._writeSidecars(rec);
    return rec;
  }

  /**
   * Record a decision. This is the ONLY way a verdict becomes durable: the store
   * keeps `verdict_locked`, so a later loudness pass or re-finalize cannot erase
   * a judgement that was made deliberately.
   */
  setVerdict(captureId, { verdict = null, note, source = 'human' } = {}) {
    const all = this.all();
    const i = all.findIndex((r) => r.capture_id === captureId);
    if (i < 0) return null;
    const rec = all[i];
    const auto = triageScore(rec);
    const prev = rec.curation || {};
    rec.curation = {
      ...auto,
      verdict: verdict || prev.verdict || auto.verdict,
      verdict_source: verdict ? source : (prev.verdict_source || 'auto'),
      // `locked` means "a human decided this". The autopilot's own verdicts stay
      // revisable, otherwise the second pass would treat its own output as a
      // human instruction and stop ranking anything.
      verdict_locked: verdict ? (source !== 'autopilot') : Boolean(prev.verdict_locked),
      note: note === undefined ? (prev.note ?? null) : note,
      decided_at: verdict ? new Date().toISOString() : (prev.decided_at ?? null),
    };
    rec.updated_at = new Date().toISOString();
    this._rewrite(all);
    this._writeSidecars(rec);
    return rec;
  }

  _rewrite(all) {
    // tmp + rename so a kill mid-write cannot truncate the library — the JSONL
    // is the only index of everything captured.
    writeFileSync(this.file + '.tmp', all.map((r) => JSON.stringify(r)).join('\n') + '\n');
    renameSync(this.file + '.tmp', this.file);
  }

  _writeSidecars(rec) {
    try { writeFileSync(this.pathFor(rec.capture_id, 'json'), sidecarJson(rec)); } catch { /* disk full / locked */ }
    try { writeFileSync(this.pathFor(rec.capture_id, 'txt'), sidecarTxt(rec)); } catch { /* ok */ }
    try { writeFileSync(this.pathFor(rec.capture_id, 'cue'), sidecarCue(rec)); } catch { /* ok */ }
  }

  pathFor(captureId, ext) { return join(this.dir, `${basename(String(captureId).replace(/[^\w.-]/g, '_'))}.${ext}`); }
  audioPath(captureId, ext) { return this.pathFor(captureId, ext); }

  /* ---- reflect journal ---- */
  journalAppend(ev) { appendFileSync(this.journal, JSON.stringify({ ...ev, at: ev.at || Date.now() }) + '\n'); }
  journalEvents(limit = 5000) {
    if (!existsSync(this.journal)) return [];
    const lines = readFileSync(this.journal, 'utf8').trim().split('\n').slice(-limit);
    return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  /**
   * Per-clip rollup: the best take + the summed listening behaviour.
   * In a 100-generation session this is the actual triage table.
   */
  byClip() {
    const m = new Map();
    for (const r of this.all()) {
      const k = r.clip_id || r.capture_id;
      const cur = m.get(k) || { clip_id: k, song: r.song, takes: 0, best: null, accrued: 0, coverage: 0, verdicts: new Set(), last: null, lost_after: null };
      cur.takes++;
      cur.accrued = Math.max(cur.accrued, r.listen_state?.accrued_seconds || 0);
      cur.coverage = Math.max(cur.coverage, r.listen_state?.coverage || 0);
      if (r.curation?.verdict) cur.verdicts.add(r.curation.verdict);
      if (r.curation?.verdict_locked) cur.locked = r.curation.verdict;
      if (!cur.best || (r.curation?.score || 0) > (cur.best.curation?.score || 0)) cur.best = r;
      cur.last = r.created_at;
      m.set(k, cur);
    }
    const now = Date.now();
    return [...m.values()].map((v) => {
      const ageDays = v.last ? (now - Date.parse(v.last)) / 86400000 : null;
      return {
        ...v,
        verdicts: [...v.verdicts],
        score: v.best?.curation?.score ?? 0,
        // Archive urgency: Suno's own copy of the media expires, and the clip is
        // not downloadable anyway, so a take you never saved is a take you lose.
        archive_urgency: ageDays == null ? null : Math.max(0, Math.round(CDN_TTL_DAYS - ageDays)),
      };
    }).sort((a, b) => b.score - a.score);
  }

  exportCsv(file) {
    const csv = sidecarRows(this.all().sort((a, b) => (b.curation?.score || 0) - (a.curation?.score || 0)));
    const p = file || join(this.root, 'library.csv');
    // UTF-8 BOM: titles are routinely CJK and Excel otherwise shows mojibake -
    // the same class of bug the HAR export introduces upstream.
    writeFileSync(p, '\ufeff' + csv);
    return { path: p, rows: csv.trim().split('\n').length - 1 };
  }

  stats() {
    const recs = this.all();
    const bytes = recs.reduce((a, r) => a + (r.audio?.bytes || 0), 0);
    const byVerdict = {};
    for (const r of recs) { const v = r.curation?.verdict || 'unjudged'; byVerdict[v] = (byVerdict[v] || 0) + 1; }
    return {
      captures: recs.length, clips: new Set(recs.map((r) => r.clip_id)).size,
      bytes, mb: Math.round(bytes / 1048576),
      total_listen_seconds: Math.round(recs.reduce((a, r) => a + (r.listen_state?.accrued_seconds || 0), 0)),
      completed: recs.filter((r) => r.listen_state?.completed).length,
      by_verdict: byVerdict,
      root: this.root,
      usable: recs.filter((r) => r.audio?.usable).length,
      needs_recapture: recs.filter((r) => r.curation?.verdict === 'recapture' || r.audio?.had_zero_gain).length,
    };
  }

  /* ---- session handoff ---- */
  saveSession(payload) {
    const p = join(this.root, 'session.json');
    writeFileSync(p, JSON.stringify({ ...payload, saved_at: new Date().toISOString() }, null, 2));
    try { chmodSync(p, 0o600); } catch { /* windows */ }
    return { path: p, mode: '0600', cookies: (payload.cookies || []).length };
  }
  loadSession() {
    const p = join(this.root, 'session.json');
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
  }
  cookieHeader() {
    const s = this.loadSession();
    if (!s?.cookies?.length) return null;
    return s.cookies.filter((c) => c.name && c.value).map((c) => `${c.name}=${c.value}`).join('; ');
  }
  diskBytes() { try { return statSync(this.file).size; } catch { return 0; } }
}

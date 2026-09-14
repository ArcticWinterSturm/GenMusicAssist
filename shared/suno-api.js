/**
 * sunolift / shared /suno-api.js
 * ---------------------------------------------------------------------------
 * Suno endpoint layer, reconstructed from the live bundles (v6 / chirp-goose,
 * Sept 2026) rather than from the old public knowledge that broke the
 * existing extensions.
 *
 * VERIFIED FACTS THIS MODULE ENCODES (see ../ANALYSIS.md for evidence)
 *  - clip.audio_url is now the sentinel "https://studio-api.prod.suno.com/api/forbidden"
 *  - real media lives in clip.media_urls[] = {url, content_type, delivery, encoding}
 *  - media is *encrypted* ("encoding":"1.0.0", AES-CTR, key via /api/mango/rights);
 *    Suno's own helper `getDecodableClipAudioUrl` returns null in that case, so
 *    "download the file and hand it to the user" is no longer a working design
 *  - cdn1.suno.ai/{id}.mp3 -> 403 (CloudFront signed URLs now required)
 *  - audiopipe unencrypted stream -> 403; only ?encoded=true works
 *  - CloudFront m4a objects carry x-amz-expiration ~31 days (they self-destruct)
 *  - listen telemetry: POST /api/gen/{id}/listen_milestone {"milestone":"5s|30s|60s"}
 *  - playhead mirror:    POST /api/music_player/playbar_state {..., song_play_time, volume}
 *  - bulk export:        POST /api/download/clips/zip/prepare {clip_ids, format:"m4a"}
 *  - mp3:                GET  /api/download/clip/{id}?format=mp3 (poll "processing")
 *  - wav:                POST /api/gen/{id}/convert_wav/ then GET /api/gen/{id}/wav_file/
 *  - structure:          /api/gen/{id}/{waveform-aggregates,downbeats,novelty-sections,aligned_lyrics/v2}
 */

import { num, round, clamp } from './util.js';

export const SUNO_WEB = 'https://suno.com';
export const API_PROD = 'https://studio-api-prod.suno.com';
export const API_ALT = 'https://studio-api.prod.suno.com';
export const FORBIDDEN_SENTINEL = `${API_ALT}/api/forbidden`;
export const CDN_M4A_BASE = 'https://d2lwuy8qc234o3.cloudfront.net/1/clip';
export const AUDIOPIPE = 'https://audiopipe.suno.ai';

/** MediaContentType enum + the two content-type lists, verbatim from module 870357. */
export const MediaContentType = { Mp3: 'mp3', M4aOpus: 'm4a-opus', WebmOpus: 'webm-opus' };
export const ENCRYPTED_CONTENT_TYPES = [MediaContentType.WebmOpus, MediaContentType.M4aOpus];
export const UNENCRYPTED_CONTENT_TYPES = [MediaContentType.WebmOpus, MediaContentType.M4aOpus, MediaContentType.Mp3];
/** Hosts Suno treats as "its own" media endpoints (audiopipe plus two CF distributions). */
export const SELF_MEDIA_HOSTS = new Set(['dn3ebm5xp8ng9.cloudfront.net', 'd2lb3d8e434rsy.cloudfront.net']);

/** Suno tasks for which the server turns OFF its own loudness normalisation. */
export const CLIP_EDITS_DISABLE_VOLUME_NORMALIZATION = ['upload', 'upload_extend', 'rendered_context_window', 'studio_export', 'studio_export_extend'];

/* ---------------- url builders ---------------- */

/** Deterministic progressive M4A object. No token, `access-control-allow-origin: *` — but see mediaDiagnostics: the object is encrypted. */
export const cdnM4aUrl = (clipId) => `${CDN_M4A_BASE}/${clipId}.m4a`;
export const audiopipeUrl = (clipId, { format = 'webm', encoded = true } = {}) =>
  `${AUDIOPIPE}/?item_id=${encodeURIComponent(clipId)}&format=${format}${encoded ? '&encoded=true' : ''}`;

/**
 * Faithful port of Suno's `findAudioMediaItem(mediaUrls, {encrypted, delivery, contentType})`.
 * The predicate is `!!item.encoding === encrypted`: the *presence of the `encoding`
 * field* (e.g. "1.0.0") marks an item as DRM'd. An extension that reads
 * `media_urls[0].url` without this check downloads ciphertext.
 */
export function findAudioMediaItem(mediaUrls, { encrypted, delivery, contentType } = {}) {
  if (!mediaUrls || mediaUrls.length === 0) return null;
  const ct = contentType !== undefined ? contentType : (encrypted ? ENCRYPTED_CONTENT_TYPES : UNENCRYPTED_CONTENT_TYPES);
  for (const m of mediaUrls) {
    if (!m) continue;
    if (Boolean(m.encoding) !== Boolean(encrypted)) continue;
    if (delivery && m.delivery !== delivery) continue;
    if (ct && !(Array.isArray(ct) ? ct.includes(m.content_type) : ct === m.content_type)) continue;
    return m;
  }
  return null;
}

/**
 * Port of Suno's own `getDecodableClipAudioUrl`. Returns null when the only media
 * is DRM'd - which, for v6 clips, is always. This is precisely the wall the
 * published exporters ran into.
 */
export function getDecodableClipAudioUrl(clip) {
  const t = findAudioMediaItem(clip?.media_urls, { encrypted: false, delivery: 'progressive' });
  if (t) return t.url;
  if (clip?.media_urls && clip.media_urls.length > 0) return null;
  const r = clip?.audio_url;
  if (!r || isAudiopipeUrl(r) || isForbiddenUrl(r)) return null;
  return r;
}

export function isAudiopipeUrl(u) {
  try { const t = new URL(u); return /^(audiopipe|audiopipe-dev)\./.test(t.hostname) || SELF_MEDIA_HOSTS.has(t.hostname); } catch { return false; }
}
export const isForbiddenUrl = (u) => { try { return new URL(u).pathname === '/api/forbidden'; } catch { return typeof u === 'string' && u.includes('/api/forbidden'); } };

/* ---- small predicates lifted from Suno's clip helpers ---- */
export const isComplete = (clip) => clip?.status === 'complete';
export const isClipPlayable = (clip) => Boolean(clip?.audio_url) && (clip?.status === 'complete' || clip?.status === 'streaming');
export const getKnownDurationSeconds = (clip) => { const t = clip?.metadata?.duration; return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : null; };
export const getClipPreviewUrl = (clip) => clip?.preview_url ?? null;
export const clipEditsDisableVolumeNormalization = (clip) => CLIP_EDITS_DISABLE_VOLUME_NORMALIZATION.includes(clip?.metadata?.task || '');
/** formatClipTitle: explicit title, else first non-bracket line of the prompt, else "Untitled". */
export function formatClipTitle(clip, fallbackMax = 40) {
  const t = (clip?.title || '').trim();
  if (t) return t;
  const p = String(clip?.metadata?.prompt ?? clip?.metadata?.gpt_description_prompt ?? '');
  const stripped = p.replace(/\[.*?\]/g, '').trim().split('\n')[0].slice(0, fallbackMax);
  return stripped || 'Untitled';
}

/** Full media diagnosis: why an export works or does not, per clip. */
export function mediaDiagnostics(clip) {
  const urls = clip?.media_urls || [];
  const decodable = getDecodableClipAudioUrl(clip);
  const encryptedItem = findAudioMediaItem(urls, { encrypted: true });
  const plainItem = findAudioMediaItem(urls, { encrypted: false });
  return {
    clip_status: clip?.status ?? null,
    audio_url: clip?.audio_url ?? null,
    audio_url_is_sentinel: clip?.audio_url ? isForbiddenUrl(clip.audio_url) : false,
    legacy_cdn_would_403: clip?.id ? `https://cdn1.suno.ai/${clip.id}.mp3` : null,
    media_urls: urls,
    encrypted_media_item: encryptedItem || null,
    plain_media_item: plainItem || null,
    encoding_scheme: encryptedItem?.encoding ?? null,
    decodable_url: decodable,
    downloadable_directly: Boolean(decodable),
    needs_capture: !decodable,
    encrypted_media: urls.filter((m) => m.encoding).length,
    download_unlocked: clip?.is_download_unlocked ?? null,
    download_action: (clip?.action_config?.actions || []).find((a) => a.action_type === 'download_song') || null,
    preview_url: getClipPreviewUrl(clip),
    /** Suno objects carry an S3 lifecycle expiry (~31 d) - the archive must be local. */
    cdn_expiry_risk: urls.some((m) => /cloudfront/.test(m.url || '')) ? 'object has x-amz-expiration; re-download not guaranteed' : null,
  };
}

/* ---------------- endpoints ---------------- */

export const ep = {
  clip: (id) => `${API_PROD}/api/clip/${id}`,
  clipsByIds: `${API_PROD}/api/clips/get_songs_by_ids`,
  feedV3: `${API_PROD}/api/feed/v3`,
  feedV3Offset: `${API_PROD}/api/feed/v3/offset`,
  unifiedFeed: `${API_PROD}/api/unified/feed`,
  billing: `${API_PROD}/api/billing/info/`,
  playbarState: `${API_PROD}/api/music_player/playbar_state`,
  listenMilestone: (id) => `${API_PROD}/api/gen/${id}/listen_milestone`,
  incrementPlayCount: (id) => `${API_PROD}/api/gen/${id}/increment_play_count/v2`,
  rights: `${API_PROD}/api/mango/rights`,
  waveform: (id) => `${API_PROD}/api/gen/${id}/waveform-aggregates`,
  downbeats: (id) => `${API_PROD}/api/gen/${id}/downbeats`,
  downbeatsStream: (id) => `${API_PROD}/api/gen/${id}/downbeats_streaming/v2`,
  sections: (id) => `${API_PROD}/api/gen/${id}/novelty-sections`,
  alignedLyrics: (id) => `${API_PROD}/api/gen/${id}/aligned_lyrics/v2/`,
  downloadMp3: (id) => `${API_PROD}/api/download/clip/${id}?format=mp3`,
  downloadAny: (id, format) => `${API_PROD}/api/download/clip/${id}?format=${format}`,
  studioDownload: (id, format) => `${API_PROD}/api/studio/clip/${id}/download?format=${format}`,
  zipPrepare: `${API_PROD}/api/download/clips/zip/prepare`,
  convertWav: (id) => `${API_PROD}/api/gen/${id}/convert_wav/`,
  wavFile: (id) => `${API_PROD}/api/gen/${id}/wav_file/`,
  trash: `${API_PROD}/api/gen/trash`,
  deleteClips: `${API_PROD}/api/clips/delete/`,
  playlists: `${API_PROD}/api/playlist/me`,
  playlist: (id) => `${API_PROD}/api/playlist/v2/${id}`,
  playlistCreate: `${API_PROD}/api/playlist/create/`,
  playlistAdd: (id) => `${API_PROD}/api/playlist/v2/${id}/tracks/add`,
  playlistRemove: (id) => `${API_PROD}/api/playlist/v2/${id}/tracks/remove`,
  realtimeDiscover: `${API_PROD}/api/realtime/discover`,
};

/** POST /api/feed/v3 body for paging one user's own generations. */
export function feedV3Body({ userId, cursor = null, limit = 25, batchedOnly = true } = {}) {
  const b = { batched: batchedOnly, limit };
  if (cursor) b.cursor = cursor;
  if (userId) b.user_id = userId;
  return b;
}

/** POST /api/feed/v3 body for resolving specific clip ids in bulk. */
export function feedV3IdsBody(clipIds, limit = 50) {
  return { filters: { ids: { presence: 'True', clipIds: clipIds.slice(0, limit) } }, limit: Math.min(limit, clipIds.length) };
}

/** POST /api/download/clips/zip/prepare body. Suno itself defaults format to m4a. */
export function zipPrepareBody(clipIds, { workspaceName = null, format = 'm4a', batchId = null } = {}) {
  const body = { clip_ids: clipIds.slice(0, 200), workspace_name: workspaceName, format };
  if (batchId) body.batch_id = batchId;
  return body;
}

/** POST /api/gen/{id}/listen_milestone body for an accrued-seconds value. */
export function milestoneBody(accruedSeconds) {
  const s = [{ m: '5s', t: 5 }, { m: '30s', t: 30 }, { m: '60s', t: 60 }].filter((x) => accruedSeconds >= x.t).pop();
  return { milestone: s ? s.m : null };
}

/** Mirror of Suno's playbar_state payload; we send it so the *server* stays the
 *  authoritative backup record of how much you heard (the "reflect" tier). */
export function playbarStateBody({ clipId, queue = [], songIndex = 0, position = 0, state = 'playing', volume = 100, repeat = 'no-repeat', deviceId, deviceType = 'Unknown', contextId = 'create', contextType = 'create' }) {
  return {
    playbar_state: state,
    song_index: songIndex,
    song_play_time: round(position, 6),
    repeat_state: repeat,
    action_time: new Date().toISOString(),
    song_ids_in_queue: (queue.length ? queue : [clipId]).slice(0, 40),
    volume: round(volume, 0),
    device_id: deviceId || null,
    device_type: deviceType,
    playlist_context: null,
    device_context: null,
    context_id: contextId,
    context_type: contextType,
  };
}

/**
 * Suno's `browser-token` is a base64-wrapped `{timestamp}`; several API routes
 * 403 without it. Kept here so both the extension and the desktop app send a
 * well-formed one. (If Suno hardens this, requests fail loudly, not silently.)
 */
export function makeBrowserToken(ts = Date.now()) {
  const json = JSON.stringify({ timestamp: ts });
  return { token: b64(json), json: JSON.stringify({ token: b64(json) }) };
}
function b64(s) {
  if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(s)));
  return Buffer.from(s, 'utf8').toString('base64');
}

/* ---------------- payload parsers ---------------- */

/**
 * Suno renders clips into the Next.js RSC flight payload, so the song page you
 * already have open contains the clip object — no extra API call, no session
 * extraction. That is the most robust "what is playing right now" source.
 */
export function parseClipFromRsc(flightText) {
  if (!flightText) return null;
  const u = flightText.replace(/\\"/g, '"');
  const out = [];
  const seen = new Set();
  // Anchor on the clip id, not on the key order. The previous version required
  // the object to start with `{"status":"complete"...}`; anything that
  // serialised `id` first (a re-encoded payload, a partial RSC chunk, Suno
  // changing its serializer) yielded zero clips and the capture was saved as
  // "Untitled" with no tags.
  const re = /"id"\s*:\s*"([0-9a-fA-F-]{36})"/g;
  let m;
  while ((m = re.exec(u))) {
    const id = m[1];
    if (seen.has(id)) continue;
    const clip = enclosingClip(u, m.index, id);
    if (!clip) continue;
    seen.add(id);
    out.push(clip);
  }
  return out;
}

/** Walk outwards from an id to the nearest enclosing JSON object that is a clip. */
function enclosingClip(text, idIndex, id) {
  const floor = Math.max(0, idIndex - 4000);
  const starts = [];
  for (let i = idIndex; i >= floor; i--) if (text[i] === '{') starts.push(i);
  let tries = 0;
  for (const start of starts) {
    if (++tries > 60) break;
    const chunk = readBalanced(text, start);
    if (!chunk) continue;
    let obj;
    try { obj = JSON.parse(chunk); } catch { continue; }
    if (obj && obj.id === id && (obj.status || obj.media_urls || obj.metadata || obj.audio_url)) return obj;
  }
  return null;
}
function readBalanced(s, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

/** Decode the deterministic bits of a clip into the fields we persist. */
export function normalizeClip(c) {
  if (!c) return null;
  return {
    id: c.id,
    title: formatClipTitle(c),
    status: c.status,
    duration_s: getKnownDurationSeconds(c) ?? null,
    model_name: c.model_name ?? null,
    major_model_version: c.major_model_version ?? null,
    created_at: c.created_at ?? null,
    is_public: c.is_public ?? false,
    is_trashed: c.is_trashed ?? false,
    is_liked: c.is_liked ?? false,
    is_download_unlocked: c.is_download_unlocked ?? false,
    explicit: c.explicit ?? false,
    image_url: c.image_url ?? null,
    image_large_url: c.image_large_url ?? null,
    play_count: c.play_count ?? 0,
    upvote_count: c.upvote_count ?? 0,
    batch_id: c.batch_id ?? null,
    batch_index: c.batch_index ?? null,
    parent_clip_id: c.parent_clip_id ?? c.metadata?.continue_clip_id ?? null,
    display_tags: c.display_tags ?? null,
    metadata: c.metadata ?? {},
    audio_url: c.audio_url ?? null,
    media_urls: c.media_urls ?? [],
    visible_actions: (c.action_config?.actions || []).filter((a) => a.visible).map((a) => `${a.action_type}${a.disabled ? '(disabled)' : ''}`),
  };
}

/** /api/billing/info/ -> the quota ledger that decides whether MP3/WAV is worth it. */
export function parseDownloadQuota(billing) {
  const u = billing?.download_usage || {};
  const limit = u.current_period_downloads_limit ?? 0;
  const used = u.current_period_downloads_used ?? 0;
  const extra = u.additional_download_remaining ?? 0;
  const remaining = (limit - used > 0 ? limit - used : 0) + extra;
  return {
    period_limit: limit, period_used: used, top_ups_purchased: u.current_period_download_top_ups_purchased ?? 0,
    additional_remaining: extra, remaining, exhausted: remaining <= 0,
    policy_note: 'Direct MP3/WAV consume Suno download credits; M4A via zip/prepare and in-page capture do not.',
    plan_credits: billing?.credits ?? null,
    credit_rate_limit: billing?.credit_rate_limit ?? null,
  };
}

/**
 * Turn Suno's waveform-aggregates pyramid into peak pairs for drawing.
 * mip_map_level buckets are progressively coarser.
 */
export function waveformToPeaks(agg, targetBars = 900) {
  const levels = [...(agg?.waveform_aggregates || [])].sort((a, b) => a.mip_map_level - b.mip_map_level);
  if (!levels.length) return null;
  const pick = levels.reduce((best, l) => {
    const n = (l.min_values?.length ?? l.mini_values?.length ?? l.values?.length ?? 0);
    return Math.abs(n - targetBars) < Math.abs((best?.n ?? 0) - targetBars) ? { n, level: l } : best;
  }, null);
  const lvl = pick?.level || levels[0];
  const maxs = lvl.max_values || lvl.maxi_values || lvl.values || [];
  const mins = lvl.min_values || lvl.mini_values || [];
  const out = [];
  for (let i = 0; i < maxs.length; i++) {
    const hi = num(maxs[i]), lo = mins.length ? num(mins[i]) : -hi;
    out.push([round(clamp(hi, -1, 1), 4), round(clamp(lo, -1, 1), 4)]);
  }
  return { bars: out.length, peaks: out, mip_map_level: lvl.mip_map_level ?? 0, samples_per_bar: lvl.samples_per_chunk ?? lvl.samplesPerChunk ?? null };
}

/** Keep the loud parts of the aligned-lyrics result for the metadata sidecar. */
export function normalizeAlignedLyrics(data) {
  const lines = (data?.alignedLyrics || data?.aligned_lyrics || []);
  return lines.map((l) => ({
    start: round(num(l.startTime ?? l.start_time ?? l.start) ?? 0, 3),
    end: round(num(l.endTime ?? l.end_time ?? l.end) ?? 0, 3),
    text: String(l.text ?? l.line ?? '').slice(0, 300),
    section: l.section ?? l.sectionType ?? null,
    words: (l.words || []).map((w) => ({ t: round(num(w.startTime ?? w.start) ?? 0, 3), w: String(w.word ?? w.text ?? '').slice(0, 40) })),
  }));
}

export function normalizeSections(data) {
  const arr = data?.sections || data?.novelty_sections || data?.data || [];
  return (Array.isArray(arr) ? arr : []).map((s, i) => ({
    index: i,
    start: round(num(s.start_time ?? s.start ?? s.t0) ?? 0, 3),
    end: round(num(s.end_time ?? s.end ?? s.t1) ?? 0, 3),
    label: s.label ?? s.type ?? s.name ?? `section_${i}`,
    novelty: num(s.novelty ?? s.score) ?? null,
  })).filter((s) => s.end > s.start);
}

export function normalizeDownbeats(data) {
  const arr = data?.downbeats || [];
  return (Array.isArray(arr) ? arr : []).map((d) => (Array.isArray(d) ? { t: round(num(d[0]) ?? 0, 4), strength: num(d[1]) ?? 1 } : { t: round(num(d.time ?? d.t) ?? 0, 4), strength: num(d.strength) ?? 1 })).filter((d) => isFinite(d.t));
}


/**
 * sunolift / extension / background.js  (MV3 service worker, classic script)
 * ===========================================================================
 * Owns: Suno API access, the download-quota ledger, the export policy, curation
 * side effects, and the bridge to the desktop app ("reflect" tier).
 *
 * Two facts from the capture session drive the design:
 *  1. Suno's studio-api authenticates with **cookies only** (no Authorization
 *     header anywhere in the HAR; responses carry `access-control-allow-credentials:
 *     true` + `vary: origin`). So an extension with host permission is already
 *     logged in — there is no session to "extract". The one thing we must add is
 *     the `Origin`/`Referer` Suno's CORS layer expects, via declarativeNetRequest.
 *  2. `/api/billing/info/` reports `download_usage` (Sept-2026 policy). MP3/WAV
 *     burn that quota; in-page capture and the m4a zip path do not. So the
 *     default never touches quota, and quota formats need an explicit opt-in.
 */
/// <reference types="chrome" />
importScripts('lib/sunolift-bundle.js');
importScripts('lib/capture-store.js');
importScripts('offscreen-bridge.js');

const L = self.SUNOLIFT;
const API = L.API_PROD;
const DEVICE_KEY = 'sunolift.device_id';
const CFG_KEY = 'sunolift.config';
const LIB_KEY = 'sunolift.library';
const QUOTA_KEY = 'sunolift.quota';
const MAX_LIBRARY = 400;
const LIB_VERSION = 'sunolift.capture/1';

let dnrReady = false;

/* ------------------------------------------------------------------ *
 * origin spoof so studio-api accepts extension-origin requests       *
 * ------------------------------------------------------------------ */
async function ensureOriginRules() {
  if (!chrome.declarativeNetRequest) return;
  const id = 4101;
  const rule = {
    id,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'origin', operation: 'set', value: 'https://suno.com' },
        { header: 'referer', operation: 'set', value: 'https://suno.com/' },
      ],
    },
    condition: {
      requestDomains: ['suno.com', 'suno.ai', 'studio-api-prod.suno.com'],
      resourceTypes: ['xmlhttprequest'],
    },
  };
  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const ids = existing.map((r) => r.id);
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: ids.length ? ids : undefined,
      addRules: [rule],
    });
    dnrReady = true;
  } catch (e) {
    console.warn('[sunolift] DNR origin rule failed; API calls may 403:', e);
  }
}

/* ------------------------------------------------------------------ *
 * api client                                                         *
 * ------------------------------------------------------------------ */
async function deviceId() {
  const g = await chrome.storage.local.get(DEVICE_KEY);
  if (g[DEVICE_KEY]) return g[DEVICE_KEY];
  const id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await chrome.storage.local.set({ [DEVICE_KEY]: id });
  return id;
}

async function sunoFetch(path, { method = 'GET', body, headers = {}, raw = false, signal } = {}) {
  await ensureOriginRules();
  const url = path.startsWith('http') ? path : API + path;
  const opts = {
    method,
    credentials: 'include',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'browser-token': L.makeBrowserToken().json,
      'device-id': await deviceId(),
      ...headers,
    },
    signal,
  };
  if (body !== undefined) opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  const r = await fetch(url, opts);
  if (raw) return r;
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { __raw: text.slice(0, 400) }; }
  if (!r.ok) throw Object.assign(new Error(`${r.status} ${r.statusText} on ${path}`), { status: r.status, data });
  return data;
}

// Compatibility with older content scripts. New transfers use explicit base64.
function toBytes(v) {
  if (!v) return null;
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  const tag = Object.prototype.toString.call(v);
  if (tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]') return new Uint8Array(v);
  const valid = (n) => Number.isInteger(n) && n >= 0 && n <= 255;
  if (Array.isArray(v)) return v.every(valid) ? Uint8Array.from(v) : null;
  if (tag === '[object Object]') {
    const keys = Object.keys(v).filter((k) => k !== 'length');
    if (!keys.length || (v.length !== undefined && v.length !== keys.length)) return null;
    if (!keys.every((k, i) => k === String(i) && valid(v[k]))) return null;
    return Uint8Array.from(keys, (k) => v[k]);
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * lifecycle                                                          *
 * ------------------------------------------------------------------ */
chrome.runtime.onInstalled.addListener(async () => {
  await ensureOriginRules();
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
  chrome.alarms.create('sunolift.quota', { periodInMinutes: 30 });
  refreshQuota().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => { ensureOriginRules(); refreshQuota().catch(() => {}); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'sunolift.quota') refreshQuota().catch(() => {}); });

/* ------------------------------------------------------------------ *
 * quota ledger                                                       *
 * ------------------------------------------------------------------ */
async function refreshQuota() {
  const info = await sunoFetch('/api/billing/info/');
  const quota = L.parseDownloadQuota(info);
  await chrome.storage.local.set({ [QUOTA_KEY]: { ...quota, at: Date.now() } });
  broadcast({ type: 'quota', quota });
  return quota;
}
async function getQuota() {
  const g = await chrome.storage.local.get(QUOTA_KEY);
  if (!g[QUOTA_KEY] || Date.now() - g[QUOTA_KEY].at > 15 * 60 * 1000) { try { return await refreshQuota(); } catch { return g[QUOTA_KEY] || null; } }
  return g[QUOTA_KEY];
}

/* ------------------------------------------------------------------ *
 * library (metadata is the product as much as the audio)             *
 * ------------------------------------------------------------------ */
async function library() {
  const g = await chrome.storage.local.get(LIB_KEY);
  return Array.isArray(g[LIB_KEY]) ? g[LIB_KEY] : [];
}
async function saveLibraryEntry(rec) {
  const lib = await library();
  const i = lib.findIndex((r) => r.capture_id === rec.capture_id);
  if (i >= 0) lib[i] = { ...lib[i], ...rec }; else lib.unshift(rec);
  await chrome.storage.local.set({ [LIB_KEY]: lib.slice(0, MAX_LIBRARY) });
  broadcast({ type: 'library', library: lib.slice(0, 60) });
  return lib;
}

/* ------------------------------------------------------------------ *
 * capture finalisation                                               *
 * ------------------------------------------------------------------ */
const pending = new Map();   // captureId -> { meta, bytes[], started }
const clipCache = new Map(); // clipId -> { clip, at } — avoids re-fetching the same clip

/**
 * Fetch the full clip record from Suno's API, with a short in-memory cache.
 * The page cannot do this (httpOnly cookies); the extension's SW can.
 */
async function resolveClip(clipId) {
  if (!clipId || !/^[0-9a-f-]{36}$/.test(clipId)) return null;
  const cached = clipCache.get(clipId);
  if (cached && Date.now() - cached.at < 30 * 60 * 1000) return cached.clip;
  try {
    const c = await sunoFetch(`/api/clip/${clipId}`);
    const normalized = L.normalizeClip(c);
    clipCache.set(clipId, { clip: normalized, at: Date.now() });
    return normalized;
  } catch (e) {
    console.warn('[sunolift] resolveClip failed:', clipId, e.message);
    return null;
  }
}

async function finalizeCapture(meta, blobBytes) {
  // blobBytes may be null when the caller only wants metadata re-derived from a
  // record already in IndexedDB (e.g. retrying a failed sidecar push).
  const durS = (meta.durationMs || 0) / 1000;
  let clip = meta.clip || {};
  const identityId = (/^[0-9a-f-]{36}$/i.test(clip.id || '') && clip.id) ||
    (/^[0-9a-f-]{36}$/i.test(meta.clipId || '') && meta.clipId) || null;
  if (!clip.id && identityId) clip = { ...clip, id: identityId };
  // Safety net: if the tap could not resolve metadata for a real clip id,
  // try it now before the take is filed. The SW is authenticated; the page
  // is not.
  // Finalization is the authority boundary: resolve every real UUID, even when
  // the page already supplied a complete-looking object. Completeness does not
  // prove coherence—a transition race can combine the new clip's tags with the
  // previous Media Session title. The authenticated API/cache gives one atomic
  // record for this exact UUID.
  if (identityId) {
    const full = await resolveClip(identityId);
    if (full) {
      meta.clip = full;
      clip = full;
    }
  }
  // Preserve title-only evidence if the authenticated lookup was unavailable.
  // A non-null honest title is preferable to an entirely blank sidecar; only a
  // verified UUID is ever promoted to clip_id.
  if (!clip.title && meta.title) clip.title = meta.title;
  if (identityId && !clip.id) clip.id = identityId;
  meta.clip = clip;
  const audio = {
    bytes: blobBytes ? blobBytes.length : meta.bytes,
    mime: meta.mime, container: /mp4/.test(meta.mime || '') ? 'mp4' : 'webm',
    codec: 'opus', sample_rate: meta.sampleRate, channels: 2,
    duration_s: durS, target_lufs: meta.target_lufs,
    ui_gain: meta.ui_gain,
    had_zero_gain: Number(meta.ui_gain) === 0,
    usable: (blobBytes ? blobBytes.length : meta.bytes) > 8192,
    source: 'webaudio-tap',
    cdn_expiry: null,
    gain_timeline: meta.gain_timeline,
  };
  // If the tap fetched structural analysis (sections, downbeats, lyrics),
  // build segment-level metadata for the capture record.
  if (meta.structure && !meta.structure.error) {
    try {
      const sections = L.normalizeSections?.(meta.structure.sections) || [];
      const downbeats = L.normalizeDownbeats?.(meta.structure.downbeats) || [];
      const lyrics = L.normalizeAlignedLyrics?.(meta.structure.lyrics) || [];
      const dur = durS || null;
      const covered = (meta.listen?.covered_intervals) || [];
      audio.segments = L.buildSegmentMap({ duration: dur, covered, sections, downbeats, lyrics });
    } catch (e) {
      console.warn('[sunolift] buildSegmentMap failed:', e?.message || e);
    }
  }
  const rec = L.makeCaptureRecord({ clip, session: { capture_id: meta.captureId }, listen: meta.listen, audio, cues: [], origin: 'extension' });
  rec.curation = L.triageScore(rec);
  rec.media.cdn_expiry = null;
  rec.audio.correction_mode = meta.correction;
  rec.capture_bytes = audio.bytes;
  await saveLibraryEntry(rec);

  const cfg2 = await getConfig();

  // Playlist API latency must never delay saving the audio or its acknowledgement.
  const autoKeepAfterSave = () => {
    if (cfg2.autoKeep !== false && rec.clip_id) {
      curate({ clipId: rec.clip_id, verdict: 'keep', captureId: meta.captureId })
        .then((result) => { if (!result.ok) console.warn('[sunolift] auto-keep failed:', result.error); })
        .catch((e) => console.warn('[sunolift] auto-keep failed:', e));
    }
  };
  // hand the take to the desktop app when present; that is where loudness
  // normalisation and container conversion happen. Otherwise keep it in the
  // browser store so nothing is lost if the app is not running.
  if (cfg2.sidecar_enabled !== false) {
    const up = await pushToSidecar({ rec, blob: blobBytes, meta });
    if (up.ok) { rec.storage = { via: 'sidecar', path: up.path, files: up.files }; await saveLibraryEntry(rec); autoKeepAfterSave(); return rec; }
    rec.storage = { via: 'browser', reason: up.error };
  }
  // ALWAYS download when sidecar fails — the file MUST land on disk.
  // Fragment guard: reconcile-churn aborts mid-take and auto-capture
  // immediately re-begins, which used to ship 10 KB "songs" (a few seconds
  // of audio that passed the old >8192-byte guard). A real take of a real
  // song is never under 15 s of audio; those fragments are debris, not
  // takes — keep the library entry but do not write a file.
  const FRAGMENT_MIN_BYTES = 15 * 48000 * 2 * 2; // ~15 s stereo opus @128k ≈ 240 KB
  const isFragment = durS < 15 && blobBytes && blobBytes.length < FRAGMENT_MIN_BYTES;
  if (cfg2.auto_download !== false && blobBytes && blobBytes.length > 8192 && !isFragment) {
    try {
      const fname = filenameFor(rec, audio.container);
      await saveBytes(blobBytes, fname, `captures`);
      // Write sidecars alongside the audio so the take is never orphaned
      const base = filenameFor(rec, '').replace(/\.$/, '');
      await saveText(L.sidecarJson(rec), `${base}.json`, `captures`);
      await saveText(L.sidecarTxt(rec), `${base}.txt`, `captures`);
      await saveText(L.sidecarCue(rec, fname), `${base}.cue`, `captures`);
      rec.storage = { via: 'downloads', path: `Downloads/captures/${fname}` };
    } catch (e) {
      console.warn('[sunolift] saveBytes failed:', e);
      rec.storage = { via: 'browser', reason: 'download failed: ' + String(e?.message || e) };
    }
  } else if (blobBytes && blobBytes.length > 8192) {
    rec.storage = { via: 'browser', reason: 'auto_download disabled' };
  }
  await saveLibraryEntry(rec);
  if (rec.storage?.via === 'downloads') autoKeepAfterSave();
  notify(`Captured ${rec.song?.title || meta.clipId}`, `${durS.toFixed(0)} s take, heard ${Math.round((rec.listen_state?.coverage || 0) * 100)}% of the song`, meta.captureId);
  return rec;
}

function filenameFor(rec, ext) {
  const base = (rec.song?.title || rec.clip_id || 'suno-capture').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80).trim() || 'suno-capture';
  const d = (rec.created_at || new Date().toISOString()).slice(0, 10);
  return `${base} [${rec.clip_id ? rec.clip_id.slice(0, 8) : 'clip'}] ${d}.${ext}`;
}

// Blob URLs are owned by the offscreen document until the download completes.
const MIME_BY_EXT = {
  webm: 'audio/webm', ogg: 'audio/ogg', mp4: 'audio/mp4', m4a: 'audio/mp4',
  wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac',
  json: 'application/json', txt: 'text/plain;charset=utf-8', cue: 'text/plain;charset=utf-8', csv: 'text/csv;charset=utf-8',
};
const mimeFor = (name) => MIME_BY_EXT[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream';

async function saveBytes(bytes, filename, subdir, timeoutMs = 60000) {
  if (await ensureOffscreen()) return downloadViaOffscreen(bytes, mimeFor(filename), `${subdir}/${filename}`, timeoutMs);
  const url = `data:${mimeFor(filename)};base64,${bytesToBase64(bytes)}`;
  const id = await chrome.downloads.download({ url, filename: `${subdir}/${filename}`, saveAs: false, conflictAction: 'uniquify' });
  if (!await waitForDownload(id, timeoutMs)) throw new Error(`download ${id} did not complete`);
  return id;
}
async function saveText(text, filename, subdir, timeoutMs = 20000) {
  return saveBytes(new TextEncoder().encode(text), filename, subdir, timeoutMs);
}
function waitForDownload(id, timeoutMs) {
  const terminal = (s) => s === 'complete' || s === 'interrupted';
  return new Promise((res) => {
    let done = false;
    let to = 0;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(to);
      try { chrome.downloads.onChanged.removeListener(fn); } catch { /* never attached */ }
      res(v);
    };
    function fn(delta) {
      if (delta.id !== id || !delta.state) return;
      if (terminal(delta.state.current)) finish(delta.state.current === 'complete');
    }
    try { chrome.downloads.onChanged.addListener(fn); } catch { /* downloads API unavailable */ }
    // Ask right away: for anything under a few hundred KB the download is
    // already done by now and the event fired before we listened.
    chrome.downloads.search({ id }).then((items) => {
      const it = items && items[0];
      if (it && terminal(it.state)) finish(it.state === 'complete');
    }).catch(() => {});
    to = setTimeout(async () => {
      const items = await chrome.downloads.search({ id }).catch(() => []);
      const it = items && items[0];
      if (!it) return finish(false);
      if (it.state === 'complete') return finish(true);
      if (it.state === 'interrupted') return finish(false);
      // in_progress but bytes are moving: do not call that a failure
      finish(it.bytesReceived > 0);
    }, timeoutMs);
  });
}

function notify(title, message, id) {
  chrome.notifications.create(`sunolift.${id || Date.now()}`, { type: 'basic', title, message, iconUrl: 'icons/icon128.png', priority: 1 });
}
function broadcast(msg) {
  chrome.runtime.sendMessage({ source: 'sw', ...msg }).catch(() => {});
  for (const t of [{ url: chrome.runtime.getURL('sidepanel/sidepanel.html') }]) void t;
  chrome.tabs.query({ url: 'https://suno.com/*' }, (tabs) => {
    for (const t of tabs || []) chrome.tabs.sendMessage(t.id, msg).catch(() => {});
  });
}

/* ------------------------------------------------------------------ *
 * desktop app ("reflect" sidecar)                                    *
 * ------------------------------------------------------------------ */
async function getConfig() {
  const g = await chrome.storage.local.get(CFG_KEY);
  return { sidecar_enabled: true, auto_download: true, sidecar: 'http://127.0.0.1:8787', autoKeep: true, keepPlaylistTitle: 'GenMusicAssist Keeps', ...g[CFG_KEY] };
}
async function sidecar(path, opts = {}) {
  const failure = (error, status = 0) => ({ ok: false, status, json: async () => ({ ok: false, error }) });
  const cfg = await getConfig();
  if (cfg.sidecar_enabled === false) return failure('Desktop app integration is disabled');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const r = await fetch(`${cfg.sidecar}${path}`, { ...opts, signal: controller.signal, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
    // Consume the body inside the timeout and preserve server diagnostics.
    const data = await r.json().catch(() => null);
    if (!r.ok) return failure(`Desktop app HTTP ${r.status}: ${data?.error || path}`, r.status);
    if (!data || typeof data !== 'object') return failure(`Invalid JSON response from desktop app on ${path}`, r.status);
    return { ok: true, status: r.status, json: async () => data };
  } catch (e) {
    return failure(`Desktop app not reachable at ${cfg.sidecar}: ${e.message || e}`);
  } finally { clearTimeout(timeout); }
}
async function pushToSidecar({ rec, blob, meta }) {
  try {
    // Send a raw-clip-shaped object even when the page-side object arrived
    // late. The canonical record already contains the metadata recovered by
    // finalizeCapture; sending only `meta.clip` made the desktop sidecar turn a
    // correctly recovered extension record blank again.
    const canonicalClip = meta?.clip || {
      id: rec.clip_id || rec.song?.id || null,
      title: rec.song?.title || null,
      duration_s: rec.song?.duration_s || null,
      model_name: rec.song?.model_name || null,
      major_model_version: rec.song?.major_model_version || null,
      created_at: rec.song?.created_at || null,
      image_url: rec.song?.image_url || null,
      explicit: rec.song?.explicit ?? false,
      is_download_unlocked: rec.song?.is_download_unlocked ?? null,
      audio_url: rec.media?.audio_url || null,
      media_urls: rec.media?.media_urls || [],
      metadata: {
        duration: rec.song?.duration_s || null,
        tags: rec.song?.style_tags || null,
        gpt_description_prompt: rec.song?.style_prompt || null,
        prompt: rec.song?.lyrics || null,
        make_instrumental: rec.song?.instrumentals ?? false,
      },
    };
    // The app's /capture/meta keys on meta.captureId (camelCase) while the
    // record carries capture_id (snake_case) — without the alias the POST
    // 400s and the whole sidecar path silently degrades to "app not
    // reachable" EVEN WHEN the app is running.
    const metaRes = await sidecar('/capture/meta', { method: 'POST', body: JSON.stringify({ ...rec, captureId: rec.capture_id }) });
    if (!metaRes.ok) return await metaRes.json();
    if (blob && blob.length) {
      // mime matters: the app picks the file extension from it (mp4 vs webm).
      const audioRes = await sidecar(`/capture/audio?capture_id=${encodeURIComponent(rec.capture_id)}&mime=${encodeURIComponent(meta?.mime || rec.audio?.mime || 'audio/webm')}`, {
        method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: blob,
      });
      if (!audioRes.ok) return await audioRes.json();
    }
    // Register the take in the app's library (buildRecord → lib.save). Without
    // this the file landed in captures/ but never appeared in the review UI
    // and rec.storage.path was a guess.
    const fin = await sidecar('/capture/finalize', {
      method: 'POST',
      body: JSON.stringify({
        capture_id: rec.capture_id,
        clipId: rec.clip_id || meta?.clipId || null,
        clip: canonicalClip, listen: meta?.listen || rec.listen_state || null,
        durationMs: meta?.durationMs || 0, mime: meta?.mime || 'audio/webm;codecs=opus',
        sample_rate: meta?.sampleRate || 48000, ui_gain: meta?.ui_gain ?? null,
        gain_timeline: meta?.gain_timeline || null, target_lufs: meta?.target_lufs ?? -14,
        correction: meta?.correction || 'live',
      }),
    });
    if (!fin.ok) return await fin.json();
    const j = await fin.json().catch(() => null);
    if (!j?.ok) return { ok: false, error: `finalize failed: ${j?.error || 'unknown'}` };
    const path = j.path || `captures/${rec.capture_id}`;
    return { ok: true, path, files: [path] };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/* ------------------------------------------------------------------ *
 * curation                                                           *
 * ------------------------------------------------------------------ */
async function ensureKeepPlaylist() {
  const cfg = await getConfig();
  const title = cfg.keepPlaylistTitle || 'GenMusicAssist Keeps';
  const store = 'sunolift.playlist';
  const g = await chrome.storage.local.get(store);
  if (g[store]?.title === title && g[store].id) return g[store].id;
  const me = await sunoFetch('/api/playlist/me').catch(() => null);
  const list = me?.playlists || me?.results || [];
  const found = list.find((p) => (p.title || p.name) === title && !p.is_trashed);
  if (found) { await chrome.storage.local.set({ [store]: { id: found.id, title } }); return found.id; }
  const created = await sunoFetch('/api/playlist/create/', { method: 'POST', body: { title, is_public: false } });
  const id = created?.playlist_id || created?.id;
  if (id) await chrome.storage.local.set({ [store]: { id, title } });
  return id;
}

async function curate({ clipId, verdict, position, captureId }) {
  const out = { ok: true, clipId, verdict, at: new Date().toISOString() };
  try {
    if (verdict === 'keep') {
      const pid = await ensureKeepPlaylist();
      if (pid) await sunoFetch(`/api/playlist/v2/${pid}/tracks/add`, { method: 'POST', body: { playlist_id: pid, clip_ids: [clipId] } });
      out.playlist = pid;
      await sunoFetch(`/api/gen/${clipId}/like`, { method: 'POST', body: {} }).catch(() =>
        // older/newer spelling of the same intent; never fail the curation on it
        sunoFetch(`/api/gen/${clipId}/toggle_like`, { method: 'POST', body: {} }).catch(() => {}));
    } else if (verdict === 'drop') {
      await sunoFetch('/api/gen/trash', { method: 'POST', body: { clip_ids: [clipId], trash_state: true } });
      out.trashed = true;
    }
    // Persist the decision next to the capture so the library can filter on it.
    // The vocabulary is shared with the desktop side, where the rejected state
    // is `discard`; 'drop' is only the action name for Suno's trash endpoint,
    // and storing it left records that no filter or report matched.
    const stored = verdict === 'drop' ? 'discard' : verdict;
    const lib = await library();
    const i = lib.findIndex((r) => r.capture_id === captureId || r.clip_id === clipId);
    if (i >= 0) { lib[i].curation = { ...lib[i].curation, verdict: stored, verdict_locked: true, decided_at: out.at }; await chrome.storage.local.set({ [LIB_KEY]: lib }); }
  } catch (e) { out.ok = false; out.error = String(e.message || e); out.status = e.status; }
  return out;
}

/* ------------------------------------------------------------------ *
 * export policy                                                      *
 * ------------------------------------------------------------------ */
async function exportRequest({ clipId, captureId, format = 'm4a', forceQuota = false }) {
  const quota = await getQuota();
  const costsQuota = format === 'mp3' || format === 'wav';
  if (costsQuota && !forceQuota) {
    return {
      ok: false, costsQuota: true,
      message: `${format.toUpperCase()} download consumes Suno credits (${quota ? `${quota.remaining} left` : 'unknown'}). Choose "capture" instead, or opt in with forceQuota.`,
      quota,
    };
  }
  if (format === 'm4a') {
    const r = await sunoFetch('/api/download/clips/zip/prepare', { method: 'POST', body: L.zipPrepareBody([clipId], { format: 'm4a' }) });
    if (!r?.download_url) return { ok: false, message: 'Suno returned no download_url for the m4a zip', raw: r };
    const name = `captures/${clipId.slice(0, 8)}.zip`;
    const id = await chrome.downloads.download({ url: r.download_url, filename: name, saveAs: false, conflictAction: 'uniquify' });
    return { ok: true, kind: 'zip', downloadId: id, url: r.download_url, message: 'M4A zip queued (no quota used)' };
  }
  if (format === 'wav') {
    await sunoFetch(`/api/gen/${clipId}/convert_wav/`, { method: 'POST', body: {} }).catch(() => {});
    for (let i = 0; i < 24; i++) {
      const r = await sunoFetch(`/api/gen/${clipId}/wav_file/`).catch(() => null);
      if (r?.wav_file_url) {
        const id = await chrome.downloads.download({ url: r.wav_file_url, filename: `captures/${clipId.slice(0, 8)}.wav`, saveAs: false, conflictAction: 'uniquify' });
        return { ok: true, kind: 'wav', downloadId: id, attempts: i + 1 };
      }
      await new Promise((res) => { setTimeout(res, 5000); });
    }
    return { ok: false, message: 'Timed out waiting for the wav conversion (Suno takes up to ~2 min)' };
  }
  // mp3: Suno's own flow polls while "processing"
  for (let i = 0; i < 15; i++) {
    const r = await sunoFetch(L.ep.downloadMp3(clipId).replace(API, '')).catch((e) => ({ __error: String(e.message) }));
    if (r && r.status === 'processing') { await new Promise((res) => { setTimeout(res, 2000); }); continue; }
    const url = r?.download_url || r?.url;
    if (!url) return { ok: false, message: `No download_url for mp3 (${JSON.stringify(r).slice(0, 160)})` };
    const id = await chrome.downloads.download({ url, filename: filenameFor({ song: { title: r?.title }, clip_id: clipId }, 'mp3'), saveAs: false, conflictAction: 'uniquify' });
    return { ok: true, kind: 'mp3', downloadId: id };
  }
  return { ok: false, message: 'MP3 preparation timed out' };
}

/* ------------------------------------------------------------------ *
 * session handoff for the desktop app                                *
 * ------------------------------------------------------------------ */
async function exportSession({ confirm = false } = {}) {
  if (!confirm) return { ok: false, message: 'Pass confirm:true to hand browser cookies to the local app' };
  const jar = [];
  for (const url of ['https://suno.com', 'https://auth.suno.com', 'https://studio-api-prod.suno.com']) {
    const cs = await chrome.cookies.getAll({ url }).catch(() => []);
    jar.push(...cs.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expirationDate })));
  }
  const seen = new Set();
  const uniq = jar.filter((c) => {
    const k = `${c.name}|${c.domain}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const deviceIdStr = await deviceId();
  try {
    await sidecar('/session', { method: 'POST', body: JSON.stringify({ cookies: uniq, device_id: deviceIdStr, at: Date.now() }) });
    return { ok: true, count: uniq.length };
  } catch (e) { return { ok: false, message: String(e.message || e), count: uniq.length }; }
}

/* ------------------------------------------------------------------ *
 * reflect journal (playhead telemetry, independent of capture)       *
 * ------------------------------------------------------------------ */
const reflectBuf = [];
let reflectTimer = 0;
function reflect(ev) {
  reflectBuf.push({ ...ev, at: Date.now() });
  clearTimeout(reflectTimer);
  reflectTimer = setTimeout(async () => {
    const batch = reflectBuf.splice(0, reflectBuf.length);
    if (!batch.length) return;
    await chrome.storage.local.get('sunolift.reflect').then(async (g) => {
      const arr = [...(g['sunolift.reflect'] || []), ...batch].slice(-3000);
      await chrome.storage.local.set({ 'sunolift.reflect': arr });
    });
    pushToSidecarJournal(batch).catch(() => {});
  }, 2500);
}
async function pushToSidecarJournal(batch) {
  await sidecar('/reflect/events', { method: 'POST', body: JSON.stringify({ events: batch }) });
}

/* ------------------------------------------------------------------ *
 * message router                                                     *
 * ------------------------------------------------------------------ */
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || msg.source !== 'bridge') return;
  const tabId = sender.tab?.id;
  const reply = (data) => respond({ ok: true, data });
  switch (msg.type) {
    case 'hello': reply({ installed: true, tabId }); break;
    case 'config-set': {
      const patch = { ...msg };
      delete patch.type; delete patch.source;
      getConfig().then((cur) => chrome.storage.local.set({ [CFG_KEY]: { ...cur, ...patch } })).then(() => reply(true));
      return true;
    }
    case 'config-get': getConfig().then(reply); return true;
    case 'quota-request': getQuota().then(reply); return true;
    case 'library-request': library().then((l) => reply(l.slice(0, 80))); return true;
    case 'capture-begin': pending.set(msg.captureId, { meta: null, started: Date.now(), clipId: msg.clipId, reason: msg.reason }); reply(true); break;
    case 'capture-meta': { const p = pending.get(msg.captureId) || {}; p.meta = msg; pending.set(msg.captureId, p); reply(true); break; }
    case 'capture-data': {
      (async () => {
        if (!msg.captureId || !Number.isInteger(msg.index) || msg.index < 0) throw new Error('Invalid capture chunk');
        if (typeof msg.base64 !== 'string' || msg.base64.length > 350000) throw new Error('Capture chunk exceeds transfer limit');
        const bytes = base64ToBytes(msg.base64);
        if (!bytes.length) throw new Error('Empty capture chunk');
        await captureStore('put', `${msg.captureId}:${msg.index}`, bytes);
        reply({ ok: true, bytes: bytes.length });
      })().catch((e) => respond({ ok: false, error: e.message }));
      return true;
    }
    case 'capture-finalize': {
      (async () => {
        if (!msg.captureId || msg.meta?.captureId !== msg.captureId || !Number.isInteger(msg.chunks) || msg.chunks < 1 || msg.chunks > 4096) throw new Error('Invalid capture transfer');
        const parts = [];
        let length = 0;
        for (let i = 0; i < msg.chunks; i++) {
          const part = await captureStore('get', `${msg.captureId}:${i}`);
          if (!part?.length) throw new Error(`Capture chunk ${i} is missing; audio was not finalized`);
          parts.push(part); length += part.length;
        }
        if (length !== msg.byteLength) throw new Error(`Capture transfer incomplete: ${length}/${msg.byteLength} bytes`);
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const part of parts) { bytes.set(part, offset); offset += part.length; }
        const rec = await finalizeCapture(msg.meta, bytes);
        if (['sidecar', 'downloads'].includes(rec.storage?.via)) {
          for (let i = 0; i < msg.chunks; i++) await captureStore('delete', `${msg.captureId}:${i}`);
        }
        pending.delete(msg.captureId);
        reply(rec);
      })().catch((e) => respond({ ok: false, error: String(e.message || e) }));
      return true;
    }
    case 'milestone': reply(true); break;
    case 'relay-error': {
      // Persisted, not just logged: a console line dies with the tab, and the
      // whole point is that the next report names the handler that failed.
      (async () => {
        const key = 'sunolift.errors';
        const g = await chrome.storage.local.get(key);
        const list = Array.isArray(g[key]) ? g[key] : [];
        list.unshift({ ...msg, at: new Date().toISOString(), tab: tabId });
        await chrome.storage.local.set({ [key]: list.slice(0, 50) });
        console.error('[sunolift] relay failure relayed from the page:', msg.where, msg.message);
        reply({ ok: true, stored: true });
      })().catch(() => respond({ ok: false, error: 'could not store' }));
      return true;
    }
    case 'tap-status': {
      // Whether the page tap is attached is the single most useful health bit:
      // "recording" with no tap means the HUD is lying about a take.
      (async () => {
        const status = { attached: Boolean(msg.attached), at: Date.now(), sample_rate: msg.sampleRate || null, mime: msg.mime || null };
        await chrome.storage.local.set({ 'sunolift.tap_status': status });
        broadcast({ type: 'tap-status', status });
        reply(status);
      })().catch((e) => respond({ ok: false, error: String(e.message || e) }));
      return true;
    }
    case 'capture-pcm': {
      // one POST per ~1 s of audio; the app appends and counts gaps
      (async () => {
        try {
          // The tap posts an ArrayBuffer; a Uint8Array view survives the same
          // way but carries an offset, and `new Uint8Array(view.buffer)` would
          // silently POST the whole backing store instead of the frame.
          const body = msg.base64 !== undefined ? base64ToBytes(msg.base64) : toBytes(msg.pcm);
          if (!body?.length || body.length % ((msg.channels || 2) * 4)) { respond({ ok: false, error: 'PCM payload is empty or not whole frames' }); return; }
          const r = await sidecar(`/capture/pcm?capture_id=${encodeURIComponent(msg.captureId)}&seq=${msg.seq}&channels=${msg.channels || 2}&rate=${msg.rate || 48000}&fmt=f32le`,
            { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body });
          const j = await r.json();
          reply(j);
        } catch (e) { respond({ ok: false, error: String(e.message || e) }); }
      })();
      return true;
    }
    case 'capture-pcm-end': {
      (async () => {
        try {
          const r = await sidecar(`/capture/pcm-end?capture_id=${encodeURIComponent(msg.captureId)}`, { method: 'POST', body: JSON.stringify(msg.meta || {}) });
          if (!r) { respond({ ok: false, error: 'app not reachable' }); return; }
          reply(await r.json());
        } catch (e) { respond({ ok: false, error: String(e.message || e) }); }
      })();
      return true;
    }
    case 'clip-change': {
      // keep the last-known clip object per id so finalize can be re-run later
      const k = 'sunolift.clips';
      chrome.storage.local.get(k).then(async (g) => {
        const map = g[k] || {};
        if (msg.clip?.id) { map[msg.clip.id] = msg.clip; await chrome.storage.local.set({ [k]: map }); }
      });
      reply(true);
      break;
    }
    case 'reflect': reflect({ kind: msg.kind, clipId: msg.clipId, milestone: msg.milestone, position: msg.position, accrued: msg.accrued, tabId }); reply(true); break;
    case 'resolve-clip': {
      (async () => {
        const c = await resolveClip(msg.clipId);
        if (c) {
          // Broadcast to all pages so the tap instance for this clip can update.
          chrome.tabs.query({ url: 'https://suno.com/*' }, (tabs) => {
            for (const t of tabs || []) chrome.tabs.sendMessage(t.id, { source: 'sw', type: 'clip-resolved', clip: c }).catch(() => {});
          });
          reply({ ok: true, clip: c });
        } else {
          reply({ ok: false, error: 'resolveClip returned null' });
        }
      })().catch((e) => respond({ ok: false, error: String(e.message || e) }));
      return true;
    }
    case 'cue': {
      (async () => {
        const lib = await library();
        const i = lib.findIndex((r) => r.clip_id === msg.clipId && !r.closed);
        if (i >= 0) { (lib[i].cues ||= []).push({ t: msg.t, kind: msg.kind, note: msg.note }); await chrome.storage.local.set({ [LIB_KEY]: lib }); }
        reply({ ok: true, attached: i >= 0 });
      })();
      return true;
    }
    case 'curate': curate(msg).then(reply).catch((e) => respond({ ok: false, error: String(e.message || e) })); return true;
    case 'export-request': exportRequest(msg).then(reply).catch((e) => respond({ ok: false, error: String(e.message || e) })); return true;
    case 'session-export': exportSession(msg).then(reply).catch((e) => respond({ ok: false, error: String(e.message || e) })); return true;
    case 'api': {
      sunoFetch(msg.path, { method: msg.method || 'GET', body: msg.body })
        .then((d) => reply(d))
        .catch((e) => respond({ ok: false, error: String(e.message || e), status: e.status }));
      return true;
    }
    case 'open-panel': {
      (async () => {
        const win = await chrome.windows.getCurrent();
        await chrome.sidePanel.open({ windowId: win.id });
      })().then(() => reply(true)).catch(() => reply(false));
      return true;
    }
    case 'library-clip': {
      (async () => {
        const c = await sunoFetch(`/api/clip/${msg.clipId}`).catch(() => null);
        reply(c ? { clip: L.normalizeClip(c), diagnostics: L.mediaDiagnostics(c) } : null);
      })();
      return true;
    }
    case 'library-page': {
      (async () => {
        const d = await sunoFetch('/api/feed/v3', { method: 'POST', body: L.feedV3Body({ userId: msg.userId, cursor: msg.cursor, limit: msg.limit || 25 }) });
        const clips = (d?.clips || []).map(L.normalizeClip);
        reply({ clips, cursor: d?.cursor ?? null, hasMore: Boolean(d?.cursor) });
      })().catch((e) => respond({ ok: false, error: String(e.message || e) }));
      return true;
    }
    case 'structure': {
      (async () => {
        const [wf, sec, beat, ly] = await Promise.all([
          sunoFetch(`/api/gen/${msg.clipId}/waveform-aggregates`).catch(() => null),
          sunoFetch(`/api/gen/${msg.clipId}/novelty-sections`).catch(() => null),
          sunoFetch(`/api/gen/${msg.clipId}/downbeats`).catch(() => null),
          sunoFetch(`/api/gen/${msg.clipId}/aligned_lyrics/v2/`).catch(() => null),
        ]);
        reply({
          waveform: L.waveformToPeaks(wf),
          sections: L.normalizeSections(sec),
          downbeats: L.normalizeDownbeats(beat),
          lyrics: L.normalizeAlignedLyrics(ly),
        });
      })().catch((e) => respond({ ok: false, error: String(e.message || e) }));
      return true;
    }
    case 'sidecar-ping': {
      (async () => {
        try {
          const r = await sidecar('/ping');
          if (!r) { reply({ ok: false }); return; }
          const j = await r.json().catch(() => null);
          reply(j || { ok: false });
        } catch { reply({ ok: false }); }
      })();
      return true;
    }
    case 'reflect-log': { chrome.storage.local.get('sunolift.reflect').then((g) => reply(g['sunolift.reflect'] || [])); return true; }
    default: respond({ ok: false, error: `unknown message ${msg.type}` });
  }
  return false;
});

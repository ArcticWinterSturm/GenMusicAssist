/**
 * sunolift / extension / content / bridge.js  —  ISOLATED world
 * ===========================================================================
 * The only place with `chrome.*`. Responsibilities:
 *   - relay tap <-> service worker (page world has no chrome APIs)
 *   - hold the capture store (IndexedDB) so a tab close does not lose a take
 *   - inject the HUD + curation keys
 *   - mirror Suno's own telemetry as the backup ("reflect") record: we replay
 *     /listen_milestone and /playbar_state traffic we observe so that even if
 *     capture failed, "how much did I hear" survives on disk.
 */
(function () {
  'use strict';
  const S = 'sunolift';
  const UP = `${S}-tap`, DOWN = `${S}-ctl`;
  const send = (type, payload) => new Promise((res) => {
    try { chrome.runtime.sendMessage({ source: 'bridge', type, ...payload }, (r) => { const error = chrome.runtime.lastError; res(error ? { ok: false, error: error.message } : (r && r.data !== undefined ? r.data : r)); }); }
    catch (e) { res({ ok: false, error: e.message }); }
  });

  const st = {
    appReady: false,
    state: { clipId: null, playing: false, position: 0, duration: 0, volume: null, recording: false, bytes: 0, captureId: null, accrued: 0, milestones: [], level: null, hasElement: false, ctxState: null },
    config: { autoCapture: true, targetLufs: -14, correction: 'live', keep_playlist_title: 'GenMusicAssist Keeps', sidecar: 'http://127.0.0.1:8787' },
    buffers: new Map(),          // captureId -> {meta, parts[], received}
    pcmTransfers: new Map(),
    quota: null, hud: null, openCapture: null, library: [],
    telemetry: new Map(),        // clipId -> {milestones:Set, positions:[], lastSeen}
  };
  // Hot-reload epoch: a freshly injected bridge bumps the counter, removes the
  // previous HUD host element, and every window-level listener of the OLD
  // instance checks `mine()` before acting — so a reload never stacks two
  // HUDs or double-fires curation keys.
  const EPOCH = (window.__genmusicassistBridgeEpoch = (window.__genmusicassistBridgeEpoch || 0) + 1);
  const mine = () => window.__genmusicassistBridgeEpoch === EPOCH;

  /* ------------------------------------------------------------------ *
   * capture store (site-origin recovery copy; persists until site data is cleared)   *
   * ------------------------------------------------------------------ */
  const DB = 'sunolift';
  function idb() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open(DB, 1);
      rq.onupgradeneeded = () => {
        const d = rq.result;
        if (!d.objectStoreNames.contains('captures')) d.createObjectStore('captures', { keyPath: 'capture_id' });
        if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs', { keyPath: 'captureId' });
      };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  }
  async function putBlob(captureId, bytes) {
    try {
      const db = await idb();
      await new Promise((res, rej) => {
        const tx = db.transaction('blobs', 'readwrite');
        tx.objectStore('blobs').put({ captureId, bytes });
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
      return true;
    } catch { return false; }
  }
  async function getBlob(captureId) {
    try {
      const db = await idb();
      return await new Promise((res) => {
        const tx = db.transaction('blobs', 'readonly').objectStore('blobs').get(captureId);
        tx.onsuccess = () => res(tx.result ? new Uint8Array(tx.result.bytes) : null);
        tx.onerror = () => res(null);
      });
    } catch { return null; }
  }

  /* ------------------------------------------------------------------ *
   * page -> SW                                                         *
   * ------------------------------------------------------------------ */
  /* ------------------------------------------------------------------ *
   * page -> SW                                                         *
   * ------------------------------------------------------------------ *
   * The relay used to be one `async` listener with a 20-case switch. Any
   * throw inside any case became an "Uncaught (in promise)" rejection whose
   * only readable detail was a line number in this file — which is exactly how
   * the field report "content/bridge.js:133 (anonymous function)" arrived, with
   * no way to tell WHICH message killed the relay.
   *
   * So: one handler per message type, every handler individually guarded, and
   * every failure reported by NAME. An unknown type is a first-class error too,
   * because a tap/bridge version skew otherwise degrades into silence.
   */
  const HANDLERS = {
    async state(d) {
      Object.assign(st.state, {
        clipId: d.clipId ?? st.state.clipId, playing: d.playing, position: d.position, duration: d.duration,
        volume: d.volume, recording: d.recording, bytes: d.bytes, captureId: d.captureId, accrued: d.accrued,
        milestones: d.milestones || [], level: d.level, hasElement: true, ctxState: d.ctxState ?? st.state.ctxState,
      });
      if (d.clipId && d.playing) noteListen(d.clipId, d.position, d.accrued);
      render();
    },

    async attached(d) { send('tap-status', { attached: true, sampleRate: d.sampleRate, mime: d.mime }); },

    async 'attach-error'(d) { toast(`Could not tap the player: ${d.message}`, 'error'); },

    async 'recording-start'(d) {
      st.buffers.set(d.captureId, { parts: [], received: 0, meta: null, startedAt: Date.now(), clipId: d.clipId });
      send('capture-begin', { captureId: d.captureId, clipId: d.clipId, reason: d.reason });
      toast(d.reason === 'auto-play' || d.reason === 'play' ? 'Capturing — recording what Suno is playing' : 'Capture started');
    },

    async 'capture-chunk'(d) {
      const b = st.buffers.get(d.captureId);
      if (!b) return;                      // a chunk for a take we never saw start
      const u8 = toU8(d.bytes);
      if (!u8 || !u8.length) return;
      b.parts.push(u8);
      b.received += u8.length;
    },

    async 'capture-meta'(d) {
      const b = st.buffers.get(d.captureId);
      if (b) b.meta = d;
    },

    async 'capture-end'(d) {
      const b = st.buffers.get(d.captureId);
      if (!b) return;
      const blob = concat(b.parts);
      st.buffers.delete(d.captureId);
      if (!b.meta) { toast('Capture finished but metadata was lost', 'error'); return; }
      if (blob.length < 4096) { toast('Captured take is empty — see the HUD for why', 'error'); return; }
      // This is a local recovery copy, not a shared database with the SW.
      await putBlob(d.captureId, blob);
      b.meta.bytes = blob.length;
      let rec;
      const size = 256 * 1024;
      for (let offset = 0; offset < blob.length; offset += size) {
        const part = blob.subarray(offset, offset + size);
        const ack = await send('capture-data', { captureId: d.captureId, index: offset / size, base64: encodeBytes(part) });
        if (!ack?.ok || ack.bytes !== part.length) { rec = { error: ack?.error || 'Capture chunk was not acknowledged' }; break; }
      }
      if (!rec) rec = await send('capture-finalize', { meta: b.meta, captureId: d.captureId, byteLength: blob.length, chunks: Math.ceil(blob.length / size) });
      if (rec && rec.capture_id) {
        const where = rec.storage?.via === 'sidecar' ? 'desktop app' : rec.storage?.via === 'downloads' ? 'Downloads folder' : '⚠ NOT saved to disk';
        const detail = rec.storage?.path ? `: ${rec.storage.path}` : '';
        const saved = ['sidecar', 'downloads'].includes(rec.storage?.via);
        toast(`${saved ? 'Saved' : 'Captured but not saved'} ${rec.song?.title || rec.clip_id} (${(blob.length / 1048576).toFixed(1)} MB) → ${where}${detail}${saved ? '' : ': ' + (rec.storage?.reason || 'unknown error')}`, saved ? 'info' : 'error');
      } else if (rec && rec.error) {
        toast(`Capture finalization failed: ${rec.error}`, 'error');
      } else {
        toast('Capture finalization failed (unknown error)', 'error');
      }
      loadLibrary();
    },

    async milestone(d) {
      if (d.clipId) noteMilestone(d.clipId, d.milestone);
      send('milestone', { clipId: d.clipId, milestone: d.milestone, accrued_seconds: d.accrued_seconds });
      st.state.milestones = Array.from(new Set([...(st.state.milestones || []), d.milestone]));
      render();
    },

    async cue(d) { send('cue', d); },

    async 'clip-change'(d) {
      // Suno changed song: clear milestone pills so they don't bleed across
      // clips, then remember the record so a take started later is
      // attributed to the right clip even if the SW is asleep until then.
      st.state.clipId = d.clipId || st.state.clipId;
      st.state.milestones = [];
      if (d.clip) st.currentClip = d.clip;
      send('clip-change', { clipId: d.clipId, clip: d.clip });
      render();
    },

    async 'config-ack'(d) {
      st.config = { ...st.config, ...(d.config || {}) };
      r_cfg();
    },

    async progress(d) { st.state.bytes = d.bytes; render(); },

    async engine(d) {
      st.engine = d.engine;
      toast(d.engine === 'pcm' ? 'PCM tier active: raw frames to the desktop app' : 'Recorder tier: MediaRecorder (webm/opus)');
      render();
    },

    async 'pcm-chunk'(d) {
      const transfer = pcmTransfer(d.captureId);
      const bytes = toU8(d.pcm);
      if (!bytes?.length) {
        // Don't silently drop — the old cross-realm instanceof bug looked exactly
        // like this. Tell the user the PCM frame was unreadable and let the take
        // continue through the fallback tier.
        console.warn('[genmusicassist] PCM chunk unreadable (cross-realm? stale extension?) — frame lost');
        return;
      }
      // Serialize per take. The end message joins this same queue, so it cannot
      // overtake a slow HTTP POST. Keep the first failure and never claim success.
      transfer.tail = transfer.tail.then(async () => {
        if (transfer.error) return;
        const result = await send('capture-pcm', { captureId: d.captureId, seq: d.seq, samples: d.samples, channels: d.channels, rate: d.rate, base64: encodeBytes(bytes) });
        if (!result?.ok) {
          transfer.error = `chunk ${d.seq}: ${result?.error || 'no acknowledgement'}`;
          toast(`PCM transfer failed: ${transfer.error}`, 'error');
        }
      }).catch((e) => { transfer.error = e.message; });
      render();
    },

    async 'pcm-end'(d) {
      const transfer = pcmTransfer(d.captureId);
      await transfer.tail;
      const r = transfer.error ? { error: transfer.error } : await send('capture-pcm-end', { captureId: d.captureId, meta: d.meta });
      st.pcmTransfers.delete(d.captureId);
      st.buffers.delete(d.captureId);
      if (r?.ok && r.capture) { toast(`Saved ${r.capture.song?.title || d.clipId} (${((r.capture.audio?.bytes || 0) / 1048576).toFixed(1)} MB WAV) → ${r.wav || 'desktop app captures folder'}`); loadLibrary(); }
      else toast(`PCM handoff failed: ${r?.error || 'app not reachable'}`, 'error');
    },

    async snapshot(d) { showSnapshot(d); },

    async 'playback-error'() { toast('Playback error on the tapped element (capture kept running)', 'warn'); },

    async error(d) { toast(`Capture error: ${d.where} ${d.message}`, 'error'); },

    async installed(d) { await readyOrInstalled(d); },
    async ready(d) { await readyOrInstalled(d); },

    /** The SW could not be reached at all — say so once, loudly. */
    async 'relay-error'(d) { void d; },
  };

  function encodeBytes(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
  }
  function pcmTransfer(id) {
    if (!st.pcmTransfers.has(id)) st.pcmTransfers.set(id, { tail: Promise.resolve(), error: null });
    return st.pcmTransfers.get(id);
  }

  async function readyOrInstalled(d) {
    st.state.hasElement = Boolean(d.hasElement);
    send('hello', { page: location.pathname, hasElement: st.state.hasElement });
    render();
  }

  // window.postMessage uses structured clone. Preserve typed view byte offsets
  // and use realm-independent checks between MAIN and ISOLATED worlds.
  function toU8(v) {
    if (!v) return null;
    const tag = Object.prototype.toString.call(v);
    if (tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]') return new Uint8Array(v);
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    if (Array.isArray(v)) return Uint8Array.from(v);
    return null;
  }

  const reported = new Map();     // where -> last report ms (throttle)
  function report(where, err, extra = {}) {
    const now = Date.now();
    const last = reported.get(where) || 0;
    const detail = String((err && err.stack) || err || 'unknown error');
    // Log every occurrence (a repeated failure is information) …
    console.error(`[genmusicassist] relay failure in "${where}"`, detail, extra);
    // … but only toast / persist it once a minute per site.
    if (now - last < 60000) return;
    reported.set(where, now);
    try { toast(`Internal error in the "${where}" handler — capture continues. Details in the console.`, 'error'); } catch { /* HUD not up yet */ }
    try { send('relay-error', { where, message: detail.slice(0, 1200), ...extra }); } catch { /* SW asleep */ }
  }

  window.addEventListener('message', async (ev) => {
    const d = ev.data;
    if (!d || d.__sunolift !== true || d.dir !== 'up') return;
    if (!mine()) return;   // superseded by a newer bridge injection
    let h;
    try {
      h = Object.prototype.hasOwnProperty.call(HANDLERS, d.type) ? HANDLERS[d.type] : null;
    } catch (e) { report('relay/lookup', e, { type: String(d.type) }); return; }
    if (!h) {
      // A version skew between the page script and this bridge is the one
      // failure that otherwise looks exactly like "nothing happens".
      report('relay/unknown-type', new Error(`no handler for page message "${d.type}"`), { type: String(d.type) });
      return;
    }
    try {
      await h(d);
    } catch (err) {
      report(d.type, err, { captureId: d.captureId ?? null, clipId: d.clipId ?? null });
    }
  });

  // Anything that escapes the relay still gets a name attached to it.
  window.addEventListener('error', (e) => {
    if (!mine()) return;
    console.error('[genmusicassist] bridge uncaught:', e.message, e.error || '');
  });
  window.addEventListener('unhandledrejection', (e) => {
    if (!mine()) return;
    console.error('[genmusicassist] bridge unhandled rejection:', (e.reason && e.reason.stack) || e.reason);
  });

  function concat(parts) {
    const list = (parts || []).map(toU8).filter((p) => p && p.length);
    const total = list.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of list) { out.set(p, o); o += p.length; }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * "reflect" tier: mirror Suno's own listen telemetry                  *
   * ------------------------------------------------------------------ */
  function noteMilestone(clipId, milestone) {
    const t = st.telemetry.get(clipId) || { milestones: new Set(), positions: [] };
    t.milestones.add(milestone);
    st.telemetry.set(clipId, t);
    send('reflect', { kind: 'milestone', clipId, milestone });
  }
  function noteListen(clipId, position, accrued) {
    const t = st.telemetry.get(clipId) || { milestones: new Set(), positions: [] };
    const last = t.positions[t.positions.length - 1];
    if (!last || Math.abs(last.p - position) > 0.4) t.positions.push({ t: Date.now(), p: round(position, 3) });
    if (t.positions.length > 400) t.positions.shift();
    t.accrued = accrued;
    st.telemetry.set(clipId, t);
    if (!noteListen.throttled) {
      noteListen.throttled = setTimeout(() => { noteListen.throttled = 0; send('reflect', { kind: 'playhead', clipId, position: round(position, 3), accrued: round(accrued, 2) }); }, 5000);
    }
  }

  /* ------------------------------------------------------------------ *
   * control from the HUD / SW                                          *
   * ------------------------------------------------------------------ */
  const ctl = (type, payload) => window.postMessage({ __sunolift: true, dir: 'down', type, ...payload }, '*');

  chrome.runtime.onMessage.addListener((m) => {
    if (!m || m.source !== 'sw') return;
    if (!mine()) return;   // superseded by a newer bridge injection
    switch (m.type) {
      case 'ctl': ctl(m.command, m.payload); break;
      case 'config': st.config = { ...st.config, ...(m.config || {}) }; ctl('config', { config: st.config }); break;
      case 'quota': st.quota = m.quota; render(); break;
      case 'library': st.library = m.library || []; render(); break;
    }
  });

  /* ------------------------------------------------------------------ *
   * HUD                                                                *
   * ------------------------------------------------------------------ */
  const CSS = `
:host{all:initial}
*{box-sizing:border-box;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{
  position:fixed;right:14px;bottom:14px;z-index:2147483646;width:328px;
  background:linear-gradient(180deg,rgba(18,22,34,.72),rgba(10,12,20,.78));
  color:#eef2fa;border:1px solid rgba(255,255,255,.10);border-radius:18px;
  font-size:12px;line-height:1.5;transition:opacity .2s,transform .2s;
  backdrop-filter:blur(22px) saturate(1.35);-webkit-backdrop-filter:blur(22px) saturate(1.35);
  box-shadow:0 18px 52px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.07);
  overflow:hidden}
.wrap.min{width:222px}
.h{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.07);cursor:grab;background:linear-gradient(180deg,rgba(255,255,255,.04),transparent)}
.dot{width:9px;height:9px;border-radius:50%;background:rgba(255,255,255,.22);flex:0 0 auto;box-shadow:0 0 8px currentColor}
.dot.rec{background:#fb7185;animation:p 1.1s infinite;box-shadow:0 0 14px rgba(251,113,133,.55)}
.dot.ok{background:#4ade80;box-shadow:0 0 14px rgba(74,222,128,.4)}
.dot.warn{background:#fbbf24;box-shadow:0 0 14px rgba(251,191,36,.4)}
.dot.err{background:#fb7185;box-shadow:0 0 14px rgba(251,113,133,.5)}
@keyframes p{50%{opacity:.25}}
.t{font-weight:650;letter-spacing:.3px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:linear-gradient(90deg,#eef2fa,#b9c4e8);-webkit-background-clip:text;background-clip:text;color:transparent}
.b{
  background:rgba(255,255,255,.05);color:#e6ebf4;border:1px solid rgba(255,255,255,.12);
  border-radius:10px;padding:6px 10px;cursor:pointer;font-size:11.5px;font-weight:600;
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  transition:background .15s,border-color .15s,box-shadow .15s}
.b:hover{background:rgba(255,255,255,.10);border-color:rgba(255,255,255,.22);box-shadow:0 2px 14px rgba(0,0,0,.35)}
.b.pri{background:linear-gradient(135deg,rgba(139,124,246,.32),rgba(96,165,250,.2));border-color:rgba(167,139,250,.45)}
.b.pri:hover{border-color:rgba(167,139,250,.7);box-shadow:0 4px 18px rgba(96,165,250,.25)}
.b.dz{background:linear-gradient(135deg,rgba(251,113,133,.24),rgba(190,24,93,.16));border-color:rgba(251,113,133,.4)}
.b.dz:hover{border-color:rgba(251,113,133,.65)}
.body{padding:12px 14px;display:grid;gap:10px}
.wrap.min .body,.wrap.min .foot{display:none}
.row{display:flex;align-items:center;gap:8px}
.mono{font-variant-numeric:tabular-nums;color:rgba(147,161,189,.95)}
.bar{height:6px;border-radius:4px;background:rgba(255,255,255,.06);overflow:hidden;flex:1}
.bar>i{display:block;height:100%;background:linear-gradient(90deg,#4ade80,#60a5f5);box-shadow:0 0 10px rgba(96,165,250,.4)}
.miles{display:flex;gap:5px}
.mil{border:1px solid rgba(255,255,255,.10);border-radius:7px;padding:2px 8px;font-size:10.5px;color:rgba(147,161,189,.9);background:rgba(255,255,255,.04);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
.mil.on{background:rgba(20,80,50,.4);border-color:rgba(74,222,128,.45);color:#4ade80}
.foot{display:flex;gap:6px;padding:10px 14px;border-top:1px solid rgba(255,255,255,.07);flex-wrap:wrap;background:linear-gradient(0deg,rgba(255,255,255,.03),transparent)}
.k{border:1px solid rgba(255,255,255,.10);border-radius:6px;padding:1px 6px;font-size:10px;color:rgba(147,161,189,.8);background:rgba(255,255,255,.04)}
.small{font-size:10.5px;color:rgba(147,161,189,.75)}
.sel{background:rgba(255,255,255,.05);color:#e6ebf4;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:5px 8px;font-size:11.5px}
.toast{
  position:fixed;right:14px;bottom:calc(14px + var(--y,0px));z-index:2147483647;
  background:rgba(18,22,34,.88);color:#e6ebf4;border:1px solid rgba(255,255,255,.14);border-left:3px solid #60a5fa;
  border-radius:12px;padding:10px 14px;font:12.5px/1.45 ui-sans-serif,system-ui;
  box-shadow:0 12px 40px rgba(0,0,0,.55);animation:tin .22s;
  backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}
.toast.error{border-left-color:#fb7185}.toast.warn{border-left-color:#fbbf24}
@keyframes tin{from{transform:translateY(8px);opacity:0}}
.hidden{opacity:0;pointer-events:none}
`;

  function mount() {
    if (st.hud) return st.hud.root;
    // A previous injection's HUD (hot reload) must not linger next to ours.
    document.getElementById('sunolift-hud-host')?.remove();
    const host = document.createElement('div');
    host.id = 'sunolift-hud-host';
    const root = host.attachShadow({ mode: 'open' });
    const s = document.createElement('style'); s.textContent = CSS;
    const wrap = document.createElement('div'); wrap.className = 'wrap';
    wrap.innerHTML = `
    <div class="h"><span class="dot"></span><span class="t" data-f="hud-title">GenMusicAssist v1.0.1</span>
    <button class="b" data-a="min" title="Collapse">—</button></div>
<div class="body">
 <div class="row"><span class="mono" data-f="pos">0:00 / 0:00</span><span class="bar"><i data-f="prog"></i></span></div>
 <div class="row miles" data-f="miles"></div>
 <div class="row"><span class="mono" data-f="acc">accrued 0.0s</span><span class="mono" data-f="gain">vol —</span></div>
 <div class="row"><span class="mono" data-f="sz">—</span><span class="mono" data-f="lvl"></span></div>
 <div class="row">
   <button class="b" data-a="auto-toggle">▶ Capture: <span data-f="auto-status">ON</span></button>
   <span class="small">auto-captures every song that plays</span>
 </div>
 <div class="small" data-f="note"></div>
</div>
<div class="foot">
 <button class="b pri" data-a="rec">● Capture</button>
 <button class="b" data-a="mark">⚑ Cue</button>
 <button class="b" data-a="keep">★ Keep</button>
 <button class="b dz" data-a="drop">✕ Drop</button>
 <button class="b" data-a="export">⇩ Export</button>
 <button class="b" data-a="lib">Library</button>
 <button class="b" data-a="snap">Inspect</button>
</div>`;
    root.append(s, wrap);
    document.documentElement.appendChild(host);
    const api = { root, wrap, on: (a, fn) => wrap.querySelector(`[data-a="${a}"]`).addEventListener('click', fn) };
    st.hud = api;
    // drag
    let drag = null;
    wrap.querySelector('.h').addEventListener('pointerdown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      drag = { x: e.clientX, y: e.clientY, r: wrap.getBoundingClientRect() };
      wrap.style.transition = 'none';
    });
    window.addEventListener('pointermove', (e) => {
      if (!drag) return;
      wrap.style.right = 'auto'; wrap.style.bottom = 'auto';
      wrap.style.left = `${drag.r.left + e.clientX - drag.x}px`;
      wrap.style.top = `${drag.r.top + e.clientY - drag.y}px`;
    });
    window.addEventListener('pointerup', () => { drag = null; });
    wrap.querySelector('[data-a="min"]').addEventListener('click', () => wrap.classList.toggle('min'));
    wrap.querySelector('[data-a="auto-toggle"]').addEventListener('click', () => {
      st.config.autoCapture = !st.config.autoCapture;
      ctl('config', { config: { autoCapture: st.config.autoCapture } });
      send('config-set', { autoCapture: st.config.autoCapture });
      render();
    });
    api.on('rec', () => {
      if (st.state.recording) ctl('stop', {});
      else ctl('start', { clipId: st.state.clipId, clip: st.currentClip });
    });
    api.on('mark', () => ctl('mark', { kind: 'mark', note: `cue @${round(st.state.position, 1)}s` }));
    api.on('keep', () => curate('keep'));
    api.on('drop', () => curate('drop'));
    api.on('export', () => doExport());
    api.on('lib', () => send('open-panel', {}));
    api.on('snap', () => ctl('snapshot', {}));
    // keyboard: only when focus is not in an input, and Ctrl/Alt held so we
    // never steal Suno's own space bar
    window.addEventListener('keydown', (e) => {
      if (!mine()) return;
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (!(e.ctrlKey || e.altKey) || e.metaKey) return;
      const k = e.key.toLowerCase();
      if (k === 'k') { e.preventDefault(); curate('keep'); }
      else if (k === 'j') { e.preventDefault(); curate('drop'); }
      else if (k === 'l') { e.preventDefault(); ctl('mark', { kind: 'mark-hook', note: 'hook' }); }
      else if (k === 'r') { e.preventDefault(); st.state.recording ? ctl('stop', {}) : ctl('start', { clipId: st.state.clipId }); }
    }, true);
    return root;
  }

  const round = (v, d = 3) => { const p = 10 ** d; return Math.round((Number(v) || 0) * p) / p; };
  const fmt = (s) => (s == null || !isFinite(s)) ? '0:00' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  function render() {
    if (!st.hud) return;
    const r = st.hud.root, s = st.state;
    const dot = r.querySelector('.dot');
    dot.className = 'dot ' + (s.recording ? 'rec' : s.hasElement ? 'ok' : 'warn');
    r.querySelector('.t').textContent = s.clipId ? `${s.playing ? '▶' : '⏸'} ${s.clipId.slice(0, 8)}` : 'GenMusicAssist';
    r.querySelector('[data-f="pos"]').textContent = `${fmt(s.position)} / ${fmt(s.duration)}`;
    r.querySelector('[data-f="prog"]').style.width = `${s.duration ? Math.min(100, (s.position / s.duration) * 100) : 0}%`;
    r.querySelector('[data-f="acc"]').textContent = s.recording ? `accrued ${round(s.accrued, 1)}s (${(s.bytes / 1048576).toFixed(1)} MB)` : `accrued ${round(s.accrued, 1)}s`;
    r.querySelector('[data-f="gain"]').textContent = s.volume == null ? 'vol —' : `vol ${Math.round(s.volume * 100)}%${s.volume < 0.999 ? ' (corrected)' : ''}`;
    r.querySelector('[data-f="sz"]').textContent = s.recording ? `recording ${(s.bytes / 1048576).toFixed(1)} MB` : 'idle';
    r.querySelector('[data-f="lvl"]').textContent = s.level ? `${s.level.rms_db} dBFS${s.level.clipped ? ' ⚠clip' : ''}` : '';
    const miles = r.querySelector('[data-f="miles"]');
    miles.innerHTML = ['5s', '30s', '60s', 'completed'].map((m) => `<span class="mil ${(s.milestones || []).includes(m) ? 'on' : ''}">${m}</span>`).join('');
    const autoStatus = r.querySelector('[data-f="auto-status"]');
    if (autoStatus) {
      const on = st.config.autoCapture !== false;
      autoStatus.textContent = on ? 'ON' : 'OFF';
      autoStatus.style.color = on ? '#7ff0c4' : '#ff5c5c';
    }
    const recBtn = r.querySelector('[data-a="rec"]');
    if (recBtn) recBtn.textContent = s.recording ? '■ Stop' : '● Capture';
    const note = r.querySelector('[data-f="note"]');
    const q = st.quota;
    const issues = [];
    if (!s.hasElement) issues.push('#active-audio-play not found yet — start playback once, then Inspect');
    if (s.recording && s.bytes === 0) issues.push('no bytes after 2s: browser blocked the recorder (check tab focus/permissions)');
    if (s.ctxState === 'suspended') issues.push('audio context suspended — click ▶ on the player (user gesture needed)');
    if (s.volume === 0) issues.push('UI volume is 0: the tap sees silence. Raise the slider or use reflect mode.');
    if (q && q.exhausted) issues.push(`Suno MP3/WAV quota spent (${q.remaining} left) — capture still works and costs nothing`);
    note.textContent = issues.join(' · ');
    note.style.color = issues.length ? '#ffb454' : '#7b89a1';
  }

  function toast(msg, kind = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    (st.hud ? st.hud.root : document.documentElement).appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 4200);
  }

  function showSnapshot(d) {
    const lines = [
      `element: ${d.hasElement ? 'found' : 'MISSING'}   silent-audio present: ${d.silentElementPresent}`,
      `clip: ${d.clipId || '?'}${d.clip?.title ? ` "${d.clip.title}"` : ''}`,
      `src: ${d.src || '(MSE/blob — expected with DRM)'}`,
      `playhead: ${fmt(d.currentTime)} / ${fmt(d.duration)}  volume: ${d.volume == null ? '?' : Math.round(d.volume * 100) + '%'}  paused: ${d.paused}`,
      `accrued: ${d.accrued}s  milestones: ${(d.milestones || []).join(',') || 'none'}`,
      `ctxState: ${d.ctxState || 'no context yet'}`,
      `media_urls: ${(d.clip?.media_urls || []).map((m) => `${m.content_type}/${m.delivery}${m.encoding ? '/enc:' + m.encoding : ''}`).join(' | ') || 'none'}`,
      `audio_url: ${d.clip?.audio_url || 'none'}${d.clip?.audio_url && String(d.clip.audio_url).includes('/api/forbidden') ? '  ← sentinel; no direct download exists' : ''}`,
      `download unlocked on Suno: ${d.clip?.is_download_unlocked === undefined ? '?' : d.clip.is_download_unlocked}`,
    ];
    const w = window.open('', '_blank', 'width=780,height=600');
    if (w) {
      w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>GenMusicAssist · inspect</title><style>
        :root{--bg:#07080d;--t:#eef2fa;--d:#93a1bd;--a:#a78bfa;--bl:#60a5fa;--b:#fb7185}
        *{box-sizing:border-box;margin:0;padding:0}
        body{background:
          radial-gradient(900px 400px at 12% -8%,rgba(99,102,241,.18),transparent 60%),
          radial-gradient(700px 360px at 88% -4%,rgba(236,72,153,.12),transparent 55%),
          var(--bg);color:var(--t);font:13px/1.7 ui-monospace,Menlo,Consolas,monospace;
          min-height:100vh;padding:28px 32px}
        h2{font-size:15px;font-weight:680;letter-spacing:.3px;background:linear-gradient(90deg,#eef2fa,#b9c4e8);-webkit-background-clip:text;background-clip:text;color:transparent;margin-bottom:16px}
        pre{background:rgba(18,22,34,.55);border:1px solid rgba(255,255,255,.10);border-radius:14px;padding:18px 22px;
          backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);
          box-shadow:0 12px 36px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.06);
          white-space:pre-wrap;word-break:break-word;color:var(--t);line-height:1.75;font-size:12.5px}
        b{color:var(--bl);font-weight:600}
        .ok{color:#4ade80}.warn{color:#fbbf24}.err{color:#fb7185}
        .muted{color:var(--d)}
        .pill{display:inline-block;border:1px solid rgba(255,255,255,.10);border-radius:7px;padding:1px 8px;font-size:10px;color:var(--d);background:rgba(255,255,255,.04)}
      </style></head><body>
      <h2>GenMusicAssist · inspect</h2><pre>${lines.join('\n').replace(/</g,'&lt;')}</pre>
      <p class="muted" style="margin-top:18px;font-size:11px">Hot-reload epoch: ${window.__genmusicassistEpoch || 0} · bridge epoch: ${window.__genmusicassistBridgeEpoch || 0}</p>
      </body></html>`);
      w.document.close();
    }
    toast('Snapshot written to a new tab');
  }

  async function curate(verdict) {
    if (!st.state.clipId) { toast('Nothing is loaded to curate', 'warn'); return; }
    const r = await send('curate', { clipId: st.state.clipId, verdict, position: round(st.state.position, 3), captureId: st.state.captureId });
    toast(verdict === 'keep' ? `Kept → playlist "${st.config.keep_playlist_title}"` : 'Marked for trash', verdict === 'keep' ? 'info' : 'warn');
    if (r && r.advanced) ctl('start', {});
    loadLibrary();
  }

  async function doExport() {
    const r = await send('export-request', { clipId: st.state.clipId, captureId: st.state.captureId });
    if (r && r.ok) toast(r.message || 'Export queued');
    else toast((r && r.message) || 'Export failed', 'error');
  }

  function r_cfg() {
    if (!st.hud) return;
    const autoStatus = st.hud.root.querySelector('[data-f="auto-status"]');
    if (autoStatus) {
      const on = st.config.autoCapture !== false;
      autoStatus.textContent = on ? 'ON' : 'OFF';
      autoStatus.style.color = on ? '#7ff0c4' : '#ff5c5c';
    }
  }

  async function loadLibrary() {
    const l = await send('library-request', {});
    if (Array.isArray(l)) { st.library = l; render(); }
  }

  (async function init() {
    mount(); render();
    const c = await send('config-get', {});
    if (c) { st.config = { ...st.config, ...c }; ctl('config', { config: st.config }); }
    const q = await send('quota-request', {});
    if (q) st.quota = q;
    // Hot-reload: the manifest-declared content scripts are re-injected by
    // Chrome automatically on every browser restart, so a page running the
    // old code simply disappears when the SW restarts. The epoch counter in
    // each instance handles live reloads. Nothing more to do here.
    // Tell the page script where the worklet module lives and whether the app is
    // up - it decides between the PCM tier and MediaRecorder.
    const ping = await send('sidecar-ping', {});
    st.appReady = Boolean(ping && ping.ok !== false);
    ctl('config', { config: { ...st.config, workletUrl: chrome.runtime.getURL('content/pcm-worklet.js'), appReady: st.appReady } });
    loadLibrary();
    // If the user landed directly on /song/{id} and it is already playing,
    // the play listener has already fired. Nudge the tap once.
    setTimeout(() => ctl('snapshot', {}), 1200);
  })();

  window.__sunolift = { get state() { return st.state; }, ctl, send, getBlob, config: st.config };
})();

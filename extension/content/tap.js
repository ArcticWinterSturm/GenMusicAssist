/**
 * sunolift / extension / content / tap.js   —  runs in the PAGE (world: MAIN)
 * ===========================================================================
 * Audacity-style capture of exactly what Suno is playing, without caring what
 * the volume slider says, and with real metadata about how much was heard.
 *
 * WHY THIS ATTACHES TO THE <audio> ELEMENT
 * Suno's player (v6, Sept 2026) renders one stable element:
 *     <audio id="active-audio-play" crossOrigin="anonymous">
 * The src is filled in by their Mango DRM service worker (the CDN object is
 * AES-CTR ciphertext, so there is no file to grab any more). But the *decoded*
 * signal is right here, and `crossOrigin="anonymous"` means the media is
 * CORS-clean, so AudioContext may read it without tainting. That is the only
 * capture point that is immune to the media-format changes that broke the
 * published exporters.
 *
 * WHY THE RECORDING IS VOLUME-INVARIANT
 * Chrome's MediaElementAudioSourceNode delivers audio *after* the element's
 * own `volume` is applied. Suno's slider drives exactly that property. So we
 * insert a compensating GainNode (1 / element.volume, smoothed) between the
 * source and both the recorder and the speakers. Move Suno's slider to 3% or
 * 100% and the recorded file is the same loudness; the slider we mirror keeps
 * the *speakers* at whatever level you chose. A compressor sits in front of the
 * recorder so a take that was captured at 5% (i.e. lifted +26 dB, noise
 * included) cannot clip. The gain timeline is stored in the capture metadata, so
 * the desktop app can re-derive the correction offline, sample-accurately, if
 * you prefer `correction:"offline"`.
 *
 * WHY A SECOND, SILENT ELEMENT MATTERS
 * Suno also keeps `<audio id="silent-audio">` alive (background-audio lease).
 * If we attached to that instead we would "successfully" record digital
 * silence, which is exactly the shape of the "it recorded but the file is empty"
 * bug reports. We only ever bind `#active-audio-play`.
 */

(function () {
  'use strict';
  const L = globalThis.SUNOLIFT || {};
  // Hot-reload epoch: a freshly injected instance bumps the counter; every
  // older instance sees the mismatch and stops scheduling work, so an
  // extension reload takes over live tabs WITHOUT a page refresh.
  const EPOCH = (window.__genmusicassistEpoch = (window.__genmusicassistEpoch || 0) + 1);
  const mine = () => window.__genmusicassistEpoch === EPOCH;
  const S = 'sunolift';
  const AUDIO_ID = 'active-audio-play';
  const SILENT_ID = 'silent-audio';
  const MSG = { UP: `${S}-tap`, DOWN: `${S}-ctl` };

  const st = {
    bound: null,            // the element we attached to
    ctx: null, gain: null, comp: null, recDest: null, analyser: null, rec: null,
    chunks: [], chunkBytes: 0,
    timeline: L.GainTimeline ? new L.GainTimeline() : null,
    acc: null,
    clipId: null, clip: null,
    recording: false, armed: false, captureId: null, startedAt: 0,
    lastPost: 0, rate: 1, mutedByPolicy: false,
    config: {
      autoCapture: true, targetLufs: -14, correction: 'live', maxRecordMs: 15 * 60 * 1000,
      sampleRate: 48000, headroomDb: -1, engine: 'auto', workletUrl: null, appReady: false,
    },
    pcm: { active: false, seq: 0, node: null, bytes: 0, failed: false },
  };

  /* ------------------------------------------------------------------ *
   * plumbing                                                            *
   * ------------------------------------------------------------------ */
  function post(type, payload) {
    try { window.postMessage({ __sunolift: true, dir: 'up', type, ...payload }, '*'); } catch { /* page navigated */ }
  }
  const dbg = (...a) => { if (st.config.verbose) console.debug('[sunolift]', ...a); };

  function audioEl() {
    const el = document.getElementById(AUDIO_ID);
    return el && el.tagName === 'AUDIO' ? el : null;
  }

  /** MediaStreamDestination is only reachable over a MediaStream; pick the best container. */
  function pickMime() {
    const c = ['audio/webm;codecs=opus,webm-audio', 'audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4;codecs=opus'];
    for (const m of c) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
    return '';
  }

  /* ------------------------------------------------------------------ *
   * network observer — clip identity from Suno's own traffic           *
   * ------------------------------------------------------------------ *
   * DOM class hooks (.playing / [class*="isPlaying"]) drift with every
   * Suno redesign, and every DOM fallback eventually degenerates into
   * "first row in list order" — which pinned a whole session's takes on
   * one old song at the top of the library. Suno's own traffic cannot
   * lie: the page POSTs playbar_state with song_ids_in_queue +
   * song_index, and fetches media with item_id=<uuid>. Watch both, keep
   * the clip records that ride along in the JSON, and let the clip-id
   * resolvers consult this evidence BEFORE any DOM sweep.
   */
  const net = { clips: new Map(), queueClip: null, queueState: null, queuePosition: null, queueAt: 0, itemHint: null, itemAt: 0, requested: new Map(), queue: [], queueIndex: 0 };
  const UUID_SRC = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const isUuid = (v) => typeof v === 'string' && new RegExp(`^${UUID_SRC}$`, 'i').test(v);
  const NET_ITEM_RE = new RegExp(`[?&]item_id=(${UUID_SRC})`, 'i');

  function ingestJsonText(text) {
    if (!text || typeof text !== 'string' || text.length < 2) return;
    let data;
    try { data = JSON.parse(text); } catch { /* RSC flight / non-JSON chunk */ return; }
    try {
      const seen = new Set(); const stack = [data]; let visited = 0;
      while (stack.length && visited < 4000 && net.clips.size < 600) {
        const v = stack.pop();
        if (!v || typeof v !== 'object') continue;
        if (seen.has(v)) continue;
        seen.add(v);
        if (!Array.isArray(v) && isUuid(v.id) &&
            ('status' in v || 'media_urls' in v || 'audio_url' in v || 'model_name' in v || (v.metadata && typeof v.metadata === 'object'))) {
          const prev = net.clips.get(v.id);
          // a "complete"/"streaming" record always beats a stale "submitted" one
          if (!prev || (prev.status === 'submitted' && v.status !== 'submitted') || ((v.media_urls || []).length > (prev.media_urls || []).length)) net.clips.set(v.id, v);
          continue;
        }
        visited++;
        if (Array.isArray(v)) { for (const x of v) stack.push(x); continue; }
        for (const k of Object.keys(v)) {
          if (k === 'waveform' || k === 'waveform_aggregates' || k === 'aligned_lyrics') continue;
          const x = v[k];
          if (x && typeof x === 'object') stack.push(x);
        }
      }
    } catch { /* never break the page */ }
  }

  function ingestRequestUrl(url, bodyText) {
    try {
      const m = String(url || '').match(NET_ITEM_RE);
      if (m && isUuid(m[1])) {
        net.itemHint = m[1]; net.itemAt = Date.now();
        net.requested.set(m[1], Date.now());
      }
      if (bodyText && /playbar_state/.test(String(url || ''))) {
        const b = JSON.parse(bodyText);
        const queue = Array.isArray(b?.song_ids_in_queue) ? b.song_ids_in_queue.filter(isUuid) : [];
        if (queue.length) {
          const idx = Number.isInteger(b?.song_index) ? Math.max(0, Math.min(b.song_index, queue.length - 1)) : 0;
          net.queue = queue; net.queueIndex = idx;
          net.queueClip = queue[idx];
          net.queueState = String(b?.playbar_state || '').toLowerCase() || null;
          net.queuePosition = Number.isFinite(Number(b?.song_play_time)) ? Number(b.song_play_time) : null;
          net.queueAt = Date.now();
        }
      }
    } catch { /* never break playback */ }
  }

  /**
   * The clip Suno itself says is playing. The playbar_state POST is the
   * authoritative signal (fresh queue index, posted every few seconds);
   * the item_id= media request is second (fires at track start, but may
   * also prefetch the NEXT track near the end of the current one — hence
   * its shorter trust window).
   */
  function networkActiveClipId() {
    const now = Date.now();
    // At the instant a new song starts, its media request can precede the next
    // periodic playbar_state update. Prefer that newer request only near the
    // start of playback; later in a song it may be a prefetch for the next one.
    const el = audioEl();
    const nearStart = el && Number(el.currentTime) < 12;
    if (nearStart && net.itemHint && isUuid(net.itemHint) && now - net.itemAt < 20000 && net.itemAt > net.queueAt) return net.itemHint;
    if (net.queueClip && isUuid(net.queueClip) && now - net.queueAt < 90000) return net.queueClip;
    if (net.itemHint && isUuid(net.itemHint) && now - net.itemAt < 20000) return net.itemHint;
    return null;
  }

  function installNetworkObserver() {
    // The content script can be hot-reloaded while the page stays open.  The
    // wrappers installed by the first instance must feed the NEW instance's
    // maps; otherwise the old epoch goes inert and every later take loses the
    // one authoritative source of clip identity.
    const observeResource = (name) => {
      const m = String(name || '').match(NET_ITEM_RE);
      if (!m || !isUuid(m[1])) return;
      net.itemHint = m[1]; net.itemAt = Date.now(); net.requested.set(m[1], net.itemAt);
    };
    window.__genmusicassistNetSink = { ingestJsonText, ingestRequestUrl, observeResource };
    if (window.__genmusicassistNetHooked) return;
    window.__genmusicassistNetHooked = true;
    try {
      const origFetch = window.fetch;
      if (typeof origFetch === 'function') {
        window.fetch = function (input, init) {
          let url = '';
          try {
            url = typeof input === 'string' ? input : (input && input.url) || '';
            const body = init?.body;
            if (typeof body === 'string') window.__genmusicassistNetSink?.ingestRequestUrl(url, body);
            else if (body instanceof URLSearchParams) window.__genmusicassistNetSink?.ingestRequestUrl(url, body.toString());
            else if (body instanceof Blob) body.text().then((t) => window.__genmusicassistNetSink?.ingestRequestUrl(url, t)).catch(() => {});
            else if (!init?.body && typeof Request !== 'undefined' && input instanceof Request) {
              input.clone().text().then((t) => window.__genmusicassistNetSink?.ingestRequestUrl(url, t)).catch(() => {});
            }
          } catch { /* arg shapes vary */ }
          const p = origFetch.apply(this, arguments);
          try {
            p.then((resp) => {
              try {
                const ct = resp.headers.get('content-type') || '';
                if (/json|text/i.test(ct)) resp.clone().text().then((t) => window.__genmusicassistNetSink?.ingestJsonText(t)).catch(() => {});
              } catch { /* consumed body */ }
            }).catch(() => {});
          } catch { /* thenable shim missing */ }
          return p;
        };
      }
    } catch (e) { dbg('fetch hook failed', e); }
    try {
      if (window.XMLHttpRequest) {
        const X = window.XMLHttpRequest.prototype;
        const origOpen = X.open, origSend = X.send;
        X.open = function (method, url) { this.__sunoliftUrl = String(url || ''); return origOpen.apply(this, arguments); };
        X.send = function (body) {
          try {
            if (typeof body === 'string') window.__genmusicassistNetSink?.ingestRequestUrl(this.__sunoliftUrl, body);
            else if (body instanceof URLSearchParams) window.__genmusicassistNetSink?.ingestRequestUrl(this.__sunoliftUrl, body.toString());
            else if (body instanceof Blob) body.text().then((t) => window.__genmusicassistNetSink?.ingestRequestUrl(this.__sunoliftUrl, t)).catch(() => {});
            this.addEventListener('load', () => {
              try {
                if (this.responseType === '' || this.responseType === 'text' || this.responseType === 'json') {
                  window.__genmusicassistNetSink?.ingestJsonText(this.responseType === 'json' && this.response ? JSON.stringify(this.response) : this.responseText);
                }
              } catch { /* ignore */ }
            });
          } catch { /* ignore */ }
          return origSend.apply(this, arguments);
        };
      }
    } catch (e) { dbg('xhr hook failed', e); }
    // Suno v6 sends playbar_state (and some telemetry) via navigator.sendBeacon
    // — neither the fetch nor the XHR hook sees those, which left the observer
    // blind on exactly the signal that cannot lie about what is playing.
    try {
      if (navigator.sendBeacon) {
        const origBeacon = navigator.sendBeacon.bind(navigator);
        navigator.sendBeacon = function (url, data) {
          try {
            const u = String(url || '');
            if (typeof data === 'string') window.__genmusicassistNetSink?.ingestRequestUrl(u, data);
            else if (data instanceof URLSearchParams) window.__genmusicassistNetSink?.ingestRequestUrl(u, data.toString());
            else if (data && typeof Blob !== 'undefined' && data instanceof Blob) data.text().then((t) => window.__genmusicassistNetSink?.ingestRequestUrl(u, t)).catch(() => {});
            else if (data && (data instanceof ArrayBuffer || ArrayBuffer.isView(data))) {
                try { window.__genmusicassistNetSink?.ingestRequestUrl(u, new TextDecoder().decode(data)); } catch { /* not text */ }
            }
          } catch { /* never break the page */ }
          return origBeacon(url, data);
        };
      }
    } catch (e) { dbg('beacon hook failed', e); }
    // Resource timing survives requests made before document_idle and also sees
    // media loads made below application-level fetch wrappers.  Keep only the
    // most recent item_id as a short-lived hint; playbar_state remains stronger.
    try {
      for (const e of performance.getEntriesByType('resource')) observeResource(e.name);
      const po = new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__genmusicassistNetSink?.observeResource(e.name); });
      po.observe({ type: 'resource', buffered: true });
      window.__genmusicassistResourceObserver = po;
    } catch { /* resource timing unavailable */ }
  }

  /* ------------------------------------------------------------------ *
   * the graph                                                          *
   * ------------------------------------------------------------------ */
  function attach(el) {
    if (st.bound === el && st.ctx && st.srcNode) return true;
    // Disconnect our processing chain nodes but NEVER close the context or
    // the MediaElementSource — they are a bound pair for the element's lifetime.
    try { st.pcm.node && st.pcm.node.port && st.pcm.node.port.close(); } catch { /* ok */ }
    st.pcm.node = null; st.pcm.active = false;
    try { st.gain && st.gain.disconnect(); } catch { /* ok */ }
    try { st.comp && st.comp.disconnect(); } catch { /* ok */ }
    try { st.analyser && st.analyser.disconnect(); } catch { /* ok */ }
    try { st.recDest && st.recDest.disconnect(); } catch { /* ok */ }
    try { st.tapNode && st.tapNode.disconnect(); } catch { /* ok */ }
    st.tapNode = null;
    st.gain = st.comp = st.analyser = st.recDest = st.rec = null;
    st.bound = null;

    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx || !el) return false;
      const sr = st.config.sampleRate || 48000;

      // AudioContext + MediaElementSource are a bound pair for the element's
      // lifetime. Creating a new context for an already-sourced element throws
      // ("already connected previously to a different MediaElementSourceNode"),
      // and connecting a source from one context to nodes in another throws
      // ("cannot connect to an AudioNode belonging to a different audio context").
      // Cache both on the element — and when a cache from a PREVIOUS injection
      // exists (hot reload), ADOPT its context instead of making a new one.
      let src = el.__genmusicassistMediaSource;
      if (src) {
        if (st.ctx && st.ctx !== src.context) { try { st.ctx.close(); } catch { /* ok */ } }
        st.ctx = src.context;
      } else if (!st.ctx) {
        st.ctx = new Ctx({ sampleRate: sr });
        src = st.ctx.createMediaElementSource(el);
        el.__genmusicassistMediaSource = src;
      } else {
        src = st.ctx.createMediaElementSource(el);
        el.__genmusicassistMediaSource = src;
      }
      st.gain = st.ctx.createGain();
      st.gain.gain.value = computeCompensation(el.volume);
      st.comp = st.ctx.createDynamicsCompressor();
      st.comp.threshold.value = -1.5; st.comp.knee.value = 0; st.comp.ratio.value = 20;
      st.comp.attack.value = 0.002; st.comp.release.value = 0.05;
      st.analyser = st.ctx.createAnalyser();
      st.analyser.fftSize = 2048;
      st.recDest = st.ctx.createMediaStreamDestination();
      st.tapNode = null;
      src.connect(st.gain);
      st.gain.connect(st.comp);
      st.comp.connect(st.recDest);
      st.comp.connect(st.analyser);
      // analyser → destination keeps the Web Audio graph "active" so audio
      // actually flows to recDest. Without a path to destination, Chrome
      // may suspend the graph and MediaRecorder gets zero bytes.
      st.analyser.connect(st.ctx.destination);
      // PCM tier (raw frames to the desktop app). Best fidelity, needs the app.
      if (wantsPcm(st.config) && st.config.workletUrl) attachWorklet(st.ctx, st.comp).catch(() => { st.pcm.failed = true; });
      st.bound = el;
      st.srcNode = src;
      dbg('attached', el.id, st.ctx.sampleRate);
      post('attached', { clipId: st.clipId, sampleRate: st.ctx.sampleRate, mime: pickMime() });
      return true;
    } catch (e) {
      console.warn('[genmusicassist] attach failed', e);
      post('attach-error', { message: String(e && e.message || e) });
      return false;
    }
  }

  function detach() {
    // Only disconnect processing chain nodes. NEVER close the context or
    // null out the source — they are a bound pair for the element's lifetime.
    try { st.pcm.node && st.pcm.node.port && st.pcm.node.port.close(); } catch { /* ok */ }
    st.pcm.node = null; st.pcm.active = false;
    try { st.gain && st.gain.disconnect(); } catch { /* ok */ }
    try { st.comp && st.comp.disconnect(); } catch { /* ok */ }
    try { st.analyser && st.analyser.disconnect(); } catch { /* ok */ }
    try { st.recDest && st.recDest.disconnect(); } catch { /* ok */ }
    try { st.tapNode && st.tapNode.disconnect(); } catch { /* ok */ }
    st.tapNode = null;
    st.gain = st.comp = st.analyser = st.recDest = st.rec = null;
    st.bound = null;
  }

  /**
   * 1/element.volume, with headroom and a sane ceiling. At volume 0 the signal
   * arriving at us is silence - no math recovers that, so we refuse to
   * compensate and flag the take instead of writing a silent file.
   */
  function computeCompensation(vol) {
    const v = Number(vol);
    if (!isFinite(v) || v <= 0.001) return 1;
    const head = Math.pow(10, (st.config.headroomDb ?? -1) / 20);
    return Math.min(1 / v, Math.pow(10, 24 / 20)) * (v < 1 ? head : 1);
  }

  /* ------------------------------------------------------------------ *
   * audio-context lifecycle                                            *
   * ------------------------------------------------------------------ */
  function ensureContext() {
    if (st.ctx) return st.ctx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    st.ctx = new Ctx({ sampleRate: st.config.sampleRate || 48000 });
    return st.ctx;
  }
  // Start the recorder once the context is running. Chrome only resumes an
  // AudioContext inside a user gesture, so the rAF loop must NOT call this
  // when ctx is suspended — it arms an auto-capture instead (see loop()).
  function startRecorder(reason) {
    const usePcm = st.pcm.node && !st.pcm.failed && wantsPcm(st.config);
    const give_up = (where, message) => {
      st.starting = false;
      st.recording = false;              // never leave a phantom take behind
      st.abortStart = true;
      st.pcm.active = false;
      try { st.recDest && st.recDest.stream.getAudioTracks().forEach((t) => { t.enabled = false; }); } catch { /* no graph yet */ }
      post('error', { where, message });
      dbg('start aborted', where, message);
    };
    const go = () => {
      if (!mine()) return;
      if (st.abortStart) { st.abortStart = false; st.starting = false; st.recording = false; return; }
      // Do not start on a context that is not running: that is the silent-take
      // generator. (A PCM worklet fed by a suspended context delivers nothing,
      // and MediaRecorder on a suspended graph emits no data at all.)
      if (st.ctx && st.ctx.state !== 'running') {
        give_up('ctx.resume', `audio context is ${st.ctx.state} — a take started now would be empty. Click play on the player (Chrome needs a user gesture), then capture again.`);
        return;
      }
      try {
        if (usePcm) st.pcm.node.port.postMessage({ type: 'start', captureId: st.captureId });
        else if (st.rec) st.rec.start(1000);
        st.recording = true;             // only now
        st.starting = false;
        post('recording-start', { captureId: st.captureId, clipId: st.clipId, reason, mime: pickMime() || 'default', sampleRate: st.ctx ? st.ctx.sampleRate : st.config.sampleRate });
        dbg('recording start', st.clipId, reason);
      } catch (e) {
        st.rec = null;
        give_up('rec.start', String(e && e.message || e));
      }
    };
    if (st.ctx && st.ctx.state === 'suspended') {
      // resume() outside a user gesture may NEVER resolve — time it out and
      // say so instead of leaving the take silently stuck.
      const to = setTimeout(() => {
        if (st.recording) return;
        give_up('ctx.resume', 'timed out — click play on the player once (Chrome needs a gesture), then retry');
      }, 3500);
      Promise.resolve(st.ctx.resume())
        .then(() => { clearTimeout(to); go(); })
        .catch((e) => { clearTimeout(to); give_up('ctx.resume', String(e && e.message || e)); });
    } else {
      go();
    }
  }
  function sampleGain(el) {
    const t = st.ctx ? st.ctx.currentTime : (performance.now() / 1000);
    const g = el.muted ? 0 : (isFinite(el.volume) ? el.volume : 1);
    st.timeline?.add(t, g);
    if (st.gain) {
      const target = computeCompensation(g);
      // setTargetAtTime avoids the zipper noise you get from assigning .value
      st.gain.gain.setTargetAtTime(target, t, 0.02);
    }
    return g;
  }

  /**
   * Which capture tier this take should use.
   *
   * This helper existed but was never called: both `attach()` and `begin()`
   * tested `st.config.appReady !== false` instead, so the `engine` setting in
   * the options panel did nothing at all. Worse, the tier silently flipped to
   * PCM the moment the desktop app answered, mid-session, with no user cue.
   * `pcm` and `mediarecorder` are now pinning choices; `auto` (default) takes
   * lossless frames whenever the app is up.
   */
  const pcmTakes = new Map();
  const wantsPcm = (cfg) => cfg.engine === 'pcm' || (cfg.engine === 'auto' && cfg.appReady === true);

  async function attachWorklet(ctx, comp) {
    await ctx.audioWorklet.addModule(st.config.workletUrl);
    const node = new AudioWorkletNode(ctx, 'sunolift-tap', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, processorOptions: { active: false } });
    node.port.onmessage = (ev) => {
      const d = ev.data;
      const take = pcmTakes.get(d?.captureId);
      if (!take) return;
      if (d.type === 'pcm') {
        take.bytes += d.buffer.byteLength;
        if (d.captureId === st.captureId) st.pcm.bytes = take.bytes;
        post('pcm-chunk', { captureId: d.captureId, seq: d.seq, samples: d.samples, channels: d.channels, rate: d.rate, peak: d.peak, pcm: d.buffer });
      } else if (d.type === 'flushed' && take.snap) {
        take.snap.pcmBytes = take.bytes;
        flushPcm(take.snap);
        pcmTakes.delete(d.captureId);
      }
    };
    comp.connect(node);
    st.pcm.node = node;
    st.tapNode = node;
    post('engine', { engine: 'pcm' });
    return node;
  }

  /* ------------------------------------------------------------------ *
   * record control                                                     *
   * ------------------------------------------------------------------ */
  function begin(clipId, clip, reason) {
    if (!mine()) return;                       // superseded by a newer injection
    if (st.recording || st.starting) return;
    const el = audioEl();
    if (!el) return;
    // A Suno queue tickover briefly selects the NEXT UUID while the MSE media
    // element is still 0:00/0:00 (and can even emit `play`). The HAR proves
    // Suno calls this state `paused`; recording it creates a zero-byte phantom
    // take immediately before the real capture. Gate every entry point here,
    // including onPlay(), so no caller can bypass the handoff invariant.
    const gate = L.captureStartGate ? L.captureStartGate({
      duration: el.duration,
      currentTime: el.currentTime,
      readyState: el.readyState,
      ended: el.ended,
      clipId,
      networkClipId: net.queueClip,
      networkState: net.queueState,
      networkAgeMs: Date.now() - net.queueAt,
      identityPending: net.itemHint === clipId && net.itemAt > net.queueAt,
    }) : { ok: Number.isFinite(Number(el.duration)) && Number(el.duration) > 0 && el.readyState >= 3 && !el.ended };
    if (!gate.ok) {
      st.armed = true;
      dbg('capture start deferred', gate.reason, { clipId, duration: el.duration, readyState: el.readyState, queueState: net.queueState });
      return;
    }
    if (!attach(el)) return;
    st.starting = true;                        // cleared in startRecorder()'s go()/failure paths
    st.abortStart = false;
    st.captureId = `cap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    st.chunks = []; st.chunkBytes = 0;
    st.timeline = L.GainTimeline ? new L.GainTimeline() : null;
    st.startedAt = Date.now();
    st.clipId = clipId;
    // A title-only record is useful and honest when Suno temporarily hides the
    // UUID.  Dropping the visible/media-session title here turned a safe
    // anonymous take into a completely blank sidecar.
    st.clip = clip || provisionalClip(clipId, el);
    if (L.ListenAccumulator && !st.acc) {
      st.acc = new L.ListenAccumulator((m, a, accrued) => {
        post('milestone', { milestone: m, action: a, accrued_seconds: round(accrued, 3), clipId });
      });
    }
    const usePcm = st.pcm.node && !st.pcm.failed && wantsPcm(st.config);
    st.engine = usePcm ? 'pcm' : 'mediarecorder';
    if (usePcm) {
      st.pcm.active = true; st.pcm.seq = 0; st.pcm.bytes = 0;
      pcmTakes.set(st.captureId, { bytes: 0, snap: null });
    }
    const mime = pickMime();
    if (!usePcm) {
      try {
        st.rec = new MediaRecorder(st.recDest.stream, mime ? { mimeType: mime, audioBitsPerSecond: 128000 } : undefined);
      } catch (e) {
        post('error', { where: 'MediaRecorder', message: String(e && e.message || e) });
        return;
      }
    }
    if (!usePcm) {
      // PER-RECORDER ISOLATION. The handlers close over THIS recorder and its
      // own chunk array. stop() is asynchronous: the recorder's final chunk
      // fires after end() — and often after begin() for the NEXT song has
      // already reset the shared st.chunks. With the old shared-st handlers
      // that late chunk landed at the head of the next take's file: the file
      // began with the tail of the previous song and the EBML header sat
      // kilobytes in — VLC showed undefined duration and playback jumped
      // "backwards in time". The snapshot rides on the recorder instance too,
      // so onstop finalises exactly its own take, nothing else.
      const rec = st.rec;
      const recChunks = [];
      rec.__sunoliftChunks = recChunks;
      rec.ondataavailable = (ev) => {
        if (!ev.data || !ev.data.size) return;
        recChunks.push(ev.data);
        st.chunkBytes += ev.data.size;
        post('progress', { bytes: st.chunkBytes, ms: Date.now() - st.startedAt });
      };
      rec.onstop = () => flush(rec);
    }
    // `recording` is claimed by startRecorder() AFTER the recorder is really
    // running. Claiming it here is what produced the wedged HUD: a suspended
    // AudioContext never resumes, no bytes ever arrive, and the UI sat on
    // "recording 0.0 MB" with an inert Stop button (constraint C1 residual).
    st.recDest.stream.getAudioTracks().forEach((t) => { t.enabled = true; });
    startRecorder(reason);
  }

  function end(reason) {
    if (!st.recording && !st.starting) return;
    if (st.starting && !st.recording) {
      st.abortStart = true; st.starting = false;
      pcmTakes.delete(st.captureId);
      return;
    }
    st.recording = false;
    st.starting = false;
    st.endReason = reason;
    // ONE snapshot, shared by both tiers. Everything downstream reads the
    // snapshot, never the live `st.*` fields: begin() for the next song resets
    // them, and both tiers finalise asynchronously (onstop for MediaRecorder,
    // an explicit acknowledgement for the worklet tail). Reading live state there is how a
    // clip change used to discard the previous take (constraint C3).
    const snap = {
      chunks: st.chunks, chunkBytes: st.chunkBytes, startedAt: st.startedAt || Date.now(),
      captureId: st.captureId, clipId: st.clipId, clip: st.clip,
      timeline: st.timeline, acc: st.acc, engine: st.engine,
      pcmBytes: st.pcm.bytes, endReason: reason,
      sampleRate: st.ctx?.sampleRate || st.config.sampleRate,
      uiGain: audioEl() ? (audioEl().muted ? 0 : audioEl().volume) : null,
      targetLufs: st.config.targetLufs,
      correction: st.config.correction,
      structure: st.structure || null,
    };
    if (st.engine === 'pcm') {
      snap.endedAt = Date.now();
      const take = pcmTakes.get(snap.captureId);
      if (take) take.snap = snap;
      try { st.pcm.node.port.postMessage({ type: 'stop', captureId: snap.captureId }); }
      catch (e) { post('error', { where: 'PCM stop', message: String(e.message || e) }); }
      st.pcm.active = false;
      // The audio thread acknowledges its tail; no timer can stand in for that.
      st.startedAt = 0;
      return;
    }
    st.chunks = []; st.chunkBytes = 0; st.startedAt = 0;
    const recorder = st.rec;
    const hasRecorder = recorder && typeof recorder.stop === 'function';
    try {
      if (hasRecorder) {
        // Recorder.stop() completes asynchronously. Bind this take's metadata
        // to THIS recorder exactly as we already bind its chunks; a shared
        // st.__flush slot is overwritten when auto-capture starts/stops the
        // next song before this onstop event arrives.
        recorder.__sunoliftSnap = snap;
        recorder.stop();
      }
      else if (snap.chunkBytes > 0) flush({ __sunoliftSnap: snap, __sunoliftChunks: snap.chunks || [] });
      else { /* nothing was ever captured: say nothing */ }
    } catch { flush({ __sunoliftSnap: snap, __sunoliftChunks: recorder?.__sunoliftChunks || snap.chunks || [] }); }
    // Do NOT detach — keep the audio graph alive for the next song.
    st.rec = null;
    dbg('recording end', reason);
  }

  /** PCM path: the app owns the file, we only send the metadata it needs. */
  function flushPcm(snap) {
    const { captureId, clipId, clip, acc, timeline } = snap;
    if (acc) acc.markCompleted?.();
    const listen = acc ? acc.toJSON(L.getKnownDurationSeconds ? L.getKnownDurationSeconds(clip || {}) : null) : null;
    post('pcm-end', {
      captureId, clipId, reason: snap.endReason,
      meta: {
        captureId, clipId, clip: minimalClip(clip), listen,
        durationMs: snap.endedAt - snap.startedAt, bytes: snap.pcmBytes, mime: 'audio/wav',
        sampleRate: snap.sampleRate, channels: 2,
        gain_timeline: timeline?.toJSON ? timeline.toJSON() : null,
        ui_gain: snap.uiGain, correction: 'offline', target_lufs: snap.targetLufs,
        source: 'webaudio-pcm-worklet',
        structure: snap.structure || null,
      },
    });
  }

  /** Ship the take as metadata + blob bytes in 1 MiB slices (message-size safe).
   *  Takes the recorder explicitly: each recorder's onstop closes over its own
   *  instance, so a late stop finalises exactly its own take even if the next
   *  song's begin() has already run. */
  async function flush(rec) {
    // The recorder's OWN chunks are the truth. Reading the shared st.chunks
    // here is what let a previous take's final async chunk bleed into the
    // head of the next take's file (EBML header mid-file, "backwards" audio).
    const chunks = rec ? (rec.__sunoliftChunks || []) : st.chunks;
    const snap = rec ? rec.__sunoliftSnap : null;
    const startedAt = snap ? snap.startedAt : st.startedAt;
    const captureId = snap ? snap.captureId : st.captureId;
    let clipId = snap ? snap.clipId : st.clipId;
    let clip = snap ? snap.clip : st.clip;
    const timeline = snap ? snap.timeline : st.timeline;
    const acc = snap ? snap.acc : st.acc;
    const endReason = snap ? snap.endReason : st.endReason;
    if (rec) { rec.__sunoliftSnap = null; rec.__sunoliftChunks = null; }
    st.chunks = [];
    const el = audioEl();
    const duration = Date.now() - startedAt;
    // close out the listen first so `completed` is inside the record we serialise
    if (acc) acc.markCompleted?.();
    const listen = acc ? acc.toJSON(L.getKnownDurationSeconds ? L.getKnownDurationSeconds(clip || {}) : null) : null;
    const blob = new Blob(chunks, { type: pickMime() || 'audio/webm' });
    // NOTE: We deliberately do NOT re-read the page here to "fix" attribution.
    // The take began with a clip id captured at begin() time, and the audio
    // content matches THAT clip. Re-attributing to whatever song happens to
    // be playing when flush() runs would mis-label a perfectly good take
    // (e.g. take recorded song A, but page auto-advanced to song B by the
    // time onstop fired). The findClipIdFromPage() fix + tick() reconcile
    // handle the streaming-session freeze; this path must not override them.
    const meta = {
      captureId, clipId,
      clip: minimalClip(clip || null),
      listen, durationMs: duration, bytes: blob.size,
      mime: blob.type, sampleRate: snap?.sampleRate || (st.ctx ? st.ctx.sampleRate : st.config.sampleRate),
      channels: 2,
      gain_timeline: timeline && timeline.toJSON ? timeline.toJSON() : null,
      ui_gain: snap ? snap.uiGain : (el ? (el.muted ? 0 : el.volume) : null),
      correction: snap?.correction || st.config.correction,
      endReason: endReason || 'manual',
      target_lufs: snap?.targetLufs ?? st.config.targetLufs,
      structure: snap?.structure || null,
    };
    post('capture-meta', meta);
    // stream the bytes; the bridge relays to the SW (and through it, the app)
    const buf = new Uint8Array(await blob.arrayBuffer());
    const CH = 1 << 20;
    for (let i = 0; i < buf.length; i += CH) {
      post('capture-chunk', { captureId, index: i / CH, bytes: buf.slice(i, i + CH) });
      await new Promise((r) => { setTimeout(r, 0); });
    }
    post('capture-end', { captureId, total: buf.length });
    // Do NOT detach — keep the audio graph alive for the next song.
    st.rec = null;
  }

  function minimalClip(c) {
    if (!c) return null;
    return {
      id: c.id, title: c.title, status: c.status, audio_url: c.audio_url, media_urls: c.media_urls,
      model_name: c.model_name, major_model_version: c.major_model_version, created_at: c.created_at,
      is_download_unlocked: c.is_download_unlocked, explicit: c.explicit, image_url: c.image_url,
      metadata: { tags: c.metadata?.tags, duration: c.metadata?.duration, prompt: (c.metadata?.prompt || '').slice(0, 4000), gpt_description_prompt: c.metadata?.gpt_description_prompt, task: c.metadata?.task, disable_volume_normalization: c.metadata?.disable_volume_normalization, make_instrumental: c.metadata?.make_instrumental },
      action_config: c.action_config,
    };
  }

  /** Current Media Session metadata is maintained by Suno's player itself. */
  function mediaSessionClip() {
    try {
      const m = navigator.mediaSession?.metadata;
      if (!m) return null;
      const title = String(m.title || '').replace(/\s+/g, ' ').trim();
      const haystack = [m.title, m.artist, m.album, ...(m.artwork || []).map((a) => a?.src)].filter(Boolean).join(' ');
      const id = haystack.match(new RegExp(UUID_SRC, 'i'))?.[0] || null;
      if (!title && !id) return null;
      return { id, title: title || undefined, image_url: m.artwork?.at?.(-1)?.src || m.artwork?.[0]?.src || null, __from: 'media-session' };
    } catch { return null; }
  }

  function provisionalClip(clipId, el = audioEl()) {
    const ms = mediaSessionClip();
    const active = document.querySelector?.('.playing, [class*="isPlaying"], [data-playing="true"], [aria-current="true"]');
    const uuid = isUuid(clipId) ? clipId : null;
    // A Media Session title is coherent with a UUID only when Media Session
    // exposes that same UUID. During auto-advance its title can lag behind the
    // network/player identity by several seconds.
    const mediaTitle = !uuid || ms?.id === uuid ? ms?.title : null;
    const title = mediaTitle || (active ? rowTitle(active) : '') || null;
    const duration = el && isFinite(el.duration) && el.duration > 0 ? el.duration : null;
    return {
      id: uuid || ms?.id || null, title,
      duration_s: duration, image_url: ms?.image_url || null,
      metadata: duration ? { duration } : {}, __from: ms ? 'media-session' : 'provisional',
    };
  }

  function anonymousTrackId(clip, el = audioEl()) {
    const title = String(clip?.title || 'unknown');
    const dur = el && isFinite(el.duration) ? Math.round(el.duration) : 0;
    let h = 2166136261;
    for (const ch of `${title}|${dur}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return `anon_${(h >>> 0).toString(16).padStart(8, '0')}`;
  }

  /**
   * Ask the extension (which IS authenticated via cookies) to fetch the full
   * clip record from Suno's API. The page itself cannot — the session cookies
   * are httpOnly. Without this, MSE-blob clips are filed as "Untitled" with
   * no tags, prompt, or lyrics.
   *
   * We fire-and-retry: the first resolve often races the SW waking from idle,
   * so a single missed response would leave the take orphaned.
   */
  function resolveClip(clipId) {
    if (!clipId || !/^[0-9a-f-]{36}$/.test(clipId)) return;
    if (st._resolving === clipId) return;
    st._resolving = clipId;
    post('resolve-clip', { clipId });
    setTimeout(() => { if (st._resolving === clipId) { st._resolving = null; resolveClip(clipId); } }, 4000);
  }

  /**
   * After clip resolution, optionally fetch structural analysis (sections,
   * downbeats, lyrics alignment) so the saved take has segment-level
   * metadata. Non-fatal: structure endpoints can fail; we still save the
   * clip's core metadata.
   */
  function resolveStructure(clipId) {
    if (!clipId || !/^[0-9a-f-]{36}$/.test(clipId)) return;
    post('resolve-structure', { clipId });
  }

  /* ------------------------------------------------------------------ *
   * clip discovery: read the clip Suno itself rendered into the page   *
   * ------------------------------------------------------------------ */
  function currentClipFromPage() {
    const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
    const UUID_RE = new RegExp(`^${UUID}$`);
    const SONG_RE = new RegExp(`/song/(${UUID})`);

    // 0) SUNO'S OWN TRAFFIC FIRST — same evidence hierarchy as
    //    findClipIdFromPage(): the playbar queue / media requests cannot be
    //    fooled by DOM layout, and the reconcile loop in tick() depends on
    //    this function never hallucinating "the first row in the library".
    const netId = networkActiveClipId();
    if (netId) {
      const c = net.clips.get(netId);
      const normalized = c ? (L.normalizeClip ? L.normalizeClip(c) : c) : null;
      // Keep identity fields atomic: never attach a possibly stale Media
      // Session title to a UUID learned from a different source.
      return { ...(normalized || {}), id: netId, title: normalized?.title, __from: 'network' };
    }

    // Media Session is owned by the player and does not suffer from list-order
    // ambiguity.  It often exposes the UUID through artwork URLs; even without
    // one it preserves the correct human title for an anonymous take.
    const media = mediaSessionClip();
    if (media?.id) return media;

    // 1) ACTIVE ROW FIRST — must prefer the playing track over the rest of
    //    the library list.
    const active = document.querySelector('.playing, [class*="isPlaying"], [data-playing="true"], [aria-current="true"]');
    if (active) {
      // audiopipe item_id= in the active subtree (most specific signal)
      const activeNodes = [active, ...(active.querySelectorAll('*') || [])];
      for (const n of activeNodes) {
        for (const attr of n.attributes || []) {
          const m = attr.value && attr.value.match(new RegExp(`item_id=(${UUID})`));
          if (m) return { id: m[1], title: rowTitle(active) || undefined, __from: 'active-itemid' };
        }
      }
      // /song/<uuid> link inside or wrapping the active row
      const songLink = active.querySelector?.('a[href*="/song/"]') || active.closest?.('a[href*="/song/"]');
      if (songLink) {
        const hrefMatch = songLink.getAttribute('href')?.match(SONG_RE);
        if (hrefMatch) {
          const title = rowTitle(active);
          return { id: hrefMatch[1], title: title || undefined, __from: 'active-href' };
        }
      }
      // data-clip-id on the active row itself
      const id = active.getAttribute?.('data-clip-id') || (active.id && active.id.replace(/^clip-/, ''));
      if (id && UUID_RE.test(id)) {
        return { id, title: rowTitle(active) || undefined, __from: 'active-data' };
      }
    }

    // 2) the route is authoritative only on an individual /song/{id} page.
    const m = location.pathname.match(SONG_RE);
    if (m) return { id: m[1], __from: 'route' };
    return media;
  }

  /** The visible name of a song row, in the row's own language. */
  function rowTitle(n) {
    const a = n.querySelector?.('a[href*="/song/"]') || n.querySelector?.('a');
    const raw = (a && a.textContent) || '';
    const t = String(raw).replace(/\s+/g, ' ').trim();
    if (t && t.length <= 140) return t;
    // Some layouts render the title as the row's only text node.
    const own = [...(n.childNodes || [])].filter((c) => c.nodeType === 3).map((c) => c.textContent).join(' ');
    const t2 = String(own).replace(/\s+/g, ' ').trim();
    return t2 && t2.length <= 140 ? t2 : '';
  }

  /**
   * Clip-id recovery for MSE playback (constraint C2). The <audio> element's
   * src is an opaque blob:, but Suno's own DOM still names the clip: the
   * player row / song cards carry media URLs of the form
   *   https://audiopipe.suno.ai/?item_id=<uuid>&format=webm...
   * (verified against a real session HAR, 2026-09-13). Scan every attribute
   * of the playing row (href, src, style, aria, data-*) for that pattern.
   */
  function findClipIdFromPage() {
    try {
      const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
      const UUID_RE = new RegExp(`^${UUID}$`);
      const SONG_RE = new RegExp(`/song/(${UUID})`);
      const ITEM_RE = new RegExp(`item_id=(${UUID})`);

      // Extract a clip id from a single node and its descendants (attributes +
      // /song/ links + data-clip-id). Returns null if nothing matches.
      function fromNode(node) {
        if (!node) return null;
        const nodes = [node, ...(node.querySelectorAll('*') || [])];
        for (const n of nodes) {
          // audiopipe item_id= is the most specific signal — prefer it
          for (const attr of n.attributes || []) {
            const m = attr.value && attr.value.match(ITEM_RE);
            if (m) return m[1];
          }
        }
        const songLink = node.querySelector?.('a[href*="/song/"]');
        if (songLink) {
          const href = songLink.getAttribute('href') || '';
          const m = href.match(SONG_RE);
          if (m) return m[1];
        }
        const id = node.getAttribute?.('data-clip-id') || (node.id && node.id.replace(/^clip-/, ''));
        if (id && UUID_RE.test(id)) return id;
        return null;
      }

      // 0) SUNO'S OWN TRAFFIC FIRST — the playbar_state POST carries
      //    song_ids_in_queue + song_index, and the media request carries
      //    item_id=<uuid>. Neither can be fooled by DOM layout, and both
      //    update the instant the track flips. This is what stops the
      //    "everything is attributed to the first row in the library"
      //    failure mode for good.
      const netId = networkActiveClipId();
      if (netId) return netId;

      // 1) ACTIVE/PLAYING ROW FIRST — the only authoritative DOM source.
      const active = document.querySelector('.playing, [class*="isPlaying"], [data-playing="true"], [aria-current="true"]');
      if (active) {
        const id = fromNode(active);
        if (id) return id;
      }

      // 2) Media Session artwork frequently embeds the current clip UUID.
      const mediaId = mediaSessionClip()?.id;
      if (mediaId && UUID_RE.test(mediaId)) return mediaId;

      // 3) /song/{id} route names the clip directly.
      const route = location.pathname.match(SONG_RE);
      if (route) return route[1];

      // NO whole-DOM sweep. The old `document.documentElement.innerHTML`
      // item_id= regex returned the FIRST hit in DOM order — on the library
      // page that is the top row of the list, not the playing track. That
      // fallback is what pinned an entire session on one library row
      // (always the top of the list, never the playing track).
      // When nothing above matched we return null: auto-capture then
      // synthesises a blob_ id and promotes it later, which is strictly
      // better than attributing the take to the wrong song.
      return null;
    } catch { return null; }
  }

  /**
   * Full clip objects live in the React/RSC payload. Rather than guessing at
   * Suno's internals, we match the element's own src to a clip id and ask the
   * extension to fetch the record from the API - but we can also read the
   * inlined payload, which costs nothing:
   */
  function scanFlightPayload(clipId) {
    try {
      const scripts = document.querySelectorAll('script');
      for (const s of scripts) {
        const t = s.textContent || '';
        if (t.length > 400 && t.includes(clipId) && t.includes('media_urls')) {
          const list = L.parseClipFromRsc ? L.parseClipFromRsc(t) : null;
          const hit = (list || []).find((c) => c.id === clipId);
          if (hit) return hit;
        }
      }
    } catch (e) { dbg('flight scan failed', e); }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * event wiring                                                       *
   * ------------------------------------------------------------------ */
  let rafId = 0;
  let gainTimer = 0;
  function loop() {
    rafId = requestAnimationFrame(loop);
    if (!mine()) {
      // A newer injection owns the page now: drop our processing chain (do NOT
      // close the context — the new instance adopts it) and go inert.
      if (st.bound) detach();
      return;
    }
    tick();
  }
  // rAF does not run in hidden tabs, but Suno keeps playing — auto-capture,
  // clip-change detection and accrual must survive background listening.
  // The interval only fires when hidden, so it never double-runs with rAF.
  setInterval(() => { if (mine() && document.hidden) tick(); }, 1000);
  function tick() {
    const el = audioEl();
    if (!el) return;
    const now = performance.now();
    // MSE players fire a spurious `ended` when they rebuffer or detach the
    // media source mid-song. Treat the element as playing if the playhead is
    // advancing and is NOT near the end, regardless of what el.ended reports.
    const dur = isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
    const isNearEnd = dur > 0 && (dur - el.currentTime) < 3;
    const isPlaying = !el.paused && el.readyState > 2 && (!el.ended || !isNearEnd);
    // Make sure the AudioContext exists early so we can read its state.
    if (!st.ctx && st.bound) ensureContext();
    if (now - st.lastPost > 200) {
      st.lastPost = now;
      sampleGain(el);
      const rate = Number(el.playbackRate) || 1;
      st.rate = rate;
      const level = st.analyser && L.meterFromTimeDomain ? (() => {
        const td = new Float32Array(st.analyser.fftSize);
        st.analyser.getFloatTimeDomainData(td);
        return L.meterFromTimeDomain(td);
      })() : null;
      post('state', {
        clipId: st.clipId, playing: isPlaying, position: el.currentTime, duration: el.duration,
        volume: el.muted ? 0 : el.volume, rate, recording: st.recording,
        // Live size of the take, whatever tier is feeding it. The PCM tier
        // accumulates in st.pcm.bytes, so reporting st.chunkBytes here showed
        // "recording 0.0 MB" for every lossless take — the exact symptom the
        // field reports describe, while audio was flowing perfectly.
        bytes: st.engine === 'pcm' ? st.pcm.bytes : st.chunkBytes,
        captureId: st.captureId, accrued: st.acc ? round(st.acc.accruedSeconds, 2) : 0,
        milestones: st.acc ? [...st.acc.fired] : [], level,
        ctxState: st.ctx ? st.ctx.state : null,
      });
    }
    if (st.acc) st.acc.tick(el.currentTime, isPlaying, Date.now(), st.rate || 1);
    // Detect clip change via src/duration/currentTime signals — MSE blob
    // URLs don't carry the clip ID, so onPlay()'s regex can't catch this.
    // Without this, the recording, milestones and accrued all bleed across
    // songs when Suno auto-plays the next library entry.
    if (st.lastSrc || st.lastDuration) {
      const srcChanged = st.lastSrc && el.currentSrc && st.lastSrc !== el.currentSrc;
      const timeReset = st.lastTime > 8 && el.currentTime < 2;
      const durChanged = st.lastDuration > 0 && el.duration > 0 && Math.abs(st.lastDuration - el.duration) > 1.5;
      if (srcChanged || (timeReset && durChanged)) {
        if (st.recording) end('clip-change');
        // Try to extract a real clip id from the route; for MSE blob URLs
        // generate a fresh id so the new song is attributed correctly.
        const routeMatch = location.pathname.match(/\/song\/([0-9a-f-]{36})/);
        const newSrc = el.currentSrc || el.src || '';
        if (routeMatch) {
          st.clipId = routeMatch[1];
        } else if (newSrc.startsWith('blob:') || srcChanged) {
          // Prefer the REAL clip id from the page DOM (item_id= in the player
          // row's media URLs); only fall back to a synthetic id when the page
          // genuinely hides it.
          const pageClip = currentClipFromPage() || provisionalClip(null, el);
          st.clipId = findClipIdFromPage() || anonymousTrackId(pageClip, el);
          // Resolve the real clip from Suno's API so we get title, tags,
          // prompt, lyrics — even when the route is opaque (MSE blob URLs).
          if (/^[0-9a-f-]{36}$/.test(st.clipId)) resolveClip(st.clipId);
        } else {
          // src changed but carried no id: keep the current attribution rather
          // than inventing one. (No-op self-assignment removed.)
        }
        st.clip = currentClipFromPage() || provisionalClip(st.clipId, el);
        if (L.ListenAccumulator) {
          st.acc = new L.ListenAccumulator((m, a, accrued) => {
            post('milestone', { milestone: m, action: a, accrued_seconds: round(accrued, 3), clipId: st.clipId });
          });
        }
        st.startedAt = 0; // rAF begin() will set it
        post('clip-change', { clipId: st.clipId, clip: minimalClip(st.clip) });
        dbg('clip-change detected via signal', st.clipId);
      }
    }
    st.lastSrc = el.currentSrc || el.src;
    st.lastTime = el.currentTime;
    st.lastDuration = el.duration;
    // Mid-take promotion: if we started on a synthetic blob_ id (the page
    // could not name the clip at begin() time), re-resolve every ~2.5 s and
    // adopt the real uuid the moment the observer / active row can name it.
    // Without this the take keeps the blob_ id forever: filename "blob_muc…",
    // zero metadata, and finalizeCapture skips its own re-resolve because the
    // id is not a real clip id.
    const wall = Date.now();
    if (st.clipId && /^(?:blob|anon)_/.test(String(st.clipId)) && wall - (st._lastResolve || 0) > 2500) {
      st._lastResolve = wall;
      const real = findClipIdFromPage();
      if (real && isUuid(real) && real !== st.clipId) {
        const raw = net.clips.get(real);
        const clipObj = raw ? (L.normalizeClip ? L.normalizeClip(raw) : raw) : null;
        // adopt WITHOUT ending the take: the audio recorded so far belongs to
        // this clip; only the attribution was missing.
        st.clipId = real;
        st.clip = clipObj || st.clip;
        if (st.engine === 'pcm') { /* pcmTakes keyed by captureId — unaffected */ }
        // Keep the accumulator: this is an identity promotion for the SAME
        // audio, not a track transition. Resetting here erased the seconds
        // heard before the UUID appeared.
        if (clipObj) post('clip-change', { clipId: real, clip: minimalClip(clipObj), why: 'mid-take-resolve' });
        else resolveClip(real);
        dbg('mid-take promotion', st.clipId);
      }
    }
    // Hydrate clip metadata when the API record arrives after the take started.
    if (st.clipId && isUuid(st.clipId) && wall - (st._lastHydrate || 0) > 4000) {
      st._lastHydrate = wall;
      if (!st.clip || !st.clip.title || !(st.clip.media_urls || []).length) {
        const raw = net.clips.get(st.clipId);
        const c = (raw ? (L.normalizeClip ? L.normalizeClip(raw) : raw) : null) || scanFlightPayload(st.clipId);
        if (c && (c.title || (c.media_urls || []).length)) {
          st.clip = c;
          post('clip-change', { clipId: st.clipId, clip: minimalClip(c), why: 'hydrate' });
        }
      }
    }

    // Auto-capture: only start if the context is running. If it's suspended,
    // Chrome requires a user gesture to resume — begin() handles that via
    // startRecorder(), but we should only call it when the graph is live.
    // If no clip id has been set yet (MSE blob URLs hide it), synthesize one
    // so auto-capture can actually start. onPlay() does this too, but the
    // element may already be playing when the script loads.
    if (st.config.autoCapture && isPlaying && !st.recording) {
      if (!st.clipId && st.lastSrc && st.lastSrc.startsWith('blob:')) {
        st.clip = provisionalClip(null, el);
        st.clipId = anonymousTrackId(st.clip, el);
        post('clip-change', { clipId: st.clipId, clip: minimalClip(st.clip) });
      }
      if (st.clipId) {
        // Pull the REAL clip object (title, prompt, tags, media_urls) from
        // the page or the network observer's cache whenever we can — the
        // saved file must say the real title, not "Untitled".
        if (!st.clip || !st.clip.id || st.clip.id !== st.clipId) {
          const raw = net.clips.get(st.clipId);
          const fromNet = raw ? (L.normalizeClip ? L.normalizeClip(raw) : raw) : null;
          st.clip = (fromNet || scanFlightPayload(st.clipId) || currentClipFromPage() || st.clip);
        }
        // If the page couldn't name it, ask the SW to fetch it from the API.
        if (/^[0-9a-f-]{36}$/.test(st.clipId) && (!st.clip || !st.clip.title || !st.clip.metadata?.tags)) {
          resolveClip(st.clipId);
        }
        // A SUSPENDED context cannot feed the worklet — begin() would repeat
        // the 0-byte-take failure. Only start when the graph is live (the
        // gesture handlers resume it), or when we are on the MediaRecorder
        // tier where resume happens inside startRecorder().
        const canRecord = !st.ctx || st.ctx.state === 'running' || (!st.pcm.node && st.bound);
        if (canRecord) begin(st.clipId, st.clip, 'auto-play');
      }
    }
    if (st.config.maxRecordMs && st.recording && Date.now() - st.startedAt > st.config.maxRecordMs) end('max-duration');
    // PERIODIC PAGE RECONCILE: Suno v6 reuses the same MSE blob URL across
    // tracks on the library page, so the srcChanged signal in the detector
    // above can stay false even after the song flips. Every ~2 s while
    // recording, re-read the page; if the active row names a DIFFERENT clip
    // than what we recorded, STOP the current take (so audio doesn't bleed
    // across songs) and let the auto-capture cycle start a fresh take for
    // the new track.
    if (st.recording && st.clipId && now - (st._lastReconcile || 0) > 2000) {
      st._lastReconcile = now;
      const live = currentClipFromPage();
      // Only network/player evidence may roll over a take. Once such a source
      // supplies a different UUID, that identity change is definitive; song
      // duration must not veto it. Suno commonly generates adjacent tracks at
      // nearly identical target lengths (the reported failure is 3:04 -> 3:02).
      const rollover = live && (L.shouldRolloverCapture
        ? L.shouldRolloverCapture(st.clipId, live.id, live.__from)
        : ((live.__from === 'network' || String(live.__from || '').startsWith('active-')) && live.id && live.id !== st.clipId));
      if (rollover) {
        dbg('tick: periodic reconcile found new clip', st.clipId, '->', live.id, live.title);
        if (st.recording) end('clip-change');
        st.clipId = live.id;
        const raw = net.clips.get(live.id);
        st.clip = (raw ? (L.normalizeClip ? L.normalizeClip(raw) : raw) : null) || live;
        if (L.ListenAccumulator) {
          st.acc = new L.ListenAccumulator((m, a, accrued) => {
            post('milestone', { milestone: m, action: a, accrued_seconds: round(accrued, 3), clipId: st.clipId });
          });
        }
        st.startedAt = 0;
        if (/^[0-9a-f-]{36}$/.test(live.id)) resolveClip(live.id);
        post('clip-change', { clipId: live.id, clip: minimalClip(st.clip), reconcile: true });
      }
    }

    // Last-resort rollover signal: Media Session follows the actual bottom
    // player even when Suno reuses one blob URL and sends no observable API
    // traffic.  A changed non-empty title plus a reset playhead is strong
    // enough to split the take, but a title merely appearing late is not.
    const media = mediaSessionClip();
    const mediaTitle = String(media?.title || '').trim();
    if (mediaTitle) {
      const previousTitle = String(st._lastMediaTitle || '').trim();
      const resetForNewSong = el.currentTime < 8 && (st.lastTime > 8 || (st.clip?.title && st.clip.title !== mediaTitle));
      if (st.recording && previousTitle && mediaTitle !== previousTitle && resetForNewSong) {
        end('clip-change');
        const detected = media.id || findClipIdFromPage();
        // A detector that still reports the old UUID is stale. Preserve the
        // new title under an anonymous identity instead of reviving the old-
        // song-name regression.
        const id = detected && detected !== st.clipId ? detected : anonymousTrackId(media, el);
        st.clipId = id;
        st.clip = { ...provisionalClip(id, el), ...media, id: isUuid(id) ? id : null };
        if (L.ListenAccumulator) st.acc = new L.ListenAccumulator((m, a, accrued) => {
          post('milestone', { milestone: m, action: a, accrued_seconds: round(accrued, 3), clipId: st.clipId });
        });
        post('clip-change', { clipId: id, clip: minimalClip(st.clip), why: 'media-session-title' });
      } else if ((!st.clip || !st.clip.title) && mediaTitle) {
        st.clip = { ...(st.clip || provisionalClip(st.clipId, el)), ...media, id: isUuid(st.clipId) ? st.clipId : (media.id || null) };
      }
      st._lastMediaTitle = mediaTitle;
    }
  }

  const round = (v, d = 3) => { const p = 10 ** d; return Math.round((Number(v) || 0) * p) / p; };

  function onPlay() {
    const el = audioEl();
    if (!el) return;
    // The play event is a user gesture — resume the context NOW so the
    // recorder can start immediately when begin() is called.
    if (st.ctx && st.ctx.state === 'suspended') st.ctx.resume().catch(() => {});
    const src = el.currentSrc || el.src || '';
    const m = src.match(/item_id=([0-9a-f-]{36})/) || src.match(/clip\/([0-9a-f-]{36})/) || location.pathname.match(/\/song\/([0-9a-f-]{36})/);
    const pageClip = currentClipFromPage();
    const pageId = findClipIdFromPage();
    const pageTitle = String(pageClip?.title || '').trim();
    const oldTitle = String(st.clip?.title || '').trim();
    // Re-detect on EVERY play event. Falling back to st.clipId first froze the
    // first UUID for an entire continuous stream.
    let id = m ? m[1] : pageId;
    if (id && id === st.clipId && pageTitle && oldTitle && pageTitle !== oldTitle) id = null;
    // Suno v6 uses MSE blob URLs — no clip id is recoverable from the element.
    // The page itself still knows the id: the player row carries a media URL
    // with item_id=<uuid>, and the RSC payload has the full clip object.
    if (!id && (!pageTitle || pageTitle === oldTitle)) id = st.clipId;
    // Last resort: a generated clip id so auto-capture can actually start.
    if (!id && src.startsWith('blob:')) {
      const provisional = pageClip || provisionalClip(null, el);
      id = anonymousTrackId(provisional, el);
      el.__genmusicassistClipId = id;
    }
    if (id && id !== st.clipId) {
      if (st.recording && st.clipId && id !== st.clipId) end('clip-change');
      st.clipId = id;
      const raw = net.clips.get(id);
      const fromNet = raw ? (L.normalizeClip ? L.normalizeClip(raw) : raw) : null;
      st.clip = fromNet || (isUuid(id) && scanFlightPayload(id)) || pageClip || provisionalClip(id, el);
      post('clip-change', { clipId: id, clip: minimalClip(st.clip) });
      // New clip = new accumulator for milestone tracking
      if (L.ListenAccumulator) {
        st.acc = new L.ListenAccumulator((m, a, accrued) => {
          post('milestone', { milestone: m, action: a, accrued_seconds: round(accrued, 3), clipId: st.clipId });
        });
      }
    }
    // Always ask the SW to pull the full clip from the API if we don't yet
    // have real metadata. Cheap: the SW caches per clip id for the session.
    if (id && (!st.clip || !st.clip.title || !st.clip.metadata || !st.clip.metadata.tags)) {
      resolveClip(id);
    }
    if (st.config.autoCapture && id && !st.recording) begin(id, st.clip, 'play');
  }

  function onPause() {
    if (st.acc) st.acc._close?.();
    if (st.config.autoCapture && st.recording) {
      // do not stop on a short pause: Suno buffers mid-song and pauses the
      // element; stopping there truncates the take. The idle timer decides.
      scheduleIdleStop();
    }
  }

  let idleTimer = 0;
  function scheduleIdleStop() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const el = audioEl();
      if (!el || !st.recording) return;
      // Verify the song actually ended before stopping. MSE players can
      // dispatch a spurious `ended` when they rebuffer mid-song; without
      // this check, a pause at 17s into a 3:02 track truncates the take.
      const dur = isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
      const trulyEnded = el.ended && dur > 0 && (dur - el.currentTime) < 3;
      const trulyPaused = el.paused && !trulyEnded;
      if (trulyEnded || trulyPaused) {
        if (st.acc && trulyEnded) st.acc.markCompleted?.();
        end(trulyEnded ? 'ended' : 'paused-idle');
      }
    }, 6000);
  }

  function onEnded() {
    // MSE players dispatch a spurious `ended` when they rebuffer or detach
    // the media source mid-song. Verify the playhead is actually near the end
    // before treating the take as complete — otherwise a false `ended` at
    // 17 s into a 3:02 song silently truncates the capture.
    const el = audioEl();
    const dur = el && isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
    if (dur > 0 && (dur - el.currentTime) > 3) {
      dbg('onEnded ignored: false ended at', el.currentTime, 'dur', dur, 'remaining', round(dur - el.currentTime, 1));
      return;
    }
    if (st.acc) st.acc.markCompleted();
    post('milestone', { clipId: st.clipId, milestone: 'completed', action: 'SongCompleted' });
    if (st.recording) end('ended');
  }

  /**
   * Bind the player element. The guard is the EPOCH, not a boolean: after a
   * hot-reload (or an extension update) a new instance sees an element that a
   * previous instance already marked as bound and, with the old boolean guard,
   * simply never attached. Every symptom then looks like "the fix did nothing"
   * — the shape of the reports from the failing sessions.
   */
  function bind() {
    const el = audioEl();
    if (!el) return;
    if (el.__genmusicassistBoundEpoch === EPOCH) return;
    if (typeof el.__genmusicassistTeardown === 'function') {
      try { el.__genmusicassistTeardown(); } catch { /* old instance already gone */ }
    }
    el.__genmusicassistBound = true;
    el.__genmusicassistBoundEpoch = EPOCH;
    el.__genmusicassistTeardown = () => {
      el.removeEventListener('play', onPlay, true);
      el.removeEventListener('playing', onPlay, true);
      el.removeEventListener('pause', onPause, true);
      el.removeEventListener('ended', onEnded, true);
      el.removeEventListener('play', warm, true);
      el.removeEventListener('seeked', warm, true);
      el.removeEventListener('volumechange', warm, true);
      el.__genmusicassistBound = false;
      el.__genmusicassistBoundEpoch = null;
    };
    el.addEventListener('play', onPlay, true);
    el.addEventListener('playing', onPlay, true);
    el.addEventListener('pause', onPause, true);
    el.addEventListener('ended', onEnded, true);
    el.addEventListener('error', () => post('playback-error', { clipId: st.clipId }), true);
    el.addEventListener('ratechange', () => { st.rate = el.playbackRate; }, true);
    // Create the AudioContext on the first user gesture so a later resume()
    // inside begin() actually succeeds. Without this, the rAF loop starts the
    // recorder on a suspended context and MediaRecorder delivers zero bytes.
    const warm = () => {
      if (!st.ctx) {
        ensureContext();
        if (st.ctx && st.ctx.state === 'suspended') st.ctx.resume().catch(() => {});
      }
      el.removeEventListener('play', warm, true);
      el.removeEventListener('seeked', warm, true);
      el.removeEventListener('volumechange', warm, true);
    };
    el.addEventListener('play', warm, true);
    el.addEventListener('seeked', warm, true);
    el.addEventListener('volumechange', warm, true);
    // Create accumulator early so milestones track from the very first play event
    if (L.ListenAccumulator && !st.acc) {
      st.acc = new L.ListenAccumulator((m, a, accrued) => {
        post('milestone', { milestone: m, action: a, accrued_seconds: round(accrued, 3), clipId: st.clipId });
      });
    }
    // Suno mutates `volume` directly; poll it (it is not an observable property).
    // ONE sampler for the life of the instance: registering it inside bind() meant
    // every re-render that produced a new <audio> added another 120 ms timer, all
    // of them sampling the same element into the same timeline.
    if (!gainTimer) gainTimer = setInterval(() => { const e2 = audioEl(); if (e2) sampleGain(e2); }, 120);
    post('ready', { hasElement: true });
    dbg('bound to #' + AUDIO_ID);
  }

  // The tap now loads at document_start so the network observer sees Suno's
  // bootstrap requests. The DOM may not exist yet, so install player observers
  // separately as soon as documentElement becomes available.
  function bootDom() {
    if (st._domBooted || !document.documentElement) return;
    st._domBooted = true;
    const mo = new MutationObserver(() => { if (mine()) bind(); });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    st._mutationObserver = mo;
    bind();
    if (!audioEl()) post('ready', { hasElement: false });
    if (!rafId) loop();
  }
  if (document.documentElement) bootDom();
  else document.addEventListener('readystatechange', bootDom, { once: true });

  /* ------------------------------------------------------------------ *
   * control channel (isolated bridge relays SW -> page)                *
   * ------------------------------------------------------------------ */
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d.__sunolift !== true || d.dir !== 'down') return;
    if (!mine()) return;   // stale instance: ignore control traffic
    switch (d.type) {
      case 'start': st.armed = true; begin(d.clipId || st.clipId || currentClipFromPage()?.id, st.clip, 'manual'); break;
      case 'stop': end('manual'); break;
      case 'config': {
        const before = st.config;
        st.config = { ...st.config, ...(d.config || {}) };
        if (audioEl() && !st.recording && wantsPcm(st.config) && st.config.workletUrl && !st.pcm.node) {
          // (re)build the graph so the worklet is inserted before the next take
          detach(); attach(audioEl());
        }
        void before;
        post('config-ack', { config: st.config });
        break;
      }
      case 'mark':
        post('cue', { kind: d.kind || 'mark', note: d.note || '', t: audioEl()?.currentTime ?? 0, clipId: st.clipId });
        break;
      case 'seek-check': {
        const el = audioEl();
        if (el) post('state', { position: el.currentTime, clipId: st.clipId, playing: !el.paused });
        break;
      }
      case 'snapshot': {
        const el = audioEl();
        post('snapshot', {
          clipId: st.clipId, clip: minimalClip(st.clip), hasElement: Boolean(el),
          volume: el ? el.volume : null, paused: el ? el.paused : null, currentTime: el ? el.currentTime : null,
          duration: el ? el.duration : null, src: el ? (el.currentSrc || el.src || '').slice(0, 220) : null,
          silentElementPresent: Boolean(document.getElementById(SILENT_ID)),
          gain_timeline: st.timeline && st.timeline.toJSON ? st.timeline.toJSON() : null,
          accrued: st.acc ? round(st.acc.accruedSeconds, 3) : 0,
          milestones: st.acc ? [...st.acc.fired] : [],
          ctxState: st.ctx ? st.ctx.state : null,
        });
        break;
      }
      /**
       * The SW fetched the full clip record from Suno's API on our behalf.
       * Update the live clip object so the next take — and the reflect tier —
       * carry the title, tags, prompt, lyrics, model name, etc.
       */
      case 'clip-resolved': {
        st._resolving = null;
        const c = d.clip;
        if (!c || c.id !== st.clipId) break;
        st.clip = c;
        dbg('clip resolved', c.id, c.title);
        post('clip-change', { clipId: st.clipId, clip: minimalClip(c) });
        // Once we have the clip, kick off a background fetch of structural
        // analysis (sections, downbeats, lyrics) so the take has segments.
        resolveStructure(st.clipId);
        break;
      }
      case 'clip-structure': {
        if (d.clipId !== st.clipId) break;
        st.structure = d.structure;
        dbg('clip structure resolved', d.clipId);
        break;
      }
    }
  });

  // Install before Suno's bundle makes its first API call. Idempotent
  // across hot reloads (guarded by __genmusicassistNetHooked).
  installNetworkObserver();

  post('installed', { version: '1.0.5' });
})();

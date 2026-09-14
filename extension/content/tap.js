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
    st.timeline.add(t, g);
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
    if (!attach(el)) return;
    st.starting = true;                        // cleared in startRecorder()'s go()/failure paths
    st.abortStart = false;
    st.captureId = `cap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    st.chunks = []; st.chunkBytes = 0;
    st.timeline = L.GainTimeline ? new L.GainTimeline() : null;
    st.startedAt = Date.now();
    st.clipId = clipId; st.clip = clip;
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
      st.rec.ondataavailable = (ev) => {
        if (!ev.data || !ev.data.size) return;
        st.chunks.push(ev.data); st.chunkBytes += ev.data.size;
        post('progress', { bytes: st.chunkBytes, ms: Date.now() - st.startedAt });
      };
      st.rec.onstop = flush;
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
    st.__flush = snap;
    st.chunks = []; st.chunkBytes = 0; st.startedAt = 0;
    const hasRecorder = st.rec && typeof st.rec.stop === 'function';
    try {
      if (hasRecorder) st.rec.stop();
      else if (snap.chunkBytes > 0) flush();   // stopped before the recorder existed
      else st.__flush = null;                  // nothing was ever captured: say nothing
    } catch { flush(); }
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
      },
    });
  }

  /** Ship the take as metadata + blob bytes in 1 MiB slices (message-size safe). */
  async function flush() {
    // Use the snapshot from end() if available — begin() may have already
    // reset st.chunks for the next clip by the time onstop fires.
    // Also append any chunks added after the snapshot (e.g. final chunk from rec.stop()).
    const snap = st.__flush;
    const chunks = snap ? [...snap.chunks, ...st.chunks] : st.chunks;
    const startedAt = snap ? snap.startedAt : st.startedAt;
    const captureId = snap ? snap.captureId : st.captureId;
    const clipId = snap ? snap.clipId : st.clipId;
    const clip = snap ? snap.clip : st.clip;
    const timeline = snap ? snap.timeline : st.timeline;
    const acc = snap ? snap.acc : st.acc;
    const endReason = snap ? snap.endReason : st.endReason;
    st.__flush = null;
    st.chunks = [];
    const el = audioEl();
    const duration = Date.now() - startedAt;
    // close out the listen first so `completed` is inside the record we serialise
    if (acc) acc.markCompleted?.();
    const listen = acc ? acc.toJSON(L.getKnownDurationSeconds ? L.getKnownDurationSeconds(clip || {}) : null) : null;
    const blob = new Blob(chunks, { type: pickMime() || 'audio/webm' });
    const meta = {
      captureId, clipId,
      clip: minimalClip(clip || (el ? currentClipFromPage() : null)),
      listen, durationMs: duration, bytes: blob.size,
      mime: blob.type, sampleRate: st.ctx ? st.ctx.sampleRate : st.config.sampleRate,
      channels: 2,
      gain_timeline: timeline && timeline.toJSON ? timeline.toJSON() : null,
      ui_gain: el ? (el.muted ? 0 : el.volume) : null,
      correction: st.config.correction,
      endReason: endReason || 'manual',
      target_lufs: st.config.targetLufs,
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

  /* ------------------------------------------------------------------ *
   * clip discovery: read the clip Suno itself rendered into the page   *
   * ------------------------------------------------------------------ */
  function currentClipFromPage() {
    // 1) data attributes Suno leaves on rows/cards
    const sel = '[class*="SongRow"], [class*="song-row"], [data-clip-id], [id^="clip-"]';
    const active = document.querySelector('.playing, [class*="isPlaying"], [data-playing="true"]');
    const pool = active ? [active, ...document.querySelectorAll(sel)] : [...document.querySelectorAll(sel)];
    for (const n of pool) {
      const id = n.getAttribute?.('data-clip-id') || n.id?.replace(/^clip-/, '');
      if (!id || !/^[0-9a-f-]{36}$/.test(id)) continue;
      // Take the human name with the id. The row always shows it, and without
      // it every capture is filed as "Untitled" — a curation tool that cannot
      // name a file is no use to a musician.
      const title = rowTitle(n);
      return { id, title: title || undefined, __from: 'dom' };
    }
    // 2) the RSC flight payload on /song/{id} pages contains the full clip
    const m = location.pathname.match(/^\/song\/([0-9a-f-]{36})/);
    if (m) return { id: m[1], __from: 'route' };
    return null;
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
      const re = new RegExp(`item_id=(${UUID})`);
      const active = document.querySelector('.playing, [class*="isPlaying"], [data-playing="true"], [aria-current="true"]');
      const nodes = active ? [active, ...active.querySelectorAll('*')] : [];
      for (const n of nodes) {
        for (const attr of n.attributes || []) {
          const m = attr.value && attr.value.match(re);
          if (m) return m[1];
        }
      }
      // Whole-DOM sweep as fallback (cheap enough at ~1 Hz; the player row
      // usually wins first).
      const html = document.documentElement.innerHTML;
      const hits = html.match(new RegExp(`item_id=(${UUID})`, 'g')) || [];
      if (hits.length === 1) return hits[0].slice('item_id='.length);
      // Multiple hits: prefer one that also appears in the RSC flight data
      // with a title (the clip object), else the first.
      for (const h of hits) {
        const id = h.slice('item_id='.length);
        const clip = scanFlightPayload(id);
        if (clip) return id;
      }
      return hits.length ? hits[0].slice('item_id='.length) : null;
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
    const isPlaying = !el.paused && !el.ended && el.readyState > 2;
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
          st.clipId = findClipIdFromPage() || `blob_${Date.now().toString(36)}`;
        } else {
          // src changed but carried no id: keep the current attribution rather
          // than inventing one. (No-op self-assignment removed.)
        }
        st.clip = currentClipFromPage() || null;
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
    // Auto-capture: only start if the context is running. If it's suspended,
    // Chrome requires a user gesture to resume — begin() handles that via
    // startRecorder(), but we should only call it when the graph is live.
    // If no clip id has been set yet (MSE blob URLs hide it), synthesize one
    // so auto-capture can actually start. onPlay() does this too, but the
    // element may already be playing when the script loads.
    if (st.config.autoCapture && isPlaying && !st.recording) {
      if (!st.clipId && st.lastSrc && st.lastSrc.startsWith('blob:')) {
        st.clipId = `blob_${Date.now().toString(36)}`;
        post('clip-change', { clipId: st.clipId });
      }
      if (st.clipId) {
        // Pull the REAL clip object (title, prompt, tags, media_urls) from the
        // page whenever we can — the saved file must say "Midnight Shadows /
        // dark jazz", not "Untitled". Cheap: only when unbound so far.
        if (!st.clip || !st.clip.id || st.clip.id !== st.clipId) {
          st.clip = (scanFlightPayload(st.clipId) || currentClipFromPage() || st.clip);
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
    let id = m ? m[1] : st.clipId;
    // Suno v6 uses MSE blob URLs — no clip id is recoverable from the element.
    // The page itself still knows the id: the player row carries a media URL
    // with item_id=<uuid>, and the RSC payload has the full clip object.
    if (!id) id = findClipIdFromPage() || st.clipId;
    // Last resort: a generated clip id so auto-capture can actually start.
    if (!id && src.startsWith('blob:')) {
      id = el.__genmusicassistClipId || `blob_${Date.now().toString(36)}`;
      el.__genmusicassistClipId = id;
    }
    if (id && id !== st.clipId) {
      if (st.recording && st.clipId && id !== st.clipId) end('clip-change');
      st.clipId = id;
      st.clip = (id && scanFlightPayload(id)) || currentClipFromPage();
      post('clip-change', { clipId: id, clip: minimalClip(st.clip) });
      // New clip = new accumulator for milestone tracking
      if (L.ListenAccumulator) {
        st.acc = new L.ListenAccumulator((m, a, accrued) => {
          post('milestone', { milestone: m, action: a, accrued_seconds: round(accrued, 3), clipId: st.clipId });
        });
      }
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
      if (el && (el.paused || el.ended) && st.recording) {
        if (st.acc && el.ended) st.acc.markCompleted?.();
        end(el.ended ? 'ended' : 'paused-idle');
      }
    }, 6000);
  }

  function onEnded() {
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

  // The element is created once but the SPA re-renders; watch for it.
  const mo = new MutationObserver(() => { if (mine()) bind(); });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  bind();
  if (!audioEl()) post('ready', { hasElement: false });
  if (!rafId) loop();

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
    }
  });

  post('installed', { version: '1.0.0' });
})();

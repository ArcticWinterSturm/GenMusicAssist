/**
 * sunolift / extension / sidepanel / sidepanel.js
 * ---------------------------------------------------------------------------
 * The curation screen. This is the part the "download everything" extensions
 * never had: a 200-generation session needs a *triage* UI, not a checkbox list.
 * Everything here is ordered by revealed preference (how much you actually
 * listened), and every row can export without touching Suno's MP3/WAV quota.
 */
'use strict';
const send = (type, payload = {}) => new Promise((res) => {
  try { chrome.runtime.sendMessage({ source: 'bridge', type, ...payload }, (r) => { void chrome.runtime.lastError; res(r && r.data !== undefined ? r.data : r); }); }
  catch { res(null); }
});
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (s) => (s == null || !isFinite(s)) ? '–' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const st = {
  tab: location.hash.includes('settings') ? 'settings' : 'triage',
  library: [], suno: [], clips: [], quota: null, reflect: [], sidecar: null,
  sort: 'score', filter: '', structureCache: new Map(), playing: null,
};

/* ---------------- shell ---------------- */
document.querySelectorAll('#tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    st.tab = b.dataset.t;
    document.querySelectorAll('#tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    render();
  });
});
$('#refresh').addEventListener('click', () => { load(); flash('refreshed'); });
$('#ping').addEventListener('click', async () => {
  const r = await send('sidecar-ping', {});
  st.sidecar = r && r.ok !== false ? r : null;
  flash(st.sidecar ? `desktop app reachable (${st.sidecar.version || '?'}, ${st.sidecar.ffmpeg ? 'ffmpeg' : 'pure-js'})` : 'desktop app not reachable — captures stay in the browser', st.sidecar ? 'ok' : 'err');
  render();
});

function flash(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `flash ${kind}`; el.textContent = msg; document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

async function load() {
  st.library = (await send('library-request', {})) || [];
  st.quota = await send('quota-request', {});
  st.reflect = (await send('reflect-log', {})) || [];
  if (st.tab === 'library') await loadSunoLibrary();
  render();
}

async function loadSunoLibrary() {
  const me = await send('api', { path: '/api/clips/?page=1' }).catch(() => null);
  const d = await send('library-page', { limit: 25 }).catch(() => null);
  st.clips = d?.clips || [];
  st.cursor = d?.cursor || null;
  $('#status').textContent = d && d.error ? `Suno library: ${d.error}` : `${st.clips.length} clips from /api/feed/v3`;
}

/* ---------------- render ---------------- */
function render() {
  const v = $('#view');
  if (st.tab === 'settings') { v.innerHTML = settingsHtml(); wireSettings(); return; }
  if (st.tab === 'reflect') { v.innerHTML = reflectHtml(); return; }
  if (st.tab === 'library') { v.innerHTML = sunoHtml(); wireSuno(); return; }

  const rows = sortFilter(st.tab === 'triage' ? pendingRows() : st.library);
  const hdr = `
  <div class="card"><div class="row" style="justify-content:space-between">
    <div class="meta">${rows.length} capture${rows.length === 1 ? '' : 's'} · ${st.tab === 'triage' ? 'ordered by how much you actually listened' : 'all captures'}</div>
    <div class="row">
      <select id="sort"><option value="score">by score</option><option value="recent">most recent</option><option value="accrued">accrued listen</option><option value="coverage">coverage</option></select>
      <input type="text" id="filter" placeholder="filter title / tag / id" value="${esc(st.filter)}">
    </div></div>
    ${quotaBar()}
  </div>`;
  v.innerHTML = hdr + (rows.length ? rows.map(rowHtml).join('') : `<div class="empty">No captures yet.<br>Play something on suno.com — the HUD dot goes red and a take is recorded automatically.</div>`);
  const s = $('#sort'); if (s) { s.value = st.sort; s.onchange = () => { st.sort = s.value; render(); }; }
  const f = $('#filter'); if (f) f.oninput = () => { st.filter = f.value; const c = v.scrollTop; render(); v.scrollTop = c; };
  rows.forEach((r) => { drawWave(r); attachRow(r); });
}

const pendingRows = () => st.library.filter((r) => !r.curation?.verdict);

function sortFilter(rows) {
  const f = st.filter.toLowerCase();
  let out = rows.filter((r) => !f || [r.song?.title, r.song?.style_tags, r.clip_id, r.capture_id].some((x) => String(x || '').toLowerCase().includes(f)));
  const k = st.sort;
  out.sort((a, b) => k === 'recent' ? String(b.created_at).localeCompare(String(a.created_at))
    : k === 'accrued' ? (b.listen_state?.accrued_seconds || 0) - (a.listen_state?.accrued_seconds || 0)
      : k === 'coverage' ? (b.listen_state?.coverage || 0) - (a.listen_state?.coverage || 0)
        : (b.curation?.score || 0) - (a.curation?.score || 0));
  return out;
}

function quotaBar() {
  const q = st.quota;
  if (!q) return `<div class="meta" style="margin-top:6px">Quota unknown — open suno.com once so the extension can read /api/billing/info/.</div>`;
  return `<div class="pills" style="margin-top:6px">
    <span class="pill ${q.exhausted ? 'bad' : 'on'}">Suno MP3/WAV: ${q.remaining} left${q.period_limit ? ` (used ${q.period_used}/${q.period_limit})` : ' (lifetime top-ups)'}</span>
    <span class="pill">M4A via zip: no quota</span>
    <span class="pill on">Capture: no quota, ever</span>
    ${q.credit_rate_limit ? `<span class="pill">gen credits ${q.credit_rate_limit.available_credits}</span>` : ''}
  </div>`;
}

function rowHtml(r) {
  const l = r.listen_state || {}, a = r.audio || {}, c = r.curation || {};
  const cov = Math.round((l.coverage || 0) * 100);
  const miles = ['5s', '30s', '60s', 'completed'].map((m) => `<span class="pill ${(l.milestones || []).includes(m) || (m === 'completed' && l.completed) ? 'on' : ''}">${m}</span>`).join('');
  const flags = [];
  if (r.media?.audio_url_is_sentinel) flags.push('<span class="pill warn">audio_url = /api/forbidden</span>');
  if (a.had_zero_gain) flags.push('<span class="pill bad">captured at 0% volume</span>');
  if (!a.usable) flags.push('<span class="pill bad">take unusable</span>');
  if (a.measured_lufs_after != null) flags.push(`<span class="pill">${a.measured_lufs_after.toFixed(1)} LUFS</span>`);
  if (a.ui_gain != null && a.ui_gain < 0.999) flags.push(`<span class="pill on">gain-corrected +${(20 * Math.log10(1 / Math.max(a.ui_gain, 1e-4))).toFixed(1)} dB</span>`);
  if (r.storage?.via) flags.push(`<span class="pill">${r.storage.via}</span>`);
  if (r.curation?.verdict) flags.push(`<span class="pill ${r.curation.verdict === 'keep' ? 'on' : 'bad'}">${r.curation.verdict}</span>`);
  return `<div class="card item" data-id="${esc(r.capture_id)}" data-clip="${esc(r.clip_id)}">
    <div>
      <div class="title">${esc(r.song?.title || '(untitled generation)')}</div>
      <div class="meta mono">${fmt(l.accrued_seconds)} heard of ${fmt(r.song?.duration_s)} · ${cov}% of the song · ${((a.bytes || 0) / 1048576).toFixed(1)} MB ${a.bitrate_kbps ? `· ${a.bitrate_kbps} kbps` : ''}</div>
      <div class="coverage" title="heard spans"><i style="width:${cov}%"></i><u></u></div>
      <canvas class="wf" data-wf="${esc(r.capture_id)}" width="600" height="34"></canvas>
      <div class="pills">${miles}${flags.join('')}</div>
      <details><summary>segments & metadata</summary>
        <div id="seg-${esc(r.capture_id)}">${(r.segments || []).length ? segTable(r) : '<div class="meta">no segment map — fetch structure below.</div>'}</div>
        <div class="kv" style="margin-top:6px">
          <b>clip</b><span class="mono">${esc(r.clip_id)}</span>
          <b>model</b><span>${esc(r.song?.major_model_version)} ${esc(r.song?.model_name)}</span>
          <b>style</b><span>${esc((r.song?.style_tags || '').slice(0, 160))}</span>
          <b>captured</b><span class="mono">${esc(r.created_at)}</span>
          <b>source</b><span>${esc(a.source)} · ${esc(a.container)}/${esc(a.codec)} · ${esc(a.sample_rate)}Hz</span>
          <b>spans</b><span class="mono">${(l.covered_intervals || []).map((x) => `${fmt(x.start)}–${fmt(x.end)}`).join(', ') || '—'}</span>
          <b>replays</b><span class="mono">${l.replay_count || 0} · skips ${(l.seek_events || []).filter((e) => e.kind === 'skip').length} · max rate ${l.max_playback_rate || 1}</span>
        </div>
      </details>
    </div>
    <div>
      <div class="score" style="color:${scoreColor(c.score)}">${c.score ?? '–'}<small>${esc(c.verdict || 'unjudged')}</small></div>
      <div class="row" style="flex-direction:column;align-items:stretch;margin-top:6px">
        <button data-a="keep" class="pri">★ Keep</button>
        <button data-a="drop" class="dz">✕ Drop</button>
        <button data-a="export">⇩ Export</button>
        <button data-a="structure">Structure</button>
        <button data-a="files">Files</button>
      </div>
    </div>
  </div>`;
}

const scoreColor = (n) => n >= 70 ? 'var(--ok)' : n >= 40 ? 'var(--warn)' : n ? 'var(--bad)' : 'var(--dim)';

function segTable(r) {
  return (r.segments || []).slice(0, 40).map((g) => `<div class="seg"><span class="mono">${fmt(g.start)}</span>
    <span class="bar"><i style="width:${Math.round((g.heard_ratio || 0) * 100)}%"></i></span>
    <span class="mono">${Math.round((g.heard_ratio || 0) * 100)}%</span></div>`).join('');
}

function drawWave(r) {
  const cv = document.querySelector(`canvas[data-wf="${CSS.escape(r.capture_id)}"]`);
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  const dur = r.song?.duration_s || r.audio?.duration_s || 1;
  const peaks = r.waveform?.peaks;
  ctx.fillStyle = '#161b25';
  if (peaks && peaks.length) {
    for (let i = 0; i < peaks.length; i++) {
      const x = (i / peaks.length) * W, [hi, lo] = peaks[i];
      ctx.fillStyle = '#39445a';
      ctx.fillRect(x, H / 2 - hi * H / 2, Math.max(1, W / peaks.length - 1), Math.max(1, (hi - lo) * H / 2));
    }
  } else {
    // fall back to a synthetic trace from the recorded levels we do have
    ctx.fillStyle = '#141a24';
    for (let i = 0; i < 150; i++) {
      const t = i / 150, amp = 0.15 + 0.6 * Math.abs(Math.sin(t * 21) * Math.cos(t * 7.3));
      ctx.fillRect(t * W, H / 2 - amp * H / 2, W / 160, amp * H);
    }
  }
  // heard spans on top
  ctx.fillStyle = 'rgba(56,211,159,.28)';
  for (const s of (r.listen_state?.covered_intervals || [])) {
    ctx.fillRect((s.start / dur) * W, 0, Math.max(1, ((s.end - s.start) / dur) * W), H);
  }
  ctx.strokeStyle = '#8b7cf6'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, H - 0.5); ctx.lineTo(W, H - 0.5); ctx.stroke();
}

function attachRow(r) {
  const root = document.querySelector(`[data-id="${CSS.escape(r.capture_id)}"]`);
  if (!root) return;
  root.querySelectorAll('button[data-a]').forEach((b) => b.addEventListener('click', async () => {
    const a = b.dataset.a;
    if (a === 'keep' || a === 'drop') {
      b.disabled = true;
      const res = await send('curate', { clipId: r.clip_id, verdict: a === 'keep' ? 'keep' : 'drop', captureId: r.capture_id });
      flash(res?.ok ? (a === 'keep' ? 'kept → GenMusicAssist Keeps playlist' : 'trashed on Suno') : `failed: ${res?.error || 'unknown'}`, res?.ok ? 'ok' : 'err');
      await load();
    } else if (a === 'export') {
      const m4a = await send('export-request', { clipId: r.clip_id, captureId: r.capture_id, format: 'm4a' });
      if (m4a?.ok) return flash(m4a.message || 'm4a zip queued', 'ok');
      const why = m4a?.costsQuota ? ' (quota format)' : '';
      const force = confirm(`M4A export unavailable: ${m4a?.message || why}\n\nUse Suno's MP3 download anyway? This SPENDS one of your ${st.quota?.remaining ?? '?'} remaining quota downloads.`);
      const r2 = await send('export-request', { clipId: r.clip_id, format: 'mp3', forceQuota: force });
      flash(r2?.ok ? 'export queued' : `export failed: ${r2?.error || r2?.message}`, r2?.ok ? 'ok' : 'err');
    } else if (a === 'structure') {
      b.textContent = '…';
      const d = await send('structure', { clipId: r.clip_id });
      if (d && !d.error) {
        r.waveform = d.waveform; r.segments = (r.segments || []).length ? r.segments : null;
        if (d.sections?.length || d.lyrics?.length) {
          const L = window.__sunoliftLib;
          if (L) r.segments = L.buildSegmentMap({ duration: r.song?.duration_s, covered: r.listen_state?.covered_intervals || [], sections: d.sections || [], downbeats: d.downbeats || [], lyrics: d.lyrics || [] });
        }
        st.structureCache.set(r.capture_id, d);
        render(); flash(`structure: ${d.waveform?.bars || 0} bars, ${(d.sections || []).length} sections, ${(d.downbeats || []).length} downbeats, ${(d.lyrics || []).length} lyric lines`, 'ok');
      } else flash(`structure unavailable: ${d?.error || 'n/a'}`, 'err');
    } else if (a === 'files') {
      const w = window.open('', '_blank');
      w.document.write(`<title>${esc(r.song?.title || 'capture')} — sidecars</title><body style="background:#0b0d12;color:#e6ebf4;font:12px/1.6 ui-monospace,monospace;padding:20px"><pre>${esc(sidecarText(r))}</pre>`);
      w.document.close();
    }
  }));
}

function sidecarText(r) {
  const L = window.__sunoliftLib;
  return L ? L.sidecarTxt(r) : JSON.stringify(r, null, 2);
}

/* ---------------- suno library tab ---------------- */
function sunoHtml() {
  const rows = (st.clips || []).map((c) => {
    const d = c.diagnostics || {};
    return `<div class="card"><div class="item">
      <div><div class="title">${esc(c.title || '(untitled)')}</div>
      <div class="meta mono">${fmt(c.duration_s)} · ${esc(c.major_model_version)} · ${esc(c.status)} · ${esc(c.created_at)}</div>
      <div class="pills">
        ${c.audio_url_is_sentinel || (c.media_urls || []).some((m) => m.encoding) ? '<span class="pill warn">media is DRM’d — capture only</span>' : ''}
        ${c.is_download_unlocked ? '<span class="pill on">download unlocked</span>' : '<span class="pill">download locked</span>'}
        <span class="pill">${(c.media_urls || []).map((m) => m.content_type).join('+') || 'no media'}</span>
      </div></div>
      <div class="row" style="flex-direction:column"><button class="pri" data-c="${esc(c.id)}" data-a="capture">● Capture</button>
      <button data-c="${esc(c.id)}" data-a="m4a">⇩ M4A (free)</button></div></div></div>`;
  }).join('');
  return `${quotaBar()}<div class="row" style="margin:8px 0">
    <button id="more">Load more</button>
    <span class="meta">Clips come from /api/feed/v3 — the same call the site makes. Click ▶ on a row in Suno to capture it.</span>
  </div>${rows || '<div class="empty">Open suno.com and press ↻ (the extension calls /api/feed/v3 with your browser session).</div>'}`;
}
function wireSuno() {
  $('#more')?.addEventListener('click', async () => {
    const d = await send('library-page', { cursor: st.cursor, limit: 25 });
    if (d?.clips) { st.clips.push(...d.clips); st.cursor = d.cursor; render(); }
  });
  document.querySelectorAll('[data-a="capture"]').forEach((b) => b.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([t]) => {
      chrome.tabs.sendMessage(t.id, { source: 'sw', type: 'ctl', command: 'start', payload: { clipId: b.dataset.c } });
      flash('capture armed');
    });
  }));
  document.querySelectorAll('[data-a="m4a"]').forEach((b) => b.addEventListener('click', async () => {
    const r = await send('export-request', { clipId: b.dataset.c, format: 'm4a' });
    flash(r?.ok ? r.message || 'queued' : `failed: ${r?.message || r?.error}`, r?.ok ? 'ok' : 'err');
  }));
}

/* ---------------- reflect tab ---------------- */
function reflectHtml() {
  const ev = (st.reflect || []).slice(-120).reverse();
  const byClip = new Map();
  for (const e of ev) {
    const k = e.clipId || '?';
    const cur = byClip.get(k) || { milestones: new Set(), max: 0, n: 0, last: 0 };
    if (e.milestone) cur.milestones.add(e.milestone);
    if (e.position != null) { cur.max = Math.max(cur.max, e.position); cur.n++; }
    if (e.accrued != null) cur.max = Math.max(cur.max, e.accrued);
    cur.last = e.at || cur.last;
    byClip.set(k, cur);
  }
  const rows = [...byClip.entries()].sort((a, b) => b[1].max - a[1].max).map(([id, v]) =>
    `<div class="card"><div class="item"><div><div class="title mono">${esc(id)}</div>
     <div class="meta">max playhead ${fmt(v.max)} · ${v.n} samples · milestones ${[...v.milestones].join(', ') || 'none'}</div></div>
     <div class="meta mono">${new Date(v.last).toLocaleTimeString()}</div></div></div>`).join('');
  return `<div class="card"><div class="title">What the “reflect” tier is</div>
    <p class="meta">Independent of the recorder: we mirror Suno’s own telemetry — <code>/api/gen/{id}/listen_milestone</code>
    and playhead samples — into a local journal. If a take is lost (tab closed, recorder blocked, browser throttled),
    “how much of this did I hear” still survives, so triage never starts from zero.</p>
    <div class="pills"><span class="pill">${ev.length} events</span><span class="pill">${byClip.size} clips</span>
    <span class="pill ${st.sidecar ? 'on' : 'warn'}">${st.sidecar ? 'journal mirrored to app' : 'journal local only'}</span></div></div>
    ${rows || '<div class="empty">No events yet.</div>'}`;
}

/* ---------------- settings ---------------- */
function settingsHtml() {
  const s = st.settings || {};
  return `<div class="card"><div class="title">Desktop app (“reflect” sidecar)</div>
    <div class="row" style="margin-top:7px"><label><input type="checkbox" id="sidecar_on" ${s.sidecar_enabled !== false ? 'checked' : ''}> hand captures to the local app</label>
    <input type="text" id="sidecar" value="${esc(s.sidecar || 'http://127.0.0.1:8787')}" style="width:230px"></div>
    <p class="meta">When reachable, the app does offline loudness normalisation (BS.1770-4), container conversion and the
    OS-loopback capture tier. When not, everything stays in the browser and the extension writes the sidecars itself.</p></div>

  <div class="card"><div class="title">Capture</div>
    <div class="row" style="margin-top:7px">
      <label>mode <select id="mode"><option value="auto">auto (record whatever plays)</option><option value="manual">manual</option></select></label>
      <label>correction <select id="correction"><option value="live">live gain node</option><option value="offline">offline in app</option></select></label>
      <label>target <input type="number" id="target" value="${s.targetLufs ?? -14}" step="0.5" style="width:64px"> LUFS</label>
    </div>
    <div class="row" style="margin-top:6px"><label><input type="checkbox" id="auto_download" ${s.auto_download ? 'checked' : ''}> also save a copy via Chrome downloads</label></div>
    <p class="meta">Live mode inserts a compensating gain of 1/UI-volume into the tap, so the slider position cannot change your file.
    Offline mode records flat and lets the app undo the slider sample-accurately using the stored gain timeline.</p></div>

  <div class="card"><div class="title">Curation</div>
    <div class="row" style="margin-top:7px"><label>keep playlist <input type="text" id="keep_playlist" value="${esc(s.keep_playlist_title || 'GenMusicAssist Keeps')}" style="width:190px"></label></div>
    <p class="meta">★ adds the clip to that Suno playlist (so keeps survive a relogin). ✕ calls <code>/api/gen/trash</code> — recoverable in Suno’s trash.</p></div>

  <div class="card"><div class="title">Session for the desktop app</div>
    <p class="meta">The browser is already authenticated (Suno’s API uses cookies only). The app is not, so it can be handed
    the session on demand — this is the “Extract Session” step the other tools ask for, made one-click.</p>
    <div class="row"><button class="pri" id="extract">Extract session → app</button><span id="sx" class="meta"></span></div></div>

  <div class="row" style="margin-top:10px"><button class="pri" id="save">Save settings</button></div>`;
}
function wireSettings() {
  const g = (id) => $('#' + id);
  if (g('mode') && st.settings?.mode) g('mode').value = st.settings.mode;
  if (g('correction')) g('correction').value = st.settings?.correction || 'live';
  $('#save').addEventListener('click', async () => {
    const cfg = {
      sidecar_enabled: g('sidecar_on').checked, sidecar: g('sidecar').value.trim(),
      mode: g('mode').value, correction: g('correction').value,
      targetLufs: Number(g('target').value), auto_download: g('auto_download').checked,
      keep_playlist_title: g('keep_playlist').value.trim(),
    };
    await send('config-set', cfg);
    chrome.tabs.query({ url: 'https://suno.com/*' }, (tabs) => tabs.forEach((t) => chrome.tabs.sendMessage(t.id, { source: 'sw', type: 'config', config: cfg }).catch(() => {})));
    st.settings = cfg; flash('settings saved', 'ok');
  });
  $('#extract').addEventListener('click', async () => {
    $('#sx').textContent = 'reading cookies…';
    const r = await send('session-export', { confirm: true });
    $('#sx').textContent = r?.ok ? `sent ${r.count} cookies` : `failed: ${r?.message || 'app not reachable'}`;
  });
  send('config-get', {}).then((c) => { st.settings = c; if (st.tab === 'settings') render(); });
}

chrome.runtime.onMessage.addListener((m) => {
  if (!m || m.source !== 'sw') return;
  if (m.type === 'library') { st.library = m.library; render(); }
  if (m.type === 'quota') { st.quota = m.quota; render(); }
});
// the bundle is loaded first (see sidepanel.html) and exposes SUNOLIFT, the same
// module set the content scripts and the desktop app run against.
window.__sunoliftLib = window.SUNOLIFT || null;
load();

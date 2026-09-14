#!/usr/bin/env node
/**
 * GenMusicAssist — volume-invariant capture + curation for Suno
 * Copyright (C) 2026  GenMusicAssist Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
/**
 * sunolift / desktop / cli.js
 * ---------------------------------------------------------------------------
 *   sunolift serve                     sidecar + review UI on 127.0.0.1:8787
 *   sunolift status                    what is installed / configured / stored
 *   sunolift reflect [--device D] [--secs N]   standalone OS loopback capture
 *   sunolift process <capture_id>       offline gain-inversion + loudness pass
 *   sunolift export <id> --format m4a   container conversion (needs ffmpeg)
 *   sunolift official --clip ID...      Suno's own zip path (no quota for m4a)
 *   sunolift triage <id> keep|drop      record a verdict
 *   sunolift report                     ranked triage table + archive urgency
 *   sunolift analyze-har <file>         re-run the endpoint audit on a new HAR
 *   sunolift auto [--once] [--watch]    the unattended pipeline
 *   sunolift keeps                      where the curated files went
 *   sunolift autostart [--remove]       survive a reboot
 */
import { argv, exit, env } from 'node:process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Library } from './lib/library.js';
import { probe, ReflectCapture } from './lib/reflect.js';
import { processTake, convertTo } from './lib/encode.js';
import { serve } from './server.js';
import { Autopilot, loadConfig, saveConfig, keepsFolder } from './lib/autopilot.js';

const args = argv.slice(2);
const cmd = args[0] || 'help';
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const has = (n) => args.includes(`--${n}`);
const pos = (i) => args.filter((a, k) => k > 0 && !a.startsWith('--') && args[k - 1] !== undefined && !String(args[k - 1]).startsWith('--')).slice(i, i + 1)[0];
const root = flag('root', env.SUNOLIFT_ROOT) || undefined;
const port = Number(flag('port', 8787)) || 8787;
const lib = new Library(root);
const fmt = (s) => (s == null || !isFinite(s)) ? '—' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);

async function main() {
  if (cmd === 'serve') {
    const app = await serve({ root, port });
    process.on('SIGINT', () => { app.server.close(); exit(0); });
    return;
  }

  /* ---------------- the unattended pipeline ---------------- */

  if (cmd === 'auto') {
    const t = await probe().catch(() => ({ tools: {} }));
    const kv = flag('set');
    if (kv) {
      const [k, v] = String(kv).split('=');
      let parsed = v;
      try { parsed = JSON.parse(v); } catch { /* keep it a string */ }
      saveConfig(lib.root, { [k]: parsed });
      console.log(`autopilot.${k} = ${JSON.stringify(parsed)}`);
      return;
    }
    const wantWatch = has('watch') || !has('once');
    const pilot = new Autopilot({ root: lib.root, tools: t, log: (...a) => console.log('  ', ...a) });
    if (!wantWatch) {
      const r = await pilot.runOnce();
      console.log(`processed ${r.processed.length} take(s) in ${r.ms} ms — ${r.kept} kept`);
      console.log(`  quarantined ${r.quarantined.length} · duplicates ${r.duplicates.length} · exports ${r.exported.length} · errors ${r.errors.length}`);
      for (const e of r.errors) console.log('  x', e.capture_id, e.error);
      if (has('official')) console.log('official:', JSON.stringify(await pilot.downloadOfficial(), null, 2));
      const kd = keepsFolder(lib.root);
      const kept = existsSync(kd) ? readdirSync(kd).filter((f) => !/\.(json|txt|cue|m3u8)$/.test(f)) : [];
      if (kept.length) {
        console.log(`keeps -> ${kd}`);
        for (const f of [...kept].sort().slice(0, 12)) console.log('  ', f);
        if (kept.length > 12) console.log(`   … ${kept.length - 12} more`);
      } else {
        console.log('nothing worth keeping in this pass — play something on suno.com and it will appear here');
      }
      return;
    }
    const cfg = loadConfig(lib.root);
    if (!cfg.enabled) console.log('  note: autopilot.json has enabled:false — starting anyway for this run');
    pilot.start();
    console.log(`autopilot watching ${lib.root} (Ctrl-C to stop)`);
    console.log(`  keeps folder: ${keepsFolder(lib.root)}`);
    await new Promise((r) => { process.on('SIGINT', () => { pilot.stop(); r(); }); });
    return;
  }

  if (cmd === 'keeps') {
    const dir = keepsFolder(lib.root);
    console.log(`keeps folder: ${dir}`);
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => !f.endsWith('.m3u8') && !/\.(json|txt|cue)$/.test(f)) : [];
    for (const f of [...files].sort()) console.log('  ', f);
    if (!files.length) console.log('   (nothing yet - play some generations on suno.com)');
    const m3u = join(dir, 'keeps.m3u8');
    if (existsSync(m3u)) console.log(`playlist: ${m3u}`);
    return;
  }

  if (cmd === 'autostart') {
    const wantRemove = has('remove');
    const node = process.execPath;
    const script = join(lib.root, '..', 'GenMusicAssist', 'desktop', 'cli.js');
    const actualScript = existsSync(script) ? script : join(process.cwd(), 'desktop', 'cli.js');
    const plat = process.platform;
    const { unlinkSync } = await import('node:fs');
    if (plat === 'win32') {
      const startup = join(env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
      const vbs = join(startup, 'GenMusicAssist-Autopilot.vbs');
      if (wantRemove) { if (existsSync(vbs)) { unlinkSync(vbs); console.log('removed', vbs); } else console.log('nothing to remove'); return; }
      const { writeFileSync: wf, mkdirSync: mk } = await import('node:fs');
      mk(startup, { recursive: true });
      const line1 = "' GenMusicAssist autopilot - starts hidden at login";
      const line2 = 'Set s = CreateObject("WScript.Shell")';
      const line3 = 's.Run "' + node + '" & " " & """" & "' + actualScript + '" & """" & " auto --watch --root " & """" & "' + lib.root + '" & """", 0, False';
      wf(vbs, [line1, line2, line3].join('\r\n') + '\r\n');
      console.log('installed:', vbs);
      console.log('  (runs at login with no console window)');
      return;
    }
    if (plat === 'darwin') {
      const dir = join(homedir(), 'Library', 'LaunchAgents');
      const plist = join(dir, 'com.genmusicassist.autopilot.plist');
      if (wantRemove) { if (existsSync(plist)) { unlinkSync(plist); console.log('removed', plist); } else console.log('nothing to remove'); return; }
      const { writeFileSync: wf, mkdirSync: mk } = await import('node:fs');
      mk(dir, { recursive: true });
      const P = [];
      P.push('<?xml version="1.0" encoding="UTF-8"?>');
      P.push('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">');
      P.push('<plist version="1.0"><dict>');
      P.push('  <key>Label</key><string>com.genmusicassist.autopilot</string>');
      P.push('  <key>ProgramArguments</key><array>');
      for (const a of [node, actualScript, 'auto', '--watch', '--root', lib.root]) P.push('    <string>' + a + '</string>');
      P.push('  </array>');
      P.push('  <key>RunAtLoad</key><true/>');
      P.push('  <key>StandardOutPath</key><string>' + join(lib.root, 'autopilot.log') + '</string>');
      P.push('  <key>StandardErrorPath</key><string>' + join(lib.root, 'autopilot.log') + '</string>');
      P.push('</dict></plist>');
      wf(plist, P.join('\n') + '\n');
      console.log('installed:', plist);
      console.log('  load it with: launchctl load -w ' + plist);
      return;
    }
    const unitDir = join(homedir(), '.config', 'systemd', 'user');
    const unit = join(unitDir, 'genmusicassist-autopilot.service');
    if (wantRemove) { if (existsSync(unit)) { unlinkSync(unit); console.log('removed', unit); } else console.log('nothing to remove'); return; }
    const { writeFileSync: wf, mkdirSync: mk } = await import('node:fs');
    mk(unitDir, { recursive: true });
    const U = [
      '[Unit]',
      'Description=GenMusicAssist autopilot (Suno capture curation)',
      '',
      '[Service]',
      'Type=simple',
      'ExecStart=' + node + ' ' + actualScript + ' auto --watch --root ' + lib.root,
      'Restart=on-failure',
      'RestartSec=10',
      '',
      '[Install]',
      'WantedBy=default.target',
    ];
    wf(unit, U.join('\n') + '\n');
    console.log('installed:', unit);
    console.log('  enable: systemctl --user daemon-reload && systemctl --user enable --now genmusicassist-autopilot');
    console.log('  cron fallback: @reboot ' + node + ' ' + actualScript + ' auto --watch --root ' + lib.root);
    return;
  }

  if (cmd === 'status') {
    const t = await probe();
    const s = lib.stats();
    console.log('sunolift status');
    console.log('  library root   ', s.root);
    console.log('  captures       ', s.captures, `(${s.clips} clips, ${s.mb} MB)`);
    console.log('  usable / total ', `${s.usable} / ${s.captures}`);
    console.log('  needs recapture', s.needs_recapture);
    console.log('  listen seconds ', s.total_listen_seconds);
    console.log('  session file   ', existsSync(join(s.root, 'session.json')) ? 'present' : 'absent (extension can hand it over)');
    console.log('  platform       ', t.platform, t.arch);
    console.log('  backends       ', t.backends.join(', ') || 'NONE - reflect tier disabled');
    console.log('  ffmpeg         ', t.ffmpeg_version || 'not found');
    console.log('  loopback device', t.auto_device || 'not detected');
    if (t.devices?.length) console.log('  devices        ', t.devices.map((d) => d.name).slice(0, 6).join(' | '));
    const ap = loadConfig(s.root);
    const kd = keepsFolder(s.root);
    const kcount = existsSync(kd) ? readdirSync(kd).filter((f) => !/\.(json|txt|cue|m3u8)$/.test(f)).length : 0;
    console.log('  autopilot      ', ap.enabled ? `on (every ${ap.poll_ms} ms)` : 'off (autopilot.json)');
    console.log('  keeps folder   ', kd, existsSync(kd) ? `(${kcount} file(s))` : '(not created yet)');
    return;
  }

  if (cmd === 'reflect') {
    const secs = Number(flag('secs', flag('max-seconds', 0)));
    const out = flag('out', join(lib.root, 'captures', `reflect-${Date.now()}.wav`));
    if (has('list')) { const t = await probe(); console.log((t.devices || []).map((d) => `  ${d.name}`).join('\n') || '  (none found)'); return; }
    const c = new ReflectCapture({ outFile: out, maxSeconds: secs, device: flag('device') });
    try {
      console.log('starting reflect capture ->', out);
      console.log('  ', await c.start());
      if (!secs) console.log('  running; press Ctrl-C to stop');
      if (secs) await new Promise((r) => { setTimeout(r, secs * 1000 + 400); });
      const meta = await c.stop();
      console.log('  stopped', meta);
      const p = await processTake({ input: out, record: {}, invertGain: false, ffmpeg: (await probe()).tools.ffmpeg });
      console.log('  normalised ->', p.wav, `${p.duration_s}s`, `${p.measured_lufs_after} LUFS`);
    } catch (e) { console.error('reflect failed:', e.message); exit(1); }
    return;
  }

  if (cmd === 'process') {
    const id = pos(0);
    const rec = lib.all().find((r) => r.capture_id === id || r.capture_id?.startsWith(id));
    if (!rec) return console.error('unknown capture_id', id) || exit(1);
    const input = rec.files?.audio || lib.audioPath(rec.capture_id, rec.audio?.container || 'webm');
    const r = await processTake({ input, record: rec, targetLufs: Number(flag('lufs', -14)), invertGain: !has('no-invert'), ffmpeg: (await probe()).tools.ffmpeg });
    console.log(JSON.stringify(r, null, 2));
    lib.update(rec.capture_id, { audio: { ...rec.audio, measured_lufs_after: r.measured_lufs_after, normalized_wav: r.wav } });
    return;
  }

  if (cmd === 'export') {
    const id = pos(0), format = flag('format', 'm4a');
    const rec = lib.all().find((r) => r.capture_id === id || r.capture_id?.startsWith(id));
    if (!rec) return console.error('unknown capture_id') || exit(1);
    const src = rec.audio?.normalized_wav || lib.audioPath(rec.capture_id, 'wav');
    if (!existsSync(src)) return console.error('no normalised wav; run `sunolift process` first') || exit(1);
    console.log(await convertTo({ source: src, format, bitrateK: Number(flag('bitrate', 128)), ffmpeg: (await probe()).tools.ffmpeg }));
    return;
  }

  if (cmd === 'official') {
    const ids = args.slice(1).filter((a) => !a.startsWith('--'));
    const format = flag('format', 'm4a');
    if (format !== 'm4a' && !has('force-quota')) {
      console.error(`${format} consumes Suno download credits. Re-run with --force-quota, or use --format m4a (no quota).`);
      exit(2);
    }
    const cookie = env.SUNO_COOKIE || (() => { try { return require_session(); } catch { return null; } })();
    if (!cookie) { console.error('no session: run the extension "Extract session" button, or export SUNO_COOKIE'); exit(2); }
    const r = await fetch('https://studio-api-prod.suno.com/api/download/clips/zip/prepare', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: 'https://suno.com', referer: 'https://suno.com/' },
      body: JSON.stringify({ clip_ids: ids.slice(0, 200), workspace_name: null, format }),
    });
    const j = await r.json().catch(() => null);
    if (!j?.download_url) return console.error('suno said:', r.status, JSON.stringify(j).slice(0, 300)) || exit(1);
    const f = await fetch(j.download_url);
    const buf = Buffer.from(await f.arrayBuffer());
    const dest = join(lib.root, 'exports', `suno-${format}-${Date.now()}.zip`);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(lib.root, 'exports'), { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(dest, buf);
    console.log(`wrote ${dest} (${(buf.length / 1048576).toFixed(2)} MB, ${ids.length} clips, format ${format}, quota cost ${format === 'm4a' ? 0 : 1})`);
    return;
  }

  if (cmd === 'triage') {
    const [id, verdict] = [pos(0), pos(1)];
    if (!['keep', 'drop', 'maybe', 'recapture'].includes(verdict)) return console.error('verdict must be keep|drop|maybe|recapture') || exit(1);
    const rec = lib.update(id, { curation_patch: { verdict, decided_at: new Date().toISOString() } });
    console.log(rec ? `${rec.capture_id} -> ${verdict} (score ${rec.curation?.score})` : 'unknown capture_id');
    return;
  }

  if (cmd === 'report') {
    const rows = lib.byClip();
    console.log(`${rows.length} clips from ${lib.stats().captures} captures`);
    console.log(pad('score', 6), pad('verdict', 10), pad('heard', 8), pad('cover', 7), pad('takes', 6), pad('ttl', 5), 'title');
    for (const r of rows) {
      const b = r.best || {};
      console.log(
        pad(r.score, 6), pad([...r.verdicts][0] || r.best?.curation?.verdict || 'unjudged', 10),
        pad(fmt(b.listen_state?.accrued_seconds), 8), pad(`${Math.round((r.coverage || 0) * 100)}%`, 7),
        pad(r.takes, 6), pad(r.archive_urgency == null ? '—' : `${r.archive_urgency}d`, 5),
        (r.song?.title || r.clip_id || '').slice(0, 54),
      );
    }
    if (has('csv')) console.log('\ncsv:', lib.exportCsv().path);
    const stale = rows.filter((r) => r.archive_urgency != null && r.archive_urgency <= 3 && !r.best?.files?.audio);
    if (stale.length) console.log(`\n  ⚠ ${stale.length} clip(s) you have not archived and whose Suno copy expires within 3 days`);
    return;
  }

  if (cmd === 'analyze-har') {
    const file = pos(0);
    if (!file || !existsSync(file)) return console.error('usage: sunolift analyze-har <file.har>') || exit(1);
    console.log(analyzeHar(readFileSync(file, 'utf8')));
    return;
  }

  console.log(`sunolift — Suno capture + curation (v1)

  serve [--port 8787] [--root DIR]     sidecar + review UI
  status                               environment / library report
  reflect [--device D] [--secs N] [--list]     OS loopback capture tier
  process <capture_id> [--lufs -14]    undo page volume + loudness-normalise
  export <capture_id> [--format m4a]   container conversion (needs ffmpeg)
  official --clip ID [--format m4a]    Suno's own zip export (m4a = no quota)
  triage <capture_id> keep|drop|maybe  record a verdict (the autopilot honours it)
  report [--csv]                       ranked triage table
  analyze-har <file.har>               audit a capture against Suno's live API

  auto [--once|--watch] [--set k=v]    THE UNATTENDED PIPELINE
                                       normalise -> rank -> keep -> keeps/ + playlist
  keeps                                list the curated output
  autostart [--remove]                 run the autopilot from login/boot

  library root: ${lib.root}
  keeps folder: ${keepsFolder(lib.root)}`);
}

/**
 * The HAR audit that produced ANALYSIS.md, kept as a command so the report can
 * be regenerated after the next Suno change instead of argued about.
 */
export function analyzeHar(text) {
  const d = JSON.parse(text);
  const E = d.log.entries;
  const norm = (s) => { for (let i = 0; i < 4; i++) s = s.replace(/\\\\/g, '\\').replace(/\\"/g, '"'); return s; };
  const out = { entries: E.length, started: E[0]?.startedDateTime, hosts: {}, media_shapes: {}, statuses: {}, milestones: [], playhead: [], sentinel_clips: 0, forbidden_hits: 0, audio_urls: {} };
  for (const e of E) {
    const h = new URL(e['request']['url']).host;
    out.hosts[h] = (out.hosts[h] || 0) + 1;
    if (e['request']['url'].includes('/listen_milestone') && e['request'].postData?.text) out.milestones.push({ clip: new URL(e['request']['url']).pathname.split('/')[3], milestone: JSON.parse(e['request'].postData.text).milestone, at: e.startedDateTime });
    if (e['request']['url'].includes('playbar_state') && e['request'].postData?.text) {
      const b = JSON.parse(e['request'].postData.text);
      out.playhead.push({ state: b.playbar_state, pos: b.song_play_time, vol: b.volume, queue: (b.song_ids_in_queue || []).length, at: e.startedDateTime });
    }
    const t = norm(e['response']?.content?.text || '');
    for (const m of t.matchAll(/"content_type":"([a-z0-9\-]+)","delivery":"([a-z0-9\-]+)"/g)) out.media_shapes[`${m[1]}/${m[2]}`] = (out.media_shapes[`${m[1]}/${m[2]}`] || 0) + 1;
    out.sentinel_clips += (t.match(/"audio_url":"https:\/\/studio-api\.prod\.suno\.com\/api\/forbidden"/g) || []).length;
    out.forbidden_hits += (t.match(/\/api\/forbidden/g) || []).length;
    for (const m of t.matchAll(/"(audio_url|video_url|preview_url)":"(https?:[^"]{0,120})"/g)) { const k = `${m[1]}:${(m[2] || '').split('/')[2] || ''}`; out.audio_urls[k] = (out.audio_urls[k] || 0) + 1; }
    for (const m of t.matchAll(/"status":"(complete|streaming|queued|failed|generating)"/g)) out.statuses[m[1]] = (out.statuses[m[1]] || 0) + 1;
  }
  const lines = [
    `entries ${out.entries}   started ${out.started}`,
    `hosts: ${Object.entries(out.hosts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}=${v}`).join('  ')}`,
    `clip statuses: ${JSON.stringify(out.statuses)}`,
    `media shapes (content_type/delivery): ${JSON.stringify(out.media_shapes)}`,
    `audio_url hosts: ${JSON.stringify(out.audio_urls)}`,
    `forbidden sentinels in responses: ${out.forbidden_hits}  (clips whose audio_url is the sentinel: ${out.sentinel_clips})`,
    `listen_milestones POSTed: ${out.milestones.map((m) => `${m.milestone}@${m.at.slice(11, 19)}`).join(' ') || 'none'}`,
    `playbar_state samples: ${out.playhead.map((p) => `${p.pos.toFixed(1)}s/${p.vol}%/${p.state}`).join(' ') || 'none'}`,
    '',
    'verdict:',
    out.sentinel_clips > 0 ? '  ✗ clip.audio_url is the /api/forbidden sentinel - any tool reading it writes an error body' : '  ✓ audio_url looks real in this capture',
    Object.keys(out.media_shapes).some((k) => /opus|m4a/.test(k)) ? '  ✓ media is served via media_urls[] descriptors; presence of `encoding` marks it DRM-side' : '  ? no media_urls descriptors found',
    '',
    'probe the live endpoints before trusting any exporter:',
    '  cdn1.suno.ai/{id}.mp3                       -> expect 403 (signed URLs)',
    '  {sentinel}                                  -> expect 403 XML',
    '  media_urls[0].url                           -> expect 200 but ciphertext if `encoding` is set',
    '  audiopipe/?item_id={id}&format=webm         -> expect 403 if the plaintext hole was closed',
  ];
  return lines.join('\n');
}

function require_session() {
  const p = join(lib.root, 'session.json');
  if (!existsSync(p)) throw new Error('no session.json');
  const s = JSON.parse(readFileSync(p, 'utf8'));
  return (s.cookies || []).map((c) => `${c.name}=${c.value}`).join('; ');
}

main().catch((e) => { console.error(e.stack || String(e)); exit(1); });

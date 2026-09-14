/**
 * sunolift / desktop / lib / reflect.js
 * ===========================================================================
 * The backup capture tier: OS-level output "reflection" (loopback), used when the
 * in-page Web Audio tap cannot run or must not be trusted.
 *
 * When this matters in practice
 *  - the tab is in the background and the browser throttles the audio graph
 *  - the user routes Suno to a specific output device the page cannot see
 *  - MediaRecorder is blocked (enterprise policy, Brave shields on some builds)
 *  - the take was captured while the page's volume slider sat at 0%: at the OS
 *    mixer you can still hear it, and that path is also immune to per-app volume
 *
 * We never re-implement encoders: if ffmpeg is present we use it, else sox,
 * else arecord/pw-record. The point of this module is *command construction*
 * (unit-testable, no spawning) plus a capability probe that tells the user
 * exactly which one is missing instead of failing silently - which is precisely
 * how the browser-only exporters end up with empty files.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform, arch } from 'node:os';
import { join } from 'node:path';

const run = (file, args, { timeout = 12000 } = {}) => new Promise((res) => {
  if (!file) { res({ err: new Error('binary not configured'), stdout: '', stderr: '' }); return; }
  const p = execFile(file, args, { timeout, maxBuffer: 8 << 20 }, (err, stdout, stderr) => { res({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }); });
  p.on?.('error', (e) => res({ err: e, stdout: '', stderr: String(e.message || e) }));
});

/** Loopback-ish device names per OS, most-likely-first. */
export const LOOPBACK_HINTS = [
  /stereo mix/i, /what u hear/i, /loopback/i, /black ?hole/i, /soundflower/i, /vb-?cable/i,
  /\.monitor\b/i, /monitor\.alsa/i, /summon/i, /声卡混音|立体声混音/i,
  // Bluetooth / wireless speaker fallback patterns (WASAPI loopback)
  /bluetooth/i, /bt\s/i, /wireless/i, /airpods/i, /sony.*wh/i, /bose/i,
];
export const isLoopbackName = (n) => LOOPBACK_HINTS.some((re) => re.test(String(n || '')));

/**
 * Parse `ffmpeg -list_devices true -f dshow -i dummy` stderr into device names.
 * Output looks like:  [dshow @ ..] "Microphone (Realtek)"
 *                              Alternative name "audio=..."  3 channels
 */
export function parseDshowDevices(stderr) {
  const out = [];
  let inAudio = false;
  for (const line of String(stderr).split('\n')) {
    if (/DirectShow audio devices/i.test(line)) inAudio = true;
    else if (/DirectShow video devices/i.test(line)) inAudio = false;
    if (!inAudio) continue;
    // The Alternative-name rows are the SAME device listed by its COM path
    // ("@device_cm_{...}\wave_{...}"). The old check tested the captured group
    // instead of the line, so every device appeared twice, once as an opaque
    // GUID — and `sunolift reflect --list` offered the user a device they
    // could not recognise.
    if (/Alternative name/i.test(line)) continue;
    const quoted = [...line.matchAll(/"([^"]*)"/g)];
    for (const m of quoted) {
      const name = m[1].trim();
      if (!name || name.startsWith('@')) continue;
      if (!out.some((d) => d.name === name)) out.push({ name, kind: 'audio' });
      break;
    }
  }
  return out;
}

/**
 * Pick the dshow audio device that most likely carries "what you hear".
 *
 * The previous version called `require('node:child_process')` — but this file is
 * ESM, so `require` is not defined, the call threw ReferenceError on every
 * machine, and the catch swallowed it: the Bluetooth/WASAPI fallback never ran
 * once. It was also `execFileSync` inside a request handler, i.e. up to 10 s of
 * blocked event loop while the extension's capture POSTs were in flight.
 *
 * `parseDshowDevices` is the device source of truth; this function only chooses.
 */
function pickLoopbackDevice(devices, { explicit = null } = {}) {
  if (explicit) return explicit;
  const list = Array.isArray(devices) ? devices : [];
  const isMic = (n) => /microphone|line in|digital input|spdif|aux|mic\b/i.test(String(n));
  const hinted = list.find((d) => isLoopbackName(d.name));
  if (hinted) return hinted.name;
  const usable = list.find((d) => !isMic(d.name));
  return usable?.name || null;
}

// Kept for callers that still ask the question synchronously; it consults the
// already-probed device list instead of spawning a process.
export function findWasapiLoopback(_ffmpeg, devices = []) {
  return pickLoopbackDevice(devices);
}

/** Parse `ffmpeg -list_devices true -f avfoundation -i dummy` (macOS). */
export function parseAvfoundationDevices(stderr) {
  const out = [];
  let idx = null;
  for (const line of String(stderr).split('\n')) {
    const m = line.match(/^\s*\[(\d+)\]\s*(.+)$/);
    if (m) out.push({ index: Number(m[1]), name: m[2].trim(), kind: 'unknown' });
    if (/AVFoundation audio devices/i.test(line)) idx = 'audio';
    else if (/video devices/i.test(line)) idx = 'video';
    else if (idx === 'audio') { /* keep only audio rows below */ }
  }
  return out;
}

/** `pactl list source short` -> [{name, driver, ...}] */
export function parsePactlSources(stdout) {
  return String(stdout).split('\n').slice(1).map((l) => l.split('\t')).filter((c) => c[0]).map(([name, driver]) => ({ name: name.trim(), driver: (driver || '').trim(), kind: 'pulse' }));
}

/**
 * `wpctl status` prints a tree with default/mute markers in front of the id:
 *     Sinks
 *         *-  67. Built-in Audio Analog Stereo
 *            #  68. Monitor of ...
 * Markers move between versions and `wpctl` also emits `*` after the id, so we
 * strip any leading tree/marker characters rather than anchoring on them.
 */
export function parseWpctl(stdout) {
  const out = [];
  let section = '';
  for (const raw of String(stdout).split('\n')) {
    const head = raw.match(/^\s*(Sinks|Sources|Devices|Modules|Clients|Nodes)\s*$/i);
    if (head) { section = head[1].toLowerCase(); continue; }
    const line = raw.replace(/^[\s│├└─*#-]+/, '');
    const m = line.match(/^(\d+)\.\s+(.+)$/);
    if (!m) continue;
    out.push({ id: Number(m[1]), name: m[2].trim(), kind: 'pipewire', section });
  }
  return out;
}

export function autoDevice(devices, extraHints = []) {
  const hints = [...extraHints.map((h) => (h instanceof RegExp ? h : new RegExp(String(h), 'i'))), ...LOOPBACK_HINTS];
  for (const re of hints) {
    const hit = devices.find((d) => re.test(d.name || d.index || d.id || ''));
    if (hit) return hit;
  }
  return devices[0] || null;
}

/** PCM WAV output args shared by every backend so downstream code sees one format. */
export const WAV_ARGS = ['-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', '-f', 'wav'];

/**
 * Build the capture command. Returns { file, args, backend, device, notes[] }.
 * Pure: no process spawning, so tests can assert the exact argv for each platform.
 */
export function buildCommand({ plat = platform(), tools = {}, device = null, outFile, format = 'wav', maxSeconds = 0, extraArgs = [] } = {}) {
  const notes = [];
  const out = outFile || `capture-${Date.now()}.${format}`;
  const pcm = format === 'wav' ? WAV_ARGS : ['-c:a', 'libopus', '-b:a', '128k', '-f', 'ogg'];
  if (tools.ffmpeg) {
    if (/^win/i.test(plat)) {
      // Prefer a real loopback device (Stereo Mix, etc.). If none exists — common
      // on Bluetooth-only PCs — fall back to WASAPI loopback which captures whatever
      // device is the default speaker, including Bluetooth headphones.
      const loopback = device?.name || pickLoopbackDevice(tools.devices) || 'Stereo Mix';
      if (!device) {
        if (loopback !== 'Stereo Mix') {
          notes.push(`using WASAPI loopback on "${loopback}" (no Stereo Mix found — Bluetooth/USB audio works)`);
        } else {
          notes.push('no loopback device detected - defaulting to "Stereo Mix"; list devices with `sunolift reflect --list`');
        }
      }
      return { file: tools.ffmpeg, args: ['-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-audio_buffer_size', '200', '-i', `audio=${loopback}`, ...extraArgs, ...pcm, ...(maxSeconds ? ['-t', String(maxSeconds)] : []), out], backend: 'ffmpeg-dshow', device: loopback, notes };
    }
    if (/^darwin/i.test(plat)) {
      const d = device?.index ?? device?.name;
      const input = d == null ? ':Default' : `${d}:None`;
      return { file: tools.ffmpeg, args: ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation', '-i', input, ...extraArgs, ...pcm, ...(maxSeconds ? ['-t', String(maxSeconds)] : []), out], backend: 'ffmpeg-avfoundation', device: d, notes };
    }
    if (device?.kind === 'pipewire') {
      return { file: tools.ffmpeg, args: ['-hide_banner', '-loglevel', 'error', '-f', 'pipewire', '-i', `${device.id}`, ...extraArgs, ...pcm, ...(maxSeconds ? ['-t', String(maxSeconds)] : []), out], backend: 'ffmpeg-pipewire', device: device.name, notes };
    }
    const src = device?.name || '@DEFAULT_MONITOR@';
    if (!device) notes.push('no monitor source found - pulse monitor "@DEFAULT_MONITOR@" may need `pactl load-module module-loopback`');
    return { file: tools.ffmpeg, args: ['-hide_banner', '-loglevel', 'error', '-f', 'pulse', '-i', src, ...extraArgs, ...pcm, ...(maxSeconds ? ['-t', String(maxSeconds)] : []), out], backend: 'ffmpeg-pulse', device: src, notes };
  }
  if (tools.sox) {
    // `sox -d` reads the default recording source; on ALSA that is often a loopback.
    return { file: tools.sox, args: ['-q', '-V1', '-t', /^darwin/i.test(plat) ? 'coreaudio' : 'alsa', 'default', '-r', '48000', '-c', '2', '-b', '16', '-e', 'signed-integer', out, ...(maxSeconds ? ['trim', '0', String(maxSeconds)] : [])], backend: 'sox', device: 'default', notes: [...notes, 'sox fallback: ensure your default record source mirrors output'] };
  }
  if (tools.arecord) {
    return { file: tools.arecord, args: ['-q', '-t', 'wav', '-f', 'S16_LE', '-r', '48000', '-c', '2', ...(device?.name ? ['-D', device.name] : []), out], backend: 'arecord', device: device?.name || 'default', notes };
  }
  if (tools.pw_record) {
    return { file: tools.pw_record, args: ['-t', 'raw', '-c', '2', '-r', '48000', '-f', 's16le', ...(device?.name ? ['-n', device.name] : []), out], backend: 'pw-record', device: device?.name || 'default', notes };
  }
  throw new Error('no capture backend available: install ffmpeg (recommended), sox, or pipewire/pw-record');
}

/** Enumerate candidate loopback sources for this machine. */
export async function listDevices(tools) {
  const plat = platform();
  try {
    if (/^win/i.test(plat) && tools.ffmpeg) {
      const r = await run(tools.ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
      return parseDshowDevices(r.stderr || r.stdout);
    }
    if (/^darwin/i.test(plat) && tools.ffmpeg) {
      const r = await run(tools.ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'avfoundation', '-i', 'dummy']);
      return parseAvfoundationDevices(r.stderr || r.stdout);
    }
    if (tools.pactl) {
      const r = await run(tools.pactl, ['list', 'source', 'short']);
      const ds = parsePactlSources(r.stdout).filter((d) => /monitor/i.test(d.name));
      if (ds.length) return ds;
    }
    if (tools.wpctl) {
      const r = await run(tools.wpctl, ['status']);
      return parseWpctl(r.stdout).filter((d) => /monitor|output/i.test(d.name));
    }
  } catch { /* probing must never throw at the UI */ }
  return [];
}

/** Which backends exist on this box? Everything downstream keys off this. */
export async function probe() {
  const tools = {};
  const bins = { ffmpeg: 'ffmpeg', sox: 'sox', arecord: 'arecord', pactl: 'pactl', wpctl: 'wpctl', pw_record: 'pw-record', ffprobe: 'ffprobe' };
  const win = platform() === 'win32';
  // Windows PATH is ';'-separated and binaries carry .exe — the old POSIX-only
  // lookup never found winget-installed ffmpeg on Windows.
  const paths = (process.env.PATH || '').split(win ? ';' : ':');
  const candidates = (bin) => (win ? [`${bin}.exe`, bin] : [bin]);
  for (const [k, bin] of Object.entries(bins)) {
    const names = candidates(bin);
    if (win) {
      const hit = paths.map((p) => names.map((n) => join(p || '.', n))).flat().find((p) => p && existsSync(p));
      if (hit) tools[k] = hit;
    } else {
      if (existsSync(`/usr/bin/${bin}`)) tools[k] = `/usr/bin/${bin}`;
      else if (existsSync(`/usr/local/bin/${bin}`)) tools[k] = `/usr/local/bin/${bin}`;
      else if (existsSync(join(homedir(), '.local/bin', bin))) tools[k] = join(homedir(), '.local/bin', bin);
      else {
        const hit = paths.map((p) => join(p || '.', bin)).find((p) => p && existsSync(p));
        if (hit) tools[k] = hit;
      }
    }
  }
  if (process.env.SUNOLIFT_FFMPEG) tools.ffmpeg = process.env.SUNOLIFT_FFMPEG;
  const version = tools.ffmpeg ? (await run(tools.ffmpeg, ['-hide_banner', '-version'])).stdout.split('\n')[0] : null;
  const devices = await listDevices(tools).catch(() => []);
  const chosen = autoDevice(devices, (process.env.SUNOLIFT_REFLECT_DEVICE || '').split(',').filter(Boolean));
  return {
    platform: platform(), arch: arch(), tools, ffmpeg_version: version,
    devices, auto_device: chosen?.name || chosen?.index || null,
    backends: Object.keys(tools).filter((t) => ['ffmpeg', 'sox', 'arecord', 'pw_record'].includes(t)),
    can_capture: Boolean(tools.ffmpeg || tools.sox || tools.arecord || tools.pw_record),
  };
}

/**
 * A capture run. Keeps timing + device metadata so the resulting WAV has the same
 * audit trail a Web Audio take would: `started_at`, `seconds`, `device`, `backend`.
 */
export class ReflectCapture {
  constructor(opts = {}) { Object.assign(this, { out: null, startedAt: 0, proc: null, stopped: false, meta: null }, opts); }
  async start() {
    const info = await probe();
    const cmd = buildCommand({ tools: info.tools, device: this.device ? { name: this.device } : info.auto_device ? { name: info.auto_device, ...info.devices.find((d) => d.name === info.auto_device) } : null, outFile: this.outFile, maxSeconds: this.maxSeconds, format: this.format || 'wav' });
    this.meta = { backend: cmd.backend, device: cmd.device, notes: cmd.notes, started_at: new Date().toISOString() };
    const { spawn } = await import('node:child_process');
    this.proc = spawn(cmd.file, cmd.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.stderr = '';
    this.proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d.toString()).slice(-4000); });
    this.startedAt = Date.now();
    let killed = false;
    this.proc.on('exit', (code, sig) => { killed = true; this.exitCode = code; this.signal = sig; });
    this.proc.on('error', (e) => { this.error = String(e.message || e); });
    if (this.maxSeconds) this.timer = setTimeout(() => this.stop(), (this.maxSeconds + 1) * 1000);
    await new Promise((r) => { setTimeout(r, 260); });
    void killed;
    return { ...this.meta, file: cmd.outFile || this.outFile, pid: this.proc.pid };
  }
  async stop() {
    clearTimeout(this.timer);
    if (!this.proc || this.stopped) return this.meta;
    this.stopped = true;
    const p = this.proc;
    p.kill('SIGINT');
    await new Promise((res) => { const t = setTimeout(() => { p.kill('SIGKILL'); res(); }, 2500); p.once('exit', () => { clearTimeout(t); res(); }); });
    if (this.meta) {
      this.meta.seconds = (Date.now() - this.startedAt) / 1000;
      this.meta.finished_at = new Date().toISOString();
      this.meta.bytes = existsSync(this.outFile) ? (await import('node:fs')).statSync(this.outFile).size : 0;
    }
    return this.meta;
  }
}

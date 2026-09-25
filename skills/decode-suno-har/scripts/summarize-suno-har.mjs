#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const input = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const timezone = process.argv.find((arg) => arg.startsWith('--timezone='))?.slice('--timezone='.length) || 'UTC';
if (!input) {
  console.error('Usage: node summarize-suno-har.mjs <file.har> [--timezone=Australia/Sydney]');
  process.exit(2);
}

let har;
try {
  har = JSON.parse(readFileSync(input, 'utf8').replace(/^\uFEFF/, ''));
} catch (error) {
  console.error(`Cannot parse ${basename(input)} as JSON: ${error.message}`);
  process.exit(1);
}

const entries = Array.isArray(har?.log?.entries) ? har.log.entries : [];
if (!entries.length) {
  console.error('No HAR log.entries found.');
  process.exit(1);
}

const local = new Intl.DateTimeFormat('en-CA', {
  timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  fractionalSecondDigits: 3,
});
const uuidFrom = (text = '') => String(text).match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)?.[0] || null;
const short = (id) => id ? id.slice(0, 8) : '—';
const safeJson = (text) => {
  try { return JSON.parse(text || ''); } catch { return null; }
};

function classify(entry) {
  let url;
  try { url = new URL(entry?.request?.url || ''); } catch { return null; }
  const path = url.pathname;
  const body = safeJson(entry?.request?.postData?.text);
  let kind = null;
  let clipId = uuidFrom(path);
  let detail = '';

  if (path.includes('/api/music_player/playbar_state')) {
    kind = 'playbar';
    const queue = Array.isArray(body?.song_ids_in_queue) ? body.song_ids_in_queue : [];
    const index = Number.isInteger(body?.song_index) ? body.song_index : -1;
    clipId = uuidFrom(queue[index]);
    detail = `${body?.playbar_state || '?'} @ ${Number(body?.song_play_time) || 0}s; queue[${index}]`;
  } else if (path.includes('/listen_milestone')) {
    kind = 'milestone';
    detail = String(body?.milestone || '?');
  } else if (path.includes('/increment_play_count')) {
    kind = 'play-count';
    detail = 'new selection/play count';
  } else if (path.includes('/api/mango/rights')) {
    kind = 'rights';
    clipId = uuidFrom(body?.content_params?.content_id);
    detail = 'rights requested (response secrets suppressed)';
  } else if (/\/clip\/[0-9a-f-]{36}\.(?:m4a|mp3|wav|webm)$/i.test(path)) {
    kind = 'media';
    detail = `media fetch ${Math.round(Number(entry.time) || 0)}ms`;
  } else if (path.includes('/api/feed/v3')) {
    kind = 'feed';
    detail = 'metadata feed';
  } else if (url.hostname.includes('braze.com') && path.includes('/api/v3/data')) {
    kind = 'braze';
    detail = 'analytics corroboration (body suppressed)';
  }
  if (!kind) return null;

  const time = new Date(entry.startedDateTime);
  return {
    time,
    utc: Number.isNaN(time.valueOf()) ? '?' : time.toISOString(),
    local: Number.isNaN(time.valueOf()) ? '?' : local.format(time).replace(', ', ' '),
    kind,
    clipId,
    status: entry?.response?.status ?? '?',
    detail,
    endpoint: `${entry?.request?.method || '?'} ${url.hostname}${path}`,
  };
}

const rows = entries.map(classify).filter(Boolean).sort((a, b) => a.time - b.time);
const allTimes = entries.map((e) => new Date(e.startedDateTime)).filter((d) => !Number.isNaN(d.valueOf())).sort((a, b) => a - b);

console.log(`# Redacted Suno HAR timeline: ${basename(input)}`);
console.log('');
console.log(`- Entries: ${entries.length}`);
console.log(`- Range: ${allTimes[0]?.toISOString() || '?'} to ${allTimes.at(-1)?.toISOString() || '?'}`);
console.log(`- Local timezone: ${timezone}`);
console.log('- Sensitive headers, query strings, raw telemetry, and rights responses are intentionally omitted.');
console.log('');
console.log('| UTC | Local | Clip | Event | Status | Detail |');
console.log('|---|---|---:|---|---:|---|');
for (const row of rows) {
  console.log(`| ${row.utc} | ${row.local} | ${short(row.clipId)} | ${row.endpoint} | ${row.status} | ${row.detail.replaceAll('|', '\\|')} |`);
}

const playbars = rows.filter((row) => row.kind === 'playbar');
for (let i = 1; i < playbars.length; i += 1) {
  const previous = playbars[i - 1];
  const current = playbars[i];
  if (previous.clipId === current.clipId && previous.detail.startsWith('paused') && current.detail.startsWith('playing')) {
    console.log('');
    console.log(`Handoff gap: ${short(current.clipId)} remained selected but paused for ${((current.time - previous.time) / 1000).toFixed(3)}s before playing.`);
  }
}

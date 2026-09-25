import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { sidecarCue, sidecarJson, sidecarTxt } from '../shared/metadata.js';

const [captureDirArg, mappingArg, flag] = process.argv.slice(2);
if (!captureDirArg || !mappingArg) {
  console.error('usage: node scripts/recover-blank-captures.mjs <capture-dir> <mapping.json> [--apply]');
  process.exit(2);
}
const captureDir = resolve(captureDirArg);
const mappingPath = resolve(mappingArg);
const apply = flag === '--apply';
const spec = JSON.parse(readFileSync(mappingPath, 'utf8'));
const wanted = new Map(Object.entries(spec.captures || {}));
const jsonFiles = readdirSync(captureDir).filter((f) => f.toLowerCase().endsWith('.json'));
const found = [];

for (const file of jsonFiles) {
  let rec;
  try { rec = JSON.parse(readFileSync(join(captureDir, file), 'utf8')); } catch { continue; }
  const fix = wanted.get(rec.capture_id);
  if (!fix) continue;
  const oldStem = basename(file, '.json');
  const audio = readdirSync(captureDir).find((f) => basename(f, extname(f)) === oldStem && /\.(webm|wav|m4a|mp3|ogg|mp4)$/i.test(f));
  found.push({ file, rec, fix, audio });
}

for (const id of wanted.keys()) {
  if (!found.some((x) => x.rec.capture_id === id)) throw new Error(`mapping capture not found: ${id}`);
}

const rows = found.map(({ rec, fix, audio }) => ({ capture_id: rec.capture_id, duration_s: rec.audio?.duration_s, title: fix.title, audio: audio || null }));
console.log(JSON.stringify({ apply, captureDir, matches: rows }, null, 2));
if (!apply) process.exit(0);

const outDir = join(captureDir, spec.output_folder || 'recovered-metadata');
mkdirSync(outDir, { recursive: true });
for (const { rec, fix, audio } of found) {
  rec.song = { ...(rec.song || {}), title: fix.title };
  rec.metadata_recovery = {
    recovered_at: new Date().toISOString(),
    source: fix.source || spec.source || 'manual evidence',
    confidence: fix.confidence || 'high',
    original_clip_id_unresolved: !rec.clip_id,
    note: fix.note || null,
  };
  const safe = fix.title.replace(/[\\/:*?"<>|]+/g, '_').trim();
  const date = String(rec.created_at || '').slice(0, 10) || 'unknown-date';
  const tag = String(rec.capture_id || 'capture').replace(/^cap_/, '').slice(0, 8);
  const stem = `${safe} [${tag}] ${date}`;
  const recoveredAudio = audio ? `${stem}${extname(audio)}` : `${stem}.${rec.audio?.container || 'webm'}`;
  writeFileSync(join(outDir, `${stem}.json`), sidecarJson(rec));
  writeFileSync(join(outDir, `${stem}.txt`), sidecarTxt(rec));
  writeFileSync(join(outDir, `${stem}.cue`), sidecarCue(rec, recoveredAudio));
  if (audio && existsSync(join(captureDir, audio))) copyFileSync(join(captureDir, audio), join(outDir, recoveredAudio));
}
writeFileSync(join(outDir, 'RECOVERY-MANIFEST.json'), JSON.stringify({ source_mapping: mappingPath, created_at: new Date().toISOString(), captures: rows }, null, 2) + '\n');
console.log(`recovered ${found.length} capture(s) to ${outDir}; originals were not modified`);

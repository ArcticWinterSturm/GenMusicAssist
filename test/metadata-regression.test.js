import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../desktop/server.js';
import { captureStartGate, shouldRolloverCapture, sidecarCue } from '../shared/metadata.js';

async function withSidecar(run) {
  const root = mkdtempSync(join(tmpdir(), 'genmusicassist-test-'));
  const app = await createApp({ root, port: 0, quiet: true, autopilot: false });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try { await run({ app, base }); }
  finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
}

test('desktop finalization preserves canonical metadata posted before audio', async () => {
  await withSidecar(async ({ base }) => {
    const captureId = 'cap_regression_canonical';
    const clipId = '11111111-2222-4333-8444-555555555555';
    const canonical = {
      schema: 'sunolift.capture/1', captureId, capture_id: captureId, clip_id: clipId,
      song: { id: clipId, title: 'Not Blank', duration_s: 271, style_tags: 'kayokyoku', lyrics: 'words' },
      media: { audio_url: null, media_urls: [] },
      listen_state: { accrued_seconds: 270, milestones: ['5s', '30s', '60s'], completed: true },
    };
    let r = await fetch(`${base}/capture/meta`, { method: 'POST', body: JSON.stringify(canonical) });
    assert.equal(r.status, 200);
    r = await fetch(`${base}/capture/audio?capture_id=${captureId}&mime=audio/webm`, {
      method: 'POST', body: new Uint8Array(9000), headers: { 'content-type': 'application/octet-stream' },
    });
    assert.equal(r.status, 200);
    r = await fetch(`${base}/capture/finalize`, {
      method: 'POST', body: JSON.stringify({ capture_id: captureId, clip: null, durationMs: 271000, mime: 'audio/webm' }),
    });
    const out = await r.json();
    assert.equal(out.ok, true);
    assert.equal(out.capture.clip_id, clipId);
    assert.equal(out.capture.song.title, 'Not Blank');
    assert.equal(out.capture.song.style_tags, 'kayokyoku');
    assert.equal(out.capture.listen_state.accrued_seconds, 270);
  });
});

test('title-only provisional metadata remains useful without a UUID', async () => {
  await withSidecar(async ({ base }) => {
    const captureId = 'cap_regression_title_only';
    const r = await fetch(`${base}/capture/finalize`, {
      method: 'POST',
      body: JSON.stringify({ capture_id: captureId, clip: { id: null, title: 'Visible Player Title', metadata: { duration: 295 } }, durationMs: 295000, mime: 'audio/webm' }),
    });
    const out = await r.json();
    assert.equal(out.ok, true);
    assert.equal(out.capture.clip_id, null);
    assert.equal(out.capture.song.title, 'Visible Player Title');
    assert.equal(out.capture.song.duration_s, 295);
  });
});

test('cue sidecar references the actual saved audio filename', () => {
  const cue = sidecarCue({ song: { title: 'Track' }, audio: { container: 'webm' } }, 'Track [abc12345] 2026-09-24.webm');
  assert.match(cue, /FILE "Track \[abc12345\] 2026-09-24\.webm" WAVE/);
});

test('strong UUID changes roll over even when adjacent durations are nearly equal', () => {
  const oldId = '433433c6-0bd8-483c-92db-1f85f3cab4af';
  const tyId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  assert.equal(shouldRolloverCapture(oldId, tyId, 'network'), true);
  assert.equal(shouldRolloverCapture(oldId, tyId, 'active-itemid'), true);
  assert.equal(shouldRolloverCapture(oldId, oldId, 'network'), false);
  assert.equal(shouldRolloverCapture(oldId, tyId, 'href'), false);
});

test('capture start waits through Suno paused 0:00/0:00 queue handoff', () => {
  const clipId = '11111111-2222-4333-8444-555555555555';
  assert.deepEqual(captureStartGate({
    duration: 0, currentTime: 0, readyState: 4, clipId,
    networkClipId: clipId, networkState: 'paused', networkAgeMs: 100,
  }), { ok: false, reason: 'duration-unavailable' });

  // Even a stale finite duration from the old MSE source cannot bypass Suno's
  // authoritative paused-at-zero handoff state.
  assert.deepEqual(captureStartGate({
    duration: 183, currentTime: 0, readyState: 4, clipId,
    networkClipId: clipId, networkState: 'paused', networkAgeMs: 100,
  }), { ok: false, reason: 'playbar-paused' });

  // The local recorder may still hold the old UUID while the network has
  // already selected the next one; a fresh global paused state still wins.
  assert.deepEqual(captureStartGate({
    duration: 183, currentTime: 0, readyState: 4,
    clipId: '99999999-8888-4777-8666-555555555555',
    networkClipId: clipId, networkState: 'paused', networkAgeMs: 100,
  }), { ok: false, reason: 'playbar-paused' });

  // A media request can precede the authoritative playbar POST by ~100 ms.
  assert.deepEqual(captureStartGate({
    duration: 183, currentTime: 0, readyState: 4, clipId,
    networkClipId: '99999999-8888-4777-8666-555555555555',
    networkState: 'playing', networkAgeMs: 100, identityPending: true,
  }), { ok: false, reason: 'identity-pending' });

  assert.deepEqual(captureStartGate({
    duration: 194, currentTime: 0, readyState: 4, clipId,
    networkClipId: clipId, networkState: 'playing', networkAgeMs: 100,
  }), { ok: true, reason: 'ready' });

  assert.deepEqual(captureStartGate({
    duration: 194, currentTime: 193, readyState: 4, ended: true, clipId,
    networkClipId: clipId, networkState: 'playing', networkAgeMs: 100,
  }), { ok: false, reason: 'media-ended' });
});

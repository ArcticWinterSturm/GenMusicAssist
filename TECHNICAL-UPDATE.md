# TECHNICAL UPDATE — GenMusicAssist 1.0.5

Consolidated engineering record: architecture, the three capture-correctness bugs found and fixed, the container-level WebM defect and its repair, and the regression suite that locks the behavior in. All examples are generic; no user data, clip IDs, titles, or machine paths.

---

## 1. Architecture

Two independent components over a small shared core (`shared/`):

| Layer | Role |
|---|---|
| `shared/dsp.js` | Gain timeline, loudness math (LUFS), sample-accurate gain correction |
| `shared/metadata.js` | Capture record schema (`sunolift.capture/1`), capture start gate, rollover predicate, sidecar writers (JSON/CUE/TXT) |
| `shared/suno-api.js` | Platform API client (clip fetch, official download path) |
| `shared/util.js` | Common helpers |
| `extension/` | MV3 service worker + offscreen document + content scripts (main-world tap + isolated bridge + PCM AudioWorklet) |
| `desktop/` | Node HTTP sidecar (`createApp()` in `server.js`), CLI (`cli.js`), autopilot, library store, encoder, review UI (`ui/index.html`) |

**Identity model.** Every take is keyed by a clip UUID. Evidence sources are ranked: (1) playbar queue state (`song_ids_in_queue[song_index]`), (2) near-start media requests carrying `item_id=`, (3) Media Session metadata, (4) active-row DOM, (5) `/song/{id}` route. Duration is *never* treated as identity.

**Capture start gate.** A shared `captureStartGate()` predicate gates every entry point (`onPlay`, polling tick, source change). It refuses to start a recorder against a media element that is `0:00/0:00`, not `readyState >= 3`, ended, or whose identity is pending during a queue handoff. This is the single invariant that prevents phantom takes.

**Recorder ownership.** Each `MediaRecorder` owns its own chunk array (`rec.__sunoliftChunks`) and an immutable metadata snapshot (`rec.__sunoliftSnap`) bound at stop time. No shared mutable state crosses takes.

---

## 2. Bug 1 — shared MediaRecorder handlers bled chunks across takes

**Symptom.** Some captured WebM files had the EBML header at an offset of 5–15 KB instead of 0. VLC showed undefined duration and "backwards" playback.

**Root cause.** The `ondataavailable` handler pushed into a *shared* live-state array (`st.chunks.push`). When auto-capture stopped take N and immediately started take N+1, the late final async chunk of take N landed at the head of take N+1's file — the container literally began mid-stream.

**Fix.** Per-recorder closure ownership:

```js
// each recorder carries its own chunks; flush() reads them back
rec.__sunoliftChunks = [];
rec.ondataavailable = (e) => rec.__sunoliftChunks.push(e.data);
rec.onstop = () => flush(rec);
```

**Detection rule (still in place):** any capture whose first bytes are not the EBML magic (`0x1A45DFA3` at offset 0) was corrupted by shared-handler bleed. The repair script is cosmetic for these; the fix is structural.

---

## 3. Bug 2 — identity freeze + wrong-row attribution

**Symptom.** An entire continuous listening session was attributed to one song (the top row of the library list), and adjacent takes were assigned the same UUID/title.

**Root causes, three stacked:**

1. A whole-DOM `item_id=` regex sweep returned the *first hit in DOM order* — on a library page that is the top list row, not the playing track. Removed entirely; identity now comes only from ranked evidence sources.
2. `onPlay()` preferred the previous `st.clipId` before re-detecting, freezing the first UUID across continuous playback. Re-detection now happens on **every** play event.
3. The reconcile loop vetoed a strong new UUID when the new track's duration was within 3 seconds of the old one. Platforms commonly generate adjacent tracks at nearly identical target lengths (e.g. 3:04 → 3:02), so duration must never veto a network-evidence identity change. `shouldRolloverCapture()` now rolls over on any different UUID from network/player evidence, unconditionally.

**Also fixed in the same sweep:**

- The tap loads at `document_start` so the network observer sees the platform's bootstrap traffic (loading at `document_idle` missed it entirely).
- Hot reloads re-point the persistent network wrappers at the newest tap epoch (`window.__genmusicassistNetSink` indirection), so an old epoch can't go silently inert.
- Media Session title changes plus a reset playhead roll over a take even when the platform reuses one blob URL — but a title merely *appearing late* does not, preventing stale-detector regressions.
- When no UUID is momentarily available, the take is kept under an anonymous internal key (`anon_<hash>`) with the visible title retained — honest UUID-null records instead of blank or wrongly-named ones.
- Mid-take promotion (`blob_`/`anon_` → real UUID) keeps the listen accumulator; it is an identity change for the same audio, not a track transition.

---

## 4. Bug 3 — queue-handoff phantom takes (empty captures)

**Symptom.** Deterministic zero-byte/empty takes exactly at the boundary between queued clips, with the real song captured immediately afterward.

**Root cause (proven from HAR evidence).** During the platform's MSE queue handoff, the next UUID is selected and its media/rights work begins while the player is explicitly held `paused` at position zero (~5 s observed). During that window the media element can emit `play` or retain a stale ready state. Both `onPlay()` and the polling loop could call `begin()` without the shared gate — a recorder started against the transient `0:00/0:00` element, received no bytes, and finalized as an empty take.

**Fix.** The `captureStartGate()` invariant (§1) — every entry point checks it, no caller can bypass. A gated start re-arms (`st.armed = true`) and starts normally once the element reports a real duration and ready state.

---

## 5. Bug 4 — finalize dropped canonical metadata

**Symptom.** Multi-megabyte healthy captures with long listen histories but null `clip_id`/title sidecars.

**Root cause.** The extension recovered canonical metadata and posted it to `/capture/meta`, but the desktop `/capture/finalize` route ignored the stored record and rebuilt from a nullable `clip` field. Fast auto-advance could also pair one take's audio with another take's metadata via a shared async finalization snapshot.

**Fix.** Finalization merges the canonical `/capture/meta` record; each recorder's immutable snapshot (§1) makes metadata/audio pairing atomic. A different UUID from network or the active player always rolls the capture over; CUE sidecars now reference the actual on-disk filename.

---

## 6. WebM container defect — no Duration, no seek

**Root cause.** MediaRecorder muxes WebM live and sequentially: no Duration element, no Cues (seek index). VLC reports duration 0 with an empty seek bar; ffprobe fails with `EBML header parsing failed`.

**Repair.** `repair-webm.bat` stream-copy remuxes every `.webm` in a folder:

```
ffmpeg -i in.webm -c copy out.webm
```

No re-encoding, no quality loss, ~1 s per file. This fixes the container only; files whose EBML header is not at offset 0 were corrupted by the Bug-1 shared-handler bleed and are not recoverable by remux.

**Prevention note:** any pipeline writing MediaRecorder output should remux (`-c copy`) at finalize time — the live-muxed container is inherently incomplete.

---

## 7. Regression coverage

`test/metadata-regression.test.js` (Node built-in test runner, `npm test`) exercises the sidecar end-to-end over a temp root: capture start gate behavior, rollover predicates, sidecar writers, and the finalize merge path. Run it before any change to `shared/metadata.js` or `desktop/server.js`.

## 8. Known constraints

- Opus-in-MP4 at ~133 kbps is the ceiling of what the browser ever exposed — captures are WebM/Opus or PCM→WAV, never the original encoded stream.
- No DRM circumvention: the encrypted M4A is neither fetched nor decrypted; only the already-decoded player signal is recorded.
- OS-loopback capture only sees audio after the app starts (WASAPI has no persistent loopback device).
- The HAR decoder skill (`skills/decode-suno-har/`) treats captures as sensitive untrusted input and redacts auth material by design — keep it that way.

# Audio Capture & Curation Toolkit — Consolidated Technical Record

This document consolidates the project overview, platform analysis, implementation decisions, defect sweep, regression coverage, and current limitations into one shareable technical record.

Identifying material has been removed or generalized. This includes account identifiers, device identifiers, clip identifiers, local user paths, capture timestamps, unique project branding, unique playlist names, session-specific media fingerprints, and user-generated titles. The technical behavior, architecture, fixes, tests, and verified constraints are preserved.

---

## 1. Scope

The system has two independent but complementary components:

| Component | Function | Location |
|---|---|---|
| Browser extension | Manifest V3 extension for Chromium-based browsers. Attaches to the platform player, captures decoded playback, mirrors listen telemetry, scores generations, and exposes curation controls. | `extension/` |
| Desktop sidecar | Local Node-based service. Receives takes, performs sample-accurate gain correction, loudness normalization, WAV writing, metadata persistence, optional transcoding, review, reporting, and OS-loopback capture. | `desktop/` |

Either component can run on its own. Used together, the extension handles page-level observation and capture while the desktop service provides persistent storage, PCM processing, offline correction, encoding, and loopback fallback.

The project does not implement decryption of protected media. It records the already-decoded signal available to the authenticated browser player and uses official platform download paths only when explicitly selected.

---

## 2. Evidence Basis

The implementation was derived from three evidence sources:

- a browser network capture from a representative authenticated session;
- the platform's shipped JavaScript bundles;
- direct endpoint probes against the current platform behavior.

The analysis was performed against current behavior rather than legacy assumptions. The network capture contained roughly twenty megabytes of request/response data and more than one hundred entries. Dozens of application chunks were also inspected to resolve media selection, playback, download, telemetry, and API behavior.

The resulting machine-readable evidence is stored separately from the runtime code, and the CLI can re-run the HAR analysis on later captures to detect platform changes.

---

## 3. Why Legacy Download-First Extensions Fail

### 3.1 `audio_url` is no longer a usable media URL

Completed clip objects expose `audio_url`, but the field now resolves to a platform sentinel that returns HTTP 403 rather than playable audio.

Representative behavior:

```text
GET /api/forbidden -> 403 AccessDenied
```

An exporter that blindly saves `clip.audio_url` therefore writes an error payload with an audio filename. This explains the common failure mode where the download completes but the resulting file is not playable.

The platform's own client explicitly treats this field as unusable when it points to the sentinel or when media descriptors indicate protected media.

Representative selector logic:

```js
function getDecodableClipAudioUrl(clip) {
  const item = findAudioMediaItem(clip.media_urls, {
    encrypted: false,
    delivery: "progressive"
  });

  if (item) return item.url;
  if (clip.media_urls && clip.media_urls.length > 0) return null;

  const url = clip.audio_url;
  return !url || isAudiopipeUrl(url) || new URL(url).pathname === "/api/forbidden"
    ? null
    : url;
}
```

### 3.2 Media moved to `media_urls[]`

Playable-media metadata now lives in a descriptor array rather than a single stable public URL.

Representative shape:

```json
{
  "media_urls": [
    {
      "url": "https://<media-host>/<clip>.m4a",
      "content_type": "m4a-opus",
      "delivery": "progressive",
      "encoding": "1.0.0"
    }
  ]
}
```

The shipped media selector uses the presence of `encoding` as the protected-media discriminator.

```js
function findAudioMediaItem(list, { encrypted, delivery, contentType }) {
  const ct = contentType ?? (
    encrypted ? ENCRYPTED_CONTENT_TYPES : UNENCRYPTED_CONTENT_TYPES
  );

  return list.find((m) =>
    !!m.encoding === encrypted &&
    (!delivery || m.delivery === delivery) &&
    (!ct || ct.includes(m.content_type))
  );
}
```

The observed clip descriptors were on the encoded/protected side.

### 3.3 The fetched M4A object is ciphertext, not a normal MP4 container

The media object can return HTTP 200 and identify itself as `audio/mp4`, but the body does not contain a conventional MP4 structure.

Observed properties included:

| Check | Result |
|---|---|
| MP4 `ftyp` signature | absent |
| `moov`, `mdat`, `stsd`, `dOps` atoms | absent |
| Entropy | approximately uniform/high entropy across sampled regions |
| Block-size relationship | inconsistent with CBC; consistent with a stream-style transform |

The shipped player names the decode phase directly, including `aes_ctr_decrypt`, and requests a per-clip key/IV from the rights endpoint when playback starts.

Representative flow:

```text
POST /api/mango/rights
  {"content_params":{"content_id":<clip>,"content_type":"clip"}}

-> {"key":"...","iv":"..."}
```

The player then applies a decode transform before playback.

Accordingly, replacing `audio_url` with `media_urls[0].url` does not repair a legacy downloader. It changes the failure from a small access-denied body to an encrypted media object.

No protected-media decryptor is implemented in this project.

### 3.4 Legacy public CDN paths are no longer a reliable source

Previously used direct audio paths now return access-control errors or require encoded delivery. The old unencrypted download pattern is therefore not a stable current interface.

The client still recognizes multiple platform-controlled media hosts, but those hosts are part of the protected delivery path rather than a public master-file endpoint.

### 3.5 Media objects have a finite retention window

Observed media responses expose an object-expiration policy on the order of one month. The toolkit therefore treats platform-hosted media as temporary and calculates archive urgency rather than assuming that old links remain valid indefinitely.

The practical requirement is local archival, not long-term reliance on remote object URLs.

---

## 4. Current Platform Surface Used by the Toolkit

### 4.1 Authentication model

The authenticated web application is cookie-based. The browser extension inherits the logged-in browser context and therefore does not require a separate login-export step for ordinary in-page API calls.

The standalone desktop service does not automatically inherit browser cookies. Any official-download action performed outside the browser must therefore receive the necessary authenticated context explicitly.

Requests may also contain platform-specific browser and session headers. These are treated as transport requirements, not as mechanisms to bypass access controls.

For extension-origin API calls, origin/referer handling is configured with Manifest V3 declarative request rules rather than depending on permissive CORS behavior.

### 4.2 Download quota model

`GET /api/billing/info/` exposes download-usage and credit-rate-limit structures. Exact account-specific balances are intentionally omitted from this document.

Relevant semantics:

- MP3 and WAV downloads can consume platform download allowance.
- Per-clip action configuration can enable or disable download actions.
- Downloadability is therefore server-controlled rather than reducible to a permanent URL pattern.
- The toolkit treats official platform-side formats as potentially quota-consuming unless verified otherwise.
- The in-browser capture path does not spend download quota.

### 4.3 Source bitrate ceiling

Observed protected M4A/Opus objects were approximately in the 128-134 kbps range. That establishes the effective source ceiling available to the browser decode path.

Re-encoding that material to a nominal 320 kbps MP3 does not add source information. The desktop pipeline therefore prefers WAV as a lossless intermediate container after capture so loudness normalization and later editing do not introduce an additional lossy generation.

### 4.4 Verified and implemented endpoint surface

| Purpose | Call or interface | Evidence |
|---|---|---|
| Resolve one clip | `GET /api/clip/{id}` | shipped bundle |
| Resolve many clips | `POST /api/feed/v3` with clip-id filters | observed network traffic |
| Library/home feeds | `POST /api/unified/feed`, `POST /api/unified/homepage` | observed network traffic |
| Feed paging | `POST /api/feed/v3/offset` | shipped bundle |
| Download quota | `GET /api/billing/info/` | observed network traffic |
| Official bulk export | `POST /api/download/clips/zip/prepare` | shipped bundle |
| Official single download | `GET /api/download/clip/{id}?format=...` with processing poll | shipped bundle |
| Stem download | `GET /api/studio/clip/{id}/download?format=...` | shipped bundle; may be locked |
| WAV conversion | `POST /api/gen/{id}/convert_wav/`, then poll `GET /api/gen/{id}/wav_file/` | shipped bundle |
| Waveform | `GET /api/gen/{id}/waveform-aggregates` | shipped bundle |
| Downbeats | `GET /api/gen/{id}/downbeats` | shipped bundle |
| Streaming downbeats | `POST /api/gen/{id}/downbeats_streaming/v2` | shipped bundle |
| Novelty sections | `GET /api/gen/{id}/novelty-sections` | shipped bundle |
| Aligned lyric timing | `GET /api/gen/{id}/aligned_lyrics/v2/` | shipped bundle |
| Playlist curation | playlist create/add endpoints | shipped bundle |
| Trash | `POST /api/gen/trash` | shipped bundle |
| Preview unlock | `POST /api/gen/{id}/unlock-preview` | shipped bundle |
| Realtime discovery | `GET /api/realtime/discover` | shipped bundle |
| Generation | `POST /api/generate/v2-web/` | observed traffic |

The waveform, downbeat, novelty-section, and aligned-lyric endpoints are especially useful because they provide platform-derived structure rather than requiring local onset/segmentation heuristics.

---

## 5. Listen Telemetry and the Reflect Model

The page maintains one active playback element and a separate silent element.

Representative structure:

```jsx
<audio id="active-audio-play" crossOrigin="anonymous" />
<audio id="silent-audio" />
```

The listen-milestone state machine increments accrued listening only during forward contiguous playback. Seeks, stalls, backwards movement, and large jumps are excluded.

Representative logic:

```js
const thresholds = [
  { threshold: 5, milestone: "5s" },
  { threshold: 30, milestone: "30s" },
  { threshold: 60, milestone: "60s" }
];

const d = currentPosition - previousPosition;
if (previousPosition === null || !isPlaying()) return;
if (d <= 0 || d > 2) return;

accruedSeconds += d;
```

The platform also emits play-count, milestone, and playbar-state telemetry. Playbar state contains fields such as current position, repeat state, volume, queue, and playback context.

The toolkit reproduces the contiguous-playback accounting in `ListenAccumulator`, so local listening metrics match the platform's milestone semantics instead of equating playhead position with listening time.

The reflect layer has two independent parts:

1. A telemetry journal that persists playhead and milestone events even if an audio take is lost.
2. An OS-loopback recorder that can capture system output if the in-page audio graph is unavailable or untrusted.

These paths are independent. Telemetry persistence can remain useful even when loopback capture is unavailable.

---

## 6. Capture Architecture

### 6.1 Live volume compensation

The page volume control modifies `HTMLMediaElement.volume`. `MediaElementAudioSourceNode` receives the post-volume signal, so a low page volume would otherwise produce a low-level recording.

The extension inserts a compensating gain stage:

```text
media element
  -> MediaElementAudioSourceNode
  -> GainNode(1 / element.volume)
  -> recorder / worklet
```

The same compensated graph is used for the monitored path so the recording remains independent of the UI slider.

To avoid extreme amplification:

- zero-gain captures are rejected as unrecoverable;
- compensation is capped at +24 dB;
- a compressor/limiter stage prevents excessive transient clipping in the live graph.

### 6.2 Offline sample-accurate correction

The extension independently samples `element.volume` at approximately 120 Hz and stores a gain timeline in capture metadata.

The desktop process can then invert the page gain per sample using `invertGainInto`, producing a second line of defense against UI-volume changes during the take.

This double implementation is intentional:

- live compensation makes extension-only use viable;
- offline inversion improves determinism and corrects time-varying slider movement.

### 6.3 PCM and MediaRecorder tiers

The extension supports two capture engines:

- a MediaRecorder tier that can operate without the desktop service;
- a PCM AudioWorklet tier used when the sidecar is available.

The PCM path streams short chunks to the local service instead of holding a full song in tab memory.

The implementation uses one-second slicing and approximately one-megabyte message chunking to bound memory and message sizes.

### 6.4 Capture lifecycle

In automatic mode, capture starts when playback starts and ends on media completion or after a pause timeout. One take maps to one clip.

Per-take state isolates recorder instances, chunks, metadata, and finalization so rapid auto-advance cannot merge adjacent clips.

### 6.5 Zero-gain policy

A recording made while the player gain is exactly zero contains digital silence at the capture point. It is not recoverable by later amplification.

Such takes are marked for recapture rather than being normalized upward.

---

## 7. Metadata and Curation

Each completed take can contain:

- clip identity and resolved metadata;
- capture engine and MIME/container information;
- listen duration and milestones;
- covered playback intervals;
- coverage percentage;
- furthest-heard position;
- replay/rewind behavior;
- skip behavior;
- page volume and gain timeline;
- gain-correction status;
- source normalization flag;
- structural sections, downbeats, waveform information, and aligned lyrics when available;
- per-segment heard ratio;
- integrity information such as hashes, gaps, and final extension;
- curation verdict.

`triageScore` ranks generations from revealed listening behavior rather than from a local audio-quality classifier alone.

Signals include:

- reaching 5 s, 30 s, and 60 s listening thresholds;
- completion;
- coverage;
- replays and loop cues;
- skips;
- accelerated scrubbing;
- unusable or muted audio.

Verdicts are:

```text
keep / maybe / discard / skip-unheard / recapture
```

Keep and drop actions can be mirrored to the platform through its playlist and trash endpoints. The local verdict is also retained independently.

---

## 8. Capture Output

A typical local data root contains:

```text
<data-root>/
  library.jsonl
  captures/
    <id>.wav | <id>.webm | <id>.mp4
    <id>.normalized.wav
    <id>.json
    <id>.txt
    <id>.cue
  journal.jsonl
  session.json
  exports/
```

`library.jsonl` is append-oriented capture metadata. Per-capture sidecars provide both machine-readable and human-readable views.

The text sidecar records information such as:

```text
-- LISTENED --
Accrued listening: <seconds>
Milestones hit: <milestones>
Completed: <yes/no>
Coverage of song: <percentage>
Heard through: <range>
Replays / rewinds: <count>

-- CAPTURE --
UI volume at capture: <percentage>
Gain correction: <dB>
Volume-invariant: <yes/no>
Remote object retention: <remaining time>
```

The cue sheet can contain one track per heard segment. CSV export is available for ranked review/reporting.

---

## 9. Reflect / OS Loopback Tier

The sidecar can enumerate and invoke available system-output capture backends.

Backend selection is capability-driven:

- Windows: `ffmpeg -f dshow` and WASAPI-related discovery where available;
- macOS: `ffmpeg -f avfoundation`;
- Linux: PulseAudio or PipeWire paths;
- additional fallbacks: `sox`, `arecord`, `pw-record`.

If no compatible backend is present, the service reports the capability as unavailable and returns an explicit error from the reflect-start route. It does not create an empty output file and report success.

The journal remains active independently, so listening telemetry survives even when loopback audio cannot be captured.

---

## 10. HAR Metadata Encoding Issue

Chromium HAR export can preserve response text with incorrect character decoding for some non-ASCII content. A title containing CJK characters, for example, can become mojibake when later parsed from the HAR and reused as a filename.

A repair utility was added under `tools/har/` for historical HAR analysis. The live application path is not affected because live JSON is decoded as UTF-8.

Regression coverage asserts that non-Latin titles survive the sidecar pipeline intact.

---

## 11. Repository Layout

```text
shared/
  dsp.js
  metadata.js
  platform-api.js
  util.js

tools/
  bundle-shared.js
  make-icons.js
  har/

extension/
  manifest.json
  background.js
  content/
    tap.js
    bridge.js
    pcm-worklet.js
  sidepanel/
  lib/
  icons/

desktop/
  server.js
  cli.js
  lib/
    reflect.js
    library.js
    encode.js
  ui/
    index.html

test/
  ...

har-findings.json
```

Manifest V3 content scripts are classic scripts rather than ESM modules. Shared browser code is therefore bundled into a generated extension file. Tests fail if the generated bundle is stale relative to `shared/*.js`.

---

## 12. Implementation Derived from the Analysis

| Requirement | Implemented response |
|---|---|
| Replace broken direct-download extensions | Stop relying on `audio_url` and protected media objects as raw downloadable files. Use official export endpoints when authorized, or capture decoded playback. |
| Make capture independent of UI volume | Compensating live `GainNode`, gain-timeline sampling, sample-accurate offline inversion, zero-gain rejection, and maximum lift cap. |
| Preserve metadata for the exact heard segment | Persist listen state and fuse it with sections, downbeats, waveform aggregates, and aligned lyrics into segment-level heard ratios. |
| Export from the screen | Side panel and HUD resolve current clips from feed/network state rather than scraping unstable DOM attributes. |
| Provide a backup to the in-page graph | Local telemetry journal plus OS loopback tier. |
| Support high-volume generation review | Curation scoring based on listening behavior, local verdicts, optional platform playlist/trash actions, and archive-urgency reporting. |
| Survive SPA reloads and service-worker restarts | IndexedDB persistence and replay of unconfirmed takes. |
| Bound browser memory | One-second recorder slices and chunked transfer to the sidecar. |

---

## 13. Confirmed Defects and Fixes

### Desktop sidecar

1. **Path traversal in `GET /files`.** Prefix-only `startsWith(root)` validation also matched sibling directories. Fixed with boundary-aware containment validation and a real directory listing implementation.

2. **`/capture/meta` rejected snake_case.** The route accepted only `captureId`. It now accepts both supported naming forms.

3. **`/capture/finalize` discarded rich metadata.** Finalization rebuilt records from a sparse request and lost fields previously posted to `/capture/meta`. Finalization now merges the full record, propagates verdicts, and preserves hash, gap, and extension fields.

4. **PCM `.raw` files accumulated indefinitely.** Temporary raw streams could consume tens of megabytes per minute. Successful WAV conversion now removes the raw file; abandoned streams are reaped; stale raw files are swept on startup.

5. **`/reflect/stop` lost backend stderr.** Reflect state was cleared before the error path used it. Error output is now retained long enough for reporting.

6. **ESM/CommonJS mismatch in `reflect.js`.** A `require()` call inside an ESM module broke loopback-device detection. The module now uses a compatible loading path.

7. **DirectShow parser accepted alternative-name rows as devices.** Parsing now discriminates the actual device line so internal alternative identifiers are not selected as user-facing capture devices.

8. **CLI option values were parsed as clip IDs.** The official-download command now distinguishes option values from positional identifiers and validates missing IDs.

### Browser extension

9. **Window-message router lacked a top-level guard.** A malformed message could raise an uncaught exception during dispatch. Routing now passes through a guarded dispatcher.

10. **Recording state wedged after `AudioContext.resume()` timeout.** `recording` could remain true forever even though capture never started. The take now aborts cleanly, emits `recording-aborted`, resets state, and permits the next capture attempt.

11. **`begin()` marked recording active too early.** State changed before the recorder actually entered the started state. The flag now changes only from the successful start callback, with state isolated per take.

12. **Cross-clip chunk bleed and data loss.** Global chunk arrays allowed an old take's `flush()` to clear bytes already belonging to the next take. Recorder and chunk state now live in per-take closures. PCM uses the same snapshot isolation, a FIFO tail-flush queue, and worklet gating so frames cannot leak between takes or reopen finalized streams.

13. **Current clip identity was unreliable on the create page.** Protected MSE playback does not expose stable identifying DOM attributes. A MAIN-world fetch/XHR observer now harvests clip objects from generation/feed/clip responses and resolves current playback from the platform queue and media requests. Synthetic blob IDs are periodically re-resolved while a take is active.

14. **Manual and library captures lacked resolved metadata.** An on-demand `resolve-clip` request path now travels tap -> bridge -> service worker -> clip API, with `clip-resolved` returned to the page path.

15. **Sidecar readiness was checked only at page load.** Starting the desktop service after opening the page did not promote capture to PCM. A periodic health re-check now pushes updated configuration and rebuilds the audio graph when appropriate.

16. **PCM takes did not participate in automatic curation.** Service-worker handling now applies automatic keep behavior to PCM captures and mirrors the local verdict to the triage route.

17. **HTTP 422 was mislabeled as connectivity failure.** Sidecar validation errors now surface the real status and response body instead of reporting that the app is unreachable.

18. **Auto-keep ran on synthetic blob IDs.** Platform mutation is now gated on a valid resolved identifier.

19. **Manual mode setting was ineffective.** Configuration normalization now maps UI mode to the actual `autoCapture` behavior and includes an explicit capture-engine selector.

20. **Saved MIME type was hard-coded to `audio/webm`.** Finalization now preserves the actual container/MIME type, including MP4 cases.

21. **Network observer attached too late.** Content scripts now start at `document_start` so the observer is installed before the application makes its initial API calls.

22. **Worklet channel count could read an undefined option.** Initialization now handles missing channel configuration safely, and flush chunks include an explicit `tail` marker.

### Launcher and startup

23. **Launcher executed a module that did not call `listen()`.** Startup therefore waited for a sidecar that never bound a port. The launcher now invokes `desktop/cli.js serve`, detects stale port holders, and writes sidecar output to a diagnostic log.

### Durability, telemetry, packaging, and follow-up defects

24. **Auto-advanced blob clips reused the first synthetic ID.** A single element property cached only one fallback identity. The implementation now maps synthetic IDs per blob source.

25. **Finalization interrupted by a service-worker restart could lose takes.** IndexedDB previously retained bytes without a replay/delete protocol. Stored records now include bytes, metadata, and insertion time. A periodic recovery sweep and reconnect-triggered sweep re-finalize unconfirmed captures. Entries are removed only after confirmed persistence.

26. **Replay could duplicate browser download files.** The service worker now records a persistent per-file download guard in extension storage. Sidecar writes are idempotent by capture ID.

27. **Typed arrays could become plain objects before finalization.** Defensive `Uint8Array` coercion prevents accidental posting of stringified object representations.

28. **PCM HUD size was approximately double-counted.** State messages and chunk messages both incremented the displayed byte count. The canonical size now comes from state reporting only.

29. **AudioWorklet processor started active.** Audio preceding the first explicit take could be attributed to a later clip. Processors now start inactive and are gated per take.

30. **Reflect telemetry posted to an unimplemented route.** The extension used `/reflect/events` while the sidecar exposed only `/journal`. The sidecar now supports `/reflect/events` as a GET/POST alias and accepts event arrays, wrapped single events, or bare events before appending to `journal.jsonl`.

31. **Transient service-worker wake or sidecar-start races caused permanent finalization failure.** The bridge now retries once after a short delay. If the retry fails, the UI reports that the take remains retained in browser storage.

32. **Control-message exceptions leaked into the host page console.** Both downward control dispatch and bridge routing are fully guarded.

33. **Structure UI used incorrect waveform/segment alignment.** The structure toast referenced the wrong waveform field, and labels were aligned by array index instead of timestamp. Both were corrected.

34. **Installer script belonged to an unrelated software stack.** The old installer attempted to install a large Python/PyTorch environment unrelated to this Node application. It was replaced with a Node 18+ environment check, sidecar self-test, and optional ffmpeg guidance.

35. **Launcher script contained a hard-coded user path.** Startup now derives the project root from the script location and permits an environment-variable override rather than embedding a local profile path.

36. **CLI accepted an empty official-download invocation.** The command now stops with usage information when no IDs are supplied, and format values are no longer mistaken for IDs.

---

## 14. Test and Regression Coverage

The final bug-sweep baseline reports **103 passing tests**, up from the earlier baseline. Earlier analysis-stage documentation recorded lower totals before the additional sweep tests were added.

### 14.1 DSP conformance

The BS.1770-4 loudness implementation is tested against published 48 kHz filter reference points and a calibration sine.

Reference checks include approximately:

```text
997 Hz  -> +0.715 dB filter response
40 Hz   -> -7.98 dB
10 kHz  -> +4.04 dB
0 dBFS 997 Hz sine -> about -2.99 LUFS
```

This exposed a biquad-sign error that could turn the meter into a resonant filter and produce invalid loudness measurements.

### 14.2 Volume-invariance tests

Equivalent tones captured at substantially different UI-volume settings are passed through the real processing path.

Assertions include:

- loudness delta below roughly 0.3 LU after correction;
- sample correlation above 0.999;
- zero-gain takes rejected rather than amplified;
- gain lift capped at +24 dB.

### 14.3 Real-payload parsing

Tests exercise captured response structures for:

- RSC clip extraction;
- media diagnostics;
- download-quota parsing;
- full HAR analysis.

### 14.4 Wire-contract coverage

A contract test enumerates message names across tap, bridge, and service worker and fails if no receiving handler owns a message.

This caught dropped or unhandled events including:

```text
clip-change
config-ack
tap-status
```

JavaScript syntax is checked across shipped files, and route reply discipline is tested for extension async messaging semantics.

### 14.5 End-to-end PCM coverage

The shipped AudioWorklet is loaded into the test harness, driven with real audio quanta, and POSTed through the running HTTP service.

Assertions include:

- reconstructed WAV loudness within about 0.15 dB of the source;
- sample correlation above 0.999;
- materially different page-volume inputs converging to the same normalized loudness target;
- equivalent handling for the signed 16-bit reflect path.

### 14.6 Extension packaging checks

Tests assert that:

- permissions match actual implementation needs;
- broad `tabs` and `<all_urls>` permissions are not present unnecessarily;
- the MAIN-world script does not call extension-only `chrome.*` APIs;
- the generated shared bundle is current;
- icon files decode correctly.

### 14.7 Tap harness

A VM-loaded harness runs the shipped tap implementation with stubbed DOM, AudioContext, MediaRecorder, and AudioWorklet interfaces.

Covered cases include:

- rapid MediaRecorder auto-advance before the previous recorder's `onstop`;
- preservation of separate take byte counts and ordering;
- forced PCM tail flush during auto-advance;
- strict disable -> flush -> enable ordering;
- correct attribution of the tail to the ended take;
- dropping frames when no take is active;
- an `AudioContext.resume()` promise that never resolves;
- exactly one `recording-aborted` event for the failed gesture;
- a clean subsequent capture attempt.

### 14.8 Live sidecar bug-sweep tests

The sidecar is launched on an ephemeral local port and exercised against:

- traversal rejection;
- snake_case metadata aliasing;
- rich-record finalization;
- verdict and extension propagation;
- PCM raw cleanup;
- startup orphan cleanup;
- reflect-event aliases;
- feed/generate clip harvesting;
- playbar queue parsing.

### 14.9 Durability and static contracts

Static tests pin:

- IndexedDB persistence and replay;
- service-worker download guards;
- inactive-by-default worklet state;
- per-source synthetic clip IDs;
- shipped-file parsing and generated-artifact consistency.

### 14.10 Live smoke coverage

A local smoke test confirmed both MediaRecorder-container and PCM-to-WAV paths, keep verdict propagation, desktop library visibility, sidecar writing, path-traversal rejection, and journal persistence.

---

## 15. Quick Start

```bash
node --test test/
node desktop/cli.js status

# Optional desktop sidecar
node desktop/cli.js serve --port 8787

# Browser extension
# 1. Open the browser extensions page.
# 2. Enable developer mode.
# 3. Load the unpacked `extension/` directory.
# 4. Open the platform and begin playback.
```

The extension HUD uses status colors:

```text
grey   player element not attached yet
green  attached and idle
red    recording
amber  degraded/error state; detail shown in the HUD
```

---

## 16. CLI and Reporting

Representative commands:

```bash
node desktop/cli.js status
node desktop/cli.js serve --port 8787
node desktop/cli.js report
node desktop/cli.js report --csv
node desktop/cli.js reflect --list
node desktop/cli.js reflect --device "<device>" --secs <duration>
node desktop/cli.js analyze-har <file>
```

Official-download commands validate quota-sensitive operations and require explicit opt-in where appropriate.

---

## 17. Security and Reliability Properties

The bug sweep added or verified several important invariants:

- local file serving enforces boundary-aware root containment;
- temporary PCM files are reclaimed;
- malformed cross-context messages cannot break the relay path;
- capture state is not considered active until the recorder has actually started;
- each take owns its own recorder/chunks/worklet state;
- incomplete captures persist across SPA reloads and service-worker restarts;
- replay is idempotent at both browser-download and sidecar levels;
- synthetic identifiers cannot trigger destructive or mutating platform actions;
- worklet processors do not emit before an explicit take is active;
- reflect failures are explicit rather than silently producing empty files;
- installation and launch paths contain no hard-coded local-user dependency.

---

## 18. Known and Accepted Limitations

The following limitations remain:

- The first take after a fresh page load can fall back to MediaRecorder if the AudioWorklet module is still initializing. The take is still captured and curated; later takes can switch to PCM once the sidecar path is ready.
- ffmpeg is optional rather than bundled. WAV remains the offline path without ffmpeg; M4A/MP3 transcoding requires ffmpeg on `PATH`.
- Browser-rendering behavior, browser-specific shields/privacy modes, actual AudioWorklet loading in every supported browser, and a live official bulk-download round trip require validation on a real browser installation.
- The project does not decrypt protected platform media.
- Official server-side download formats are treated conservatively as quota-sensitive unless independently confirmed otherwise.
- Whether auxiliary browser-token fields are strictly enforced by the platform was not established and is not relied upon for bypass behavior.
- Source quality is bounded by the audio delivered to the browser decode path; container or bitrate inflation does not improve the source.
- The remote-media retention window means local archival remains necessary for long-term preservation.

---

## 19. Data and Privacy Handling

The shareable version of this record intentionally excludes:

- account names and account IDs;
- session IDs, device IDs, and browser-instance identifiers;
- user profile paths;
- clip IDs and synthetic IDs tied to a captured session;
- exact user-generated titles;
- unique media hashes or first-byte fingerprints;
- exact capture timestamps;
- session-specific quota balances;
- exact remote-object expiration timestamps and storage rule IDs;
- unique local playlist names and project branding.

The implementation itself should continue to keep session material local unless the user explicitly invokes a platform API action.

---

## 20. Current State

The consolidated state is:

- current platform behavior has been analyzed from captured traffic and shipped client code;
- legacy direct-download assumptions have been replaced by decoded-playback capture plus official export paths;
- live and offline volume invariance are implemented;
- listen telemetry and segment-level coverage are preserved;
- PCM, MediaRecorder, and OS-loopback tiers are implemented with explicit capability reporting;
- curation and reporting are integrated;
- persistence survives SPA reloads and service-worker restarts;
- 36 confirmed defects were repaired across the desktop service, extension, launcher, durability layer, telemetry path, UI, and packaging;
- regression coverage expanded to 103 passing tests in the final sweep;
- remaining browser/device integration checks are documented rather than assumed.

This document is the single sanitized technical record for the completed work.

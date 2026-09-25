# GenMusicAssist

**Volume-invariant capture + curation for Suno** — saves what you hear, normalizes loudness, and files the best takes. Audacity-style recording, on autopilot.

A Chrome extension (Manifest V3) plus a local Node.js sidecar that together let you play your entire Suno library and keep a personal copy of every track as it plays. Created because as of September 2026, every Suno capture extension on the Chrome store was broken.

> **No DRM circumvention is implemented.** The encrypted M4A is neither fetched nor decrypted. The capture path records what your own player already decoded — the same signal your speakers would get.

## What it does

| Component | What it does |
|---|---|
| `extension/` | Manifest V3 extension for Chromium browsers. Attaches to the Suno player, captures decoded playback (WebM/Opus via MediaRecorder, or raw PCM via an AudioWorklet), mirrors listen telemetry, scores generations, and exposes curation controls in a side panel. |
| `desktop/` | Local Node.js sidecar (listens on `127.0.0.1:8787` only). Receives takes, performs sample-accurate gain correction, loudness normalization to −14 LUFS, WAV writing, metadata sidecars, optional M4A/MP3 transcoding, keep/quarantine curation, reporting, and OS-loopback capture. |

Either component runs standalone:

- **Extension alone** — still captures audio, saved via the Chrome downloads API as `.webm`. You lose normalization, WAV conversion, curation, and rich metadata.
- **Sidecar alone** — still provides OS-loopback capture (with ffmpeg) and the review UI.

### Capability matrix

| Feature | Sidecar running | Sidecar stopped |
|---|---|---|
| Capture audio from Suno | YES (PCM + WebM) | YES (WebM only) |
| Loudness normalize (−14 LUFS) | YES | NO |
| WAV + metadata sidecars | YES | NO |
| Autopilot curation (keep/quarantine) | YES | NO |
| M4A/MP3 export | YES (needs ffmpeg) | NO |
| OS loopback capture | YES (needs ffmpeg) | NO |

## Requirements

- **Node.js 18+** — the only hard dependency
- **ffmpeg** (optional) — for M4A/MP3 export and OS-loopback capture
- **A loopback device** (optional, for OS-level capture) — Stereo Mix, VB-Cable, or WASAPI loopback

## Install

Run `install.bat` (Windows). It checks for Node.js and ffmpeg, offers to install ffmpeg via winget, and detects a loopback device. No Python or CUDA needed.

## Usage

1. Run the sidecar:
   ```
   python sidecar_and_metadata.py
   ```
   (or `npm start` / `node desktop/cli.js serve`)
2. Load the `extension/` folder as an unpacked extension (Chrome/Brave, Developer mode on).
3. Open suno.com and play. **Autorecord** handles everything — your songs land in `captures/`, curated keeps in `keeps/`.

### CLI

```
node desktop/cli.js serve       sidecar + review UI on 127.0.0.1:8787
node desktop/cli.js status      current library state
node desktop/cli.js report      session report
node desktop/cli.js auto --once run one autopilot pass
node desktop/cli.js auto --watch run autopilot continuously
```

`npm test` runs the regression suite (Node's built-in test runner).

### Autopilot

`autopilot.json` controls curation: target loudness (−14 LUFS), keep/discard score thresholds, minimum length, dedupe, playlist organization, and filename template. Run `node desktop/cli.js auto --watch` to let it file takes unattended.

## Audio quality note

Opus-in-MP4 at ~133 kbps is the ceiling of what the browser ever had — captures are written as WebM/Opus (MediaRecorder path) or raw PCM → WAV (AudioWorklet path). The WebM container written live by MediaRecorder has no Duration/Cues elements; `repair-webm.bat` stream-copy remuxes captures with ffmpeg (no re-encoding, ~1 s per file) to restore duration and seeking. See `TECHNICAL-UPDATE.md`.

## Included tooling

- `skills/decode-suno-har/` — a redacting HAR decoder for diagnosing player queue handoffs, wrong clip identity, blank metadata, and missed saves. Treats HAR files as sensitive untrusted input; never prints cookies, auth headers, or signed URLs.
- `scripts/recover-blank-captures.mjs` — repair blank metadata sidecars from a mapping file (`--apply` to write).
- `repair-webm.bat` — ffmpeg remux for duration-less WebM captures.

## License

GPL-3.0-or-later — see `package.json`.

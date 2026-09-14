#!/usr/bin/env python3
"""
GenMusicAssist — Sidecar + Metadata Launcher
==============================================

WHAT THIS DOES:
  Starts the local Node.js sidecar server that receives audio captures from the
  browser extension, normalizes loudness, writes WAV files, and curates keeps.

WHAT THE EXTENSION DOES (without this sidecar running):
  Still captures audio! Falls back to saving webm files via Chrome downloads.
  You lose: loudness normalization, WAV conversion, autopilot curation, metadata.
  You keep: the raw audio files in captures/.

CAPABILITY MATRIX:
  +---------------------------+------------------+------------------+
  | Feature                   | Sidecar Running  | Sidecar Stopped  |
  +---------------------------+------------------+------------------+
  | Capture audio from Suno   | YES (PCM+webm)   | YES (webm only)  |
  | Save to captures/         | YES              | YES              |
  | Loudness normalize (-14LU)| YES              | NO               |
  | Write WAV + metadata      | YES              | NO               |
  | Autopilot curation        | YES              | NO               |
  | Keep/quarantine ranking   | YES              | NO               |
  | M4A/MP3 export            | YES (needs ffmpeg)| NO              |
  | OS loopback capture       | YES (needs ffmpeg)| NO              |
  +---------------------------+------------------+------------------+

REQUIREMENTS:
  - Node.js 18+ (the only hard dependency)
  - ffmpeg (optional — for m4a/mp3 export and OS loopback capture)

USAGE:
    python "sidecar_and_metadata.py"              # start sidecar + open UI
    python "sidecar_and_metadata.py" --no-browser # start sidecar only
    python "sidecar_and_metadata.py" --check      # health check, then exit
"""

import argparse
import os
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from urllib import request as urlreq
from urllib import error as urlerr

HOME = Path(__file__).resolve().parent
SUNO_CAPTURE = HOME / "suno-capture"
DESKTOP_DIRECT = HOME / "desktop" / "server.js"
DESKTOP_NESTED = SUNO_CAPTURE / "desktop" / "server.js"

if DESKTOP_DIRECT.exists():
    PROJECT = HOME
elif DESKTOP_NESTED.exists():
    PROJECT = SUNO_CAPTURE
else:
    PROJECT = HOME
    for _ in range(3):
        if (PROJECT / "desktop" / "server.js").exists():
            break
        PROJECT = PROJECT.parent

SERVER_JS = PROJECT / "desktop" / "server.js"
ROOT = HOME
PORT = 8787
PING = f"http://127.0.0.1:{PORT}/ping"
UI = f"http://127.0.0.1:{PORT}/"

GREEN = "\033[92m"
YELLOW = "\033[93m"
RED = "\033[91m"
DIM = "\033[38;5;244m"
BOLD = "\033[1m"
RESET = "\033[0m"


def say(icon, msg):
    print(f"{icon} {msg}", flush=True)


def ping(timeout=2.0):
    try:
        with urlreq.urlopen(PING, timeout=timeout) as r:
            return r.status == 200
    except (urlerr.URLError, TimeoutError, OSError):
        return False


def find_node():
    from shutil import which
    n = which("node")
    if not n:
        say(RED + "✗", "Node.js not found in PATH.")
        say(DIM + "  ", "Install Node.js 18+ from https://nodejs.org/")
        say(DIM + "  ", "Make sure 'node' is on your PATH.")
        sys.exit(1)
    return n


def start_server():
    env = dict(os.environ, SUNOLIFT_ROOT=str(ROOT))
    flags = 0
    if os.name == "nt":
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    proc = subprocess.Popen(
        [find_node(), str(SERVER_JS), "serve", "--port", str(PORT), "--root", str(ROOT)],
        cwd=str(PROJECT), env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        creationflags=flags,
    )
    say(DIM + "…", f"sidecar starting (pid {proc.pid}) on port {PORT}")

    import threading
    def drain():
        for line in proc.stdout:
            line = line.decode(errors="replace").rstrip()
            print(f"  {DIM}[sidecar]{RESET} {line}", flush=True)
    threading.Thread(target=drain, daemon=True).start()

    for _ in range(40):
        time.sleep(0.25)
        if ping():
            return proc
    say(RED + "✗", "sidecar did not answer /ping within 10 s")
    say(DIM + " ", f"  cd \"{PROJECT}\" && set SUNOLIFT_ROOT={ROOT} && node desktop\\cli.js serve --port {PORT}")
    sys.exit(1)


def main():
    ap = argparse.ArgumentParser(
        description="GenMusicAssist — starts the sidecar that receives, normalizes, and curates audio captures."
    )
    ap.add_argument("--no-browser", action="store_true", help="do not open the review UI")
    ap.add_argument("--check", action="store_true", help="health check only, then exit")
    args = ap.parse_args()

    if not SERVER_JS.exists():
        say(RED + "✗", f"sidecar not found at {SERVER_JS}")
        sys.exit(1)

    print()
    print(f"{BOLD}GenMusicAssist — Sidecar + Metadata{RESET}")
    print(DIM + "─" * 50 + RESET)

    already = ping()
    if already:
        say(GREEN + "✓", "sidecar already running on port 8787")
    else:
        say(DIM + "…", "starting sidecar...")
        proc = start_server()
        if proc and proc.poll() is not None:
            say(RED + "✗", "sidecar process exited immediately")
            sys.exit(1)

    # Health snapshot
    try:
        import json
        with urlreq.urlopen(PING, timeout=3) as r:
            info = json.loads(r.read().decode())
        st = info.get("stats", {})
        say(GREEN + "✓", f"library root: {info.get('root')}")
        say(GREEN + "✓", f"captures: {st.get('captures', 0)} · clips: {st.get('clips', 0)} · {st.get('mb', 0)} MB")
        ffmpeg_ok = info.get("ffmpeg")
        say((GREEN if ffmpeg_ok else YELLOW) + ("✓" if ffmpeg_ok else "!"),
            "ffmpeg " + ("found — m4a/mp3 export enabled" if ffmpeg_ok else "MISSING — WAV only (install ffmpeg for full export)"))
        try:
            with urlreq.urlopen(f"http://127.0.0.1:{PORT}/autopilot", timeout=3) as r:
                ap = json.loads(r.read().decode())
            ast = ap.get("stats", {})
            say(GREEN + "✓", f"autopilot: {'running' if ap.get('running') else 'off'} — "
                f"{ast.get('promoted', 0)} kept, {ast.get('quarantined', 0)} quarantined, "
                f"{ast.get('runs', 0)} pass(es)")
        except Exception as e:
            say(YELLOW + "!", f"autopilot state unreadable: {e}")
    except Exception as e:
        say(YELLOW + "!", f"ping ok but stats unreadable: {e}")

    print()
    print(f"{BOLD}Capability Summary:{RESET}")
    print(f"  {GREEN}✓{RESET} Audio capture from Suno (PCM → sidecar, or webm fallback)")
    print(f"  {GREEN}✓{RESET} Save raw captures to captures/")
    if ffmpeg_ok:
        print(f"  {GREEN}✓{RESET} Loudness normalization to -14 LUFS")
        print(f"  {GREEN}✓{RESET} WAV + metadata sidecar files (.json, .txt, .cue)")
        print(f"  {GREEN}✓{RESET} Autopilot curation (keep / quarantine)")
        print(f"  {GREEN}✓{RESET} M4A/MP3 export")
    else:
        print(f"  {YELLOW}!{RESET} Loudness normalization — needs ffmpeg")
        print(f"  {YELLOW}!{RESET} WAV + metadata — needs ffmpeg")
        print(f"  {YELLOW}!{RESET} Autopilot curation — needs ffmpeg")
        print(f"  {YELLOW}!{RESET} M4A/MP3 export — needs ffmpeg")
        say(DIM + " ", "  (WAV files still work, captures still saved)")

    print()
    print(f"{BOLD}What happens when you play Suno:{RESET}")
    print(f"  1. Extension taps the <audio> element (volume-independent)")
    print(f"  2. Frames stream to sidecar → saved as .raw → finalized to .wav")
    print(f"  3. Autopilot normalizes, scores, and files to keeps/ or quarantine/")
    print(f"  If sidecar is NOT running: extension falls back to webm via downloads")

    if args.check:
        return

    if not args.no_browser:
        say(DIM + "…", "opening review UI")
        webbrowser.open(UI)

    print()
    say(GREEN + "★", f"GenMusicAssist is up: {UI}")
    say(DIM + " ", f"  captures → {ROOT / 'captures'}")
    say(DIM + " ", f"  keeps    → {ROOT / 'keeps'}")
    print()

    # Keep running — don't self-exit
    say(DIM + " ", "sidecar is running in the background. Press Ctrl-C to stop.")
    try:
        while True:
            time.sleep(5)
            if not ping():
                say(YELLOW + "!", "sidecar stopped responding — restart this script")
                say(DIM + " ", "  (captures still work via webm fallback)")
    except KeyboardInterrupt:
        print()
        say(DIM + " ", "Ctrl-C received — exiting launcher (sidecar keeps running)")
        sys.exit(0)


if __name__ == "__main__":
    main()

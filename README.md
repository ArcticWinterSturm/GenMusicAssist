Good vibes for vibe musicans! A chrome extension and webinterface that lets you play your entire library of Suno tracks and keep a personal copy, audacity-style but on autopilot. Created because as of September 2026, all extensions for Suno on Chrome store are broken. This one works as well as could be expected for API that moves extraordinarily fast, going to be a rapidly update. Fork this, make a copy, share it as widely as possible and show it your friends who created more then >6 or whatever good songs that Suno "allows" you to keep - please sir i want some more! : )

Usage
1. Needs node.js
2. Run sidecar_and_metadata.py
3. Load unpacked \extension with Chrome DEV enabled
4. Autorecord will handle everything when on Suno, your songs land in \content

Included is a a genuine load-bearing tech spec written by you-know-who in Analysis.md

Important : Opus-in-MP4 at ~133 kbps is the ceiling of what the browser ever had

No DRM circumvention is implemented. The encrypted M4A is neither fetched nor decrypted here; the capture path records what your own player already decoded.

Enjoy!

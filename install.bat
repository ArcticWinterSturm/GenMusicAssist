@echo off
setlocal enabledelayedexpansion
title GenMusicAssist — Installer
cd /d "%~dp0"

echo.
echo  ============================================================
echo    GenMusicAssist — Installer
echo  ============================================================
echo.
echo   Checks for required tools and activates audio loopback.
echo   No Python or CUDA needed — this is a Node.js app.
echo.
echo   Requirements:
echo     - Node.js 18+ (the sidecar runtime)
echo     - ffmpeg (for m4a/mp3 export and OS loopback capture)
echo     - A loopback device (Stereo Mix, VB-Cable, or WASAPI)
echo.
pause

REM ---------------------------------------------------------------- python
REM No Python needed for GenMusicAssist.
REM The "Please start.py" launcher is a Python convenience wrapper,
REM but the actual runtime is Node.js.

REM ---------------------------------------------------------------- node
echo.
echo  Checking for Node.js 18+...
set "NODE="
for %%C in ("node" "nodejs") do (
    %%C --version >nul 2>nul && (
        for /f "tokens=2" %%v in ('%%C --version 2^>^&1') do (
            set "NV=%%v"
            set "NV=!NV:~1!"
            for /f "tokens=1 delims=." %%a in ("!NV!") do (
                if %%a GEQ 18 set "NODE=%%C"
            )
        )
    )
)
if not defined NODE (
    echo  [X] Node.js not found or version is too old.
    echo.
    echo      GenMusicAssist needs Node.js 18 or newer.
    echo      Download from https://nodejs.org/
    echo      Make sure "Add to PATH" is ticked during setup.
    echo.
    pause
    exit /b 1
)
for /f "tokens=2" %%v in ('%NODE% --version 2^>^&1') do set "NODEVER=%%v"
echo  [i] Found Node.js !NODEVER!

REM ---------------------------------------------------------------- ffmpeg
echo.
echo  Checking for FFmpeg...
set "FFMPEG="
where ffmpeg >nul 2>nul && set "FFMPEG=ffmpeg"
if defined FFMPEG (
    for /f "tokens=*" %%v in ('%FFMPEG% -hide_banner -version 2^>^&1 ^| findstr /i "ffmpeg version"') do set "FFMPEGVER=%%v"
    echo  [i] Found: !FFMPEGVER!
) else (
    echo  [!] FFmpeg not found on PATH.
    echo      WAV capture works without it.
    echo      M4A/MP3 export and OS loopback capture need it.
    echo.
    set /p INSTALL_FF="  Install FFmpeg now via winget? (y/n): "
    if /i "!INSTALL_FF!"=="y" (
        winget install Gyan.FFmpeg
        if errorlevel 1 (
            echo      [X] winget install failed. Install manually from https://ffmpeg.org/download.html
        ) else (
            echo      [i] FFmpeg installed. You may need to restart this terminal.
            where ffmpeg >nul 2>nul && set "FFMPEG=ffmpeg"
        )
    ) else (
        echo      [i] Skipping FFmpeg. Install later with: winget install Gyan.FFmpeg
    )
)

REM ---------------------------------------------------------------- loopback device
echo.
echo  Checking for audio loopback device...
if defined FFMPEG (
    REM Use ffmpeg to list dshow devices and look for Stereo Mix or loopback
    set "LOOPBACK_FOUND=0"
    for /f "delims=" %%d in ('%FFMPEG% -hide_banner -list_devices true -f dshow -i dummy 2^>^&1 ^| findstr /i "Stereo Mix\|What U Hear\|Loopback\|BlackHole\|SoundFlower\|VB-Cable\|Monitor"') do (
        set "LOOPBACK_FOUND=1"
        echo  [i] Loopback device found: %%d
    )
    
    if "!LOOPBACK_FOUND!"=="0" (
        echo  [!] No loopback device detected.
        echo      You can still capture audio via the browser extension.
        echo      OS-level loopback (recording what you hear) needs one of:
        echo.
        echo      Option A: Enable Stereo Mix (built into Realtek drivers)
        echo        1. Right-click the speaker icon ^> Sounds
        echo        2. Recording tab
        echo        3. Right-click empty area ^> Show Disabled Devices
        echo        4. Enable "Stereo Mix"
        echo.
        echo      Option B: Install VB-Cable (virtual audio cable)
        echo        winget install VB-Audio.VBCable
        echo        (free, creates a virtual input that mirrors your output)
        echo.
        echo      Option C: Use WASAPI loopback (default speaker, Bluetooth, USB)
        echo        The app falls back to this automatically, but it only
        echo        captures after the app starts — not a persistent device.
        echo.
    ) else (
        echo  [i] Loopback ready for OS-level capture.
    )
) else (
    echo  [i] Skipping loopback check (ffmpeg not available).
)

REM ---------------------------------------------------------------- verify bundle
echo.
echo  Verifying extension bundle...
%NODE% -e "require('fs').accessSync('extension/lib/sunolift-bundle.js'); console.log('  [i] bundle exists')" 2>nul
if errorlevel 1 (
    echo  [!] Extension bundle not found. Regenerate with:
    echo      node tools/bundle-shared.js
    echo      (if tools/ directory exists — otherwise it ships pre-built)
)

REM ---------------------------------------------------------------- done
echo.
echo  ============================================================
echo    Done.
echo  ============================================================
echo.
echo   To start the sidecar:
echo     python "sidecar_and_metadata.py"
echo.
echo   To start capturing:
echo     1. Load the extension from the extension/ folder in Chrome/Brave
echo     2. Run the sidecar (above)
echo     3. Open suno.com and play something
echo.
echo   Captures land in:   captures/
echo   Curated keeps go:  keeps/
echo.
pause

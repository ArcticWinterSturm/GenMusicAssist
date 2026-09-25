@echo off
REM GenMusicAssist — repair existing WebM captures that have no Duration / no seek
REM ---------------------------------------------------------------------------
REM MediaRecorder muxes WebM live, sequentially — no Duration element, no Cues
REM (seek index). VLC reports duration=0, ffprobe fails with "EBML header parsing
REM failed" (exit 3199971767). This script stream-copy remuxes every .webm in the
REM captures folder, which fixes the container without re-encoding (no quality
REM loss, ~1 second per file).
REM
REM Usage:
REM   repair-webm.bat                  REM repair all webm in captures/
REM   repair-webm.bat "C:\path\to\dir" REM repair all webm in a specific dir

setlocal enabledelayedexpansion

if "%~1"=="" (
  REM No path given: use a "captures" folder next to this script.
  set "TARGET=%~dp0captures"
) else (
  set "TARGET=%~1"
)

if not exist "%TARGET%" (
  echo Target folder not found: %TARGET%
  exit /b 1
)

where ffmpeg >nul 2>&1
if errorlevel 1 (
  echo ffmpeg not found in PATH — install it first.
  exit /b 1
)

echo Repairing WebM files in: %TARGET%
echo.

set FIXED=0
set FAILED=0

for %%F in ("%TARGET%\*.webm") do (
  echo   %%~nxF
  ffmpeg -y -v error -i "%%F" -c copy "%%F.remuxing.webm"
  if errorlevel 1 (
    echo     FAILED — keeping original
    if exist "%%F.remuxing.webm" del "%%F.remuxing.webm" 2>nul
    set /a FAILED+=1
  ) else (
    move /y "%%F.remuxing.webm" "%%F" >nul
    if errorlevel 1 (
      echo     FAILED to replace — keeping original
      del "%%F.remuxing.webm" 2>nul
      set /a FAILED+=1
    ) else (
      set /a FIXED+=1
    )
  )
)

echo.
echo Done. Fixed: %FIXED%   Failed: %FAILED%
pause

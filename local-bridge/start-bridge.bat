@echo off
setlocal EnableDelayedExpansion
title MADchatter Local Bridge
pushd "%~dp0"
chcp 65001 >nul 2>&1

:: ── ANSI palette (Windows 10+ terminals) ──────────────────────────────
for /F %%a in ('echo prompt $E ^| cmd') do set "ESC=%%a"
set "R=%ESC%[0m"
set "B=%ESC%[1m"
set "DIM=%ESC%[90m"
set "RED=%ESC%[91m"
set "GRN=%ESC%[92m"
set "YEL=%ESC%[93m"
set "CYN=%ESC%[96m"
set "MAG=%ESC%[95m"

cls
echo.
echo   %CYN%━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%R%
echo.
echo      %B%MADchatter%R%  %MAG%◆%R%  %B%Local Bridge%R%
echo      %DIM%loopback audio  →  faster-whisper  →  MADchatter%R%
echo.
echo   %CYN%━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%R%
echo.

:: ── Resolve per-user config dir ────────────────────────────────────────
if defined APPDATA (
  set "BRIDGE_DIR=%APPDATA%\MADchatter\LocalBridge"
) else (
  set "BRIDGE_DIR=%USERPROFILE%\AppData\Roaming\MADchatter\LocalBridge"
)

:: ── Effective port: config.json overrides the 8765 default ────────────
set "PORT=8765"
if exist "%BRIDGE_DIR%\config.json" (
  for /f "tokens=2 delims=:,{} " %%p in ('findstr /i "port" "%BRIDGE_DIR%\config.json"') do set "PORT=%%p"
)

:: ── Already running? ───────────────────────────────────────────────────
echo   %DIM%── preflight ──────────────────────────────────────────────%R%
curl -s -m 2 -o nul "http://127.0.0.1:%PORT%/v1/health" 2>nul
if !errorlevel!==0 (
  echo   %YEL%●%R%  Bridge is already listening on %CYN%http://127.0.0.1:%PORT%%R%
  echo      %DIM%Close the other instance first, then relaunch.%R%
  echo.
  pause
  exit /b 0
)
echo   %GRN%✓%R%  port %CYN%127.0.0.1:%PORT%%R% is free

:: ── Python resolution: project venv > py launcher > system python ─────
set "PY="
if exist "%~dp0.venv\Scripts\python.exe" (
  set "PY=%~dp0.venv\Scripts\python.exe"
  set "PY_LABEL=project .venv"
)
if not defined PY (
  where py >nul 2>&1 && (set "PY=py -3" & set "PY_LABEL=py launcher")
)
if not defined PY (
  where python >nul 2>&1 && (set "PY=python" & set "PY_LABEL=system PATH")
)
if not defined PY (
  echo   %RED%✗%R%  Python 3.10+ not found
  echo      %DIM%Install from https://python.org and retry.%R%
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('%PY% --version 2^>^&1') do set "PYVER=%%v"
echo   %GRN%✓%R%  !PYVER!  %DIM%(!PY_LABEL!)%R%

:: ── Dependency probe (module presence, no imports) ────────────────────
set "MODS="
for /f "delims=" %%m in ('%PY% -c "import importlib.util as u; print(' '.join(m for m in ('faster_whisper','pyaudiowpatch','streamlink','fastapi','uvicorn') if u.find_spec(m)))" 2^>nul') do set "MODS=%%m"

echo !MODS! | findstr /i "faster_whisper" >nul && (
  echo   %GRN%✓%R%  faster-whisper %DIM%· transcription engine%R%
) || (
  echo   %RED%✗%R%  faster-whisper %DIM%· REQUIRED — run:%R%
  echo        %DIM%!PY! -m pip install faster-whisper%R%
)
echo !MODS! | findstr /i "fastapi" >nul && (
  echo   %GRN%✓%R%  fastapi + uvicorn %DIM%· HTTP/SSE API%R%
) || (
  echo   %RED%✗%R%  fastapi/uvicorn %DIM%· REQUIRED — run:%R%
  echo        %DIM%!PY! -m pip install fastapi uvicorn%R%
)
echo !MODS! | findstr /i "streamlink" >nul && (
  echo   %GRN%✓%R%  streamlink %DIM%· direct stream capture%R%
) || (
  echo   %YEL%○%R%  streamlink %DIM%· missing — direct stream disabled%R%
)
echo !MODS! | findstr /i "pyaudiowpatch" >nul && (
  echo   %GRN%✓%R%  PyAudioWPatch %DIM%· system audio ^(WASAPI loopback^)%R%
) || (
  echo   %YEL%○%R%  PyAudioWPatch %DIM%· missing — system audio disabled%R%
)
where ffmpeg >nul 2>&1 && (
  echo   %GRN%✓%R%  ffmpeg %DIM%· on PATH%R%
) || (
  echo   %YEL%○%R%  ffmpeg %DIM%· not on PATH — set FFMPEG_PATH%R%
)

:: ── Abort if the hard requirements are missing ────────────────────────
echo !MODS! | findstr /i "faster_whisper" >nul || set "FATAL=1"
echo !MODS! | findstr /i "fastapi" >nul       || set "FATAL=1"
echo !MODS! | findstr /i "uvicorn" >nul       || set "FATAL=1"
if defined FATAL (
  echo.
  echo   %RED%Required dependencies are missing — see above.%R%
  echo.
  pause
  exit /b 1
)

:: ── Session info ───────────────────────────────────────────────────────
set "TOKEN="
set "TOKEN_FILE=%BRIDGE_DIR%\bridge_token"
if exist "%TOKEN_FILE%" set /p "TOKEN=" <"%TOKEN_FILE%"

echo.
echo   %DIM%── session ────────────────────────────────────────────────%R%
echo      %DIM%endpoint%R%   %CYN%http://127.0.0.1:!PORT!%R%
if defined TOKEN (
  echo      %DIM%token%R%      %YEL%!TOKEN!%R%
) else (
  echo      %DIM%token%R%      %DIM%^(generated on first run — watch the log below^)%R%
)
echo      %DIM%config%R%     !BRIDGE_DIR!
echo.
echo   %DIM%Paste the token into MADchatter → Local Bridge panel → Details.%R%
echo.
echo   %DIM%── logs ───────────────────────────────────────────────────%R%
echo.

:: ── Launch ─────────────────────────────────────────────────────────────
%PY% -m madchatter_bridge %*
set "RC=!errorlevel!"

echo.
echo   %CYN%━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%R%
if !RC! equ 0 (
  echo   %DIM%Bridge stopped cleanly.%R%
) else (
  echo   %RED%✗%R%  Bridge exited with code !RC!.
)
echo.
pause
exit /b !RC!

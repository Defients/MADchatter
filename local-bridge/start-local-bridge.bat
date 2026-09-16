@echo off
REM MADchatter Local Bridge -- Windows launcher
REM Starts the Bridge on 127.0.0.1:8765. Requires Python 3.11+ and dependencies.

setlocal

REM Try common Python launchers in order of preference.
where py >nul 2>&1 && (
  set "PY=py -3"
  goto :run
)
where python >nul 2>&1 && (
  set "PY=python"
  goto :run
)
echo [bridge] Python was not found. Install Python 3.11+ from https://python.org and retry.
exit /b 1

:run
echo [bridge] Starting MADchatter Local Bridge...
echo [bridge] First run will print a local token -- copy it into MADchatter's Local Bridge panel.
echo.

REM If a venv exists in local-bridge/.venv, use it; otherwise use system Python.
if exist "%~dp0.venv\Scripts\python.exe" (
  set "PY=%~dp0.venv\Scripts\python.exe"
)

%PY% -m madchatter_bridge %*

endlocal

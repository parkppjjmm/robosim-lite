@echo off
rem RoboSim Lite launcher: starts serve.py (local web server) and opens the browser.
rem Closing this window stops the server.
cd /d "%~dp0"
set PYTHONUTF8=1
set PY=
where python >nul 2>nul && set PY=python
if not defined PY where py >nul 2>nul && set PY=py
if not defined PY (
  echo Python is not installed. Install it from https://www.python.org and run again.
  pause
  exit /b 1
)
%PY% serve.py
if errorlevel 1 pause

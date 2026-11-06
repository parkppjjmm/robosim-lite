@echo off
rem RoboSim Lite v3.0.0 - training launcher (PPO / evolution search / evaluation) without Claude
rem Keep this file ASCII + CRLF (cmd closes immediately on UTF-8 Korean or LF)
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 18 or later is required. Install from https://nodejs.org and run again.
  pause
  exit /b 1
)
node tools\launcher.mjs %*
pause

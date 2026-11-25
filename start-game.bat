@echo off
chcp 65001 >NUL
title Mafia Game Server
cd /d "%~dp0"
where node >NUL 2>NUL
if errorlevel 1 (
  echo.
  echo [X] Node.js is not installed.
  echo     Download the LTS version from https://nodejs.org then run this file again.
  echo.
  start https://nodejs.org
  pause
  exit /b
)
start "" /min cmd /c "timeout /t 2 >NUL & start http://localhost:3000"
node server.js
pause

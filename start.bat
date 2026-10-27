@echo off
setlocal enabledelayedexpansion
rem  RH Canvas Video Generator - launcher
rem  Double-click to start; if already running it just re-opens the console.
cd /d "%~dp0"
title RH Canvas Launcher

rem Prevent env leak that turns electron into plain node
set "ELECTRON_RUN_AS_NODE="

set API=http://127.0.0.1:19387

curl -s -o nul -w "%%{http_code}" --max-time 2 "%API%/api/status" > "%TEMP%\rh_port.txt"
set /p CODE=<"%TEMP%\rh_port.txt"
del "%TEMP%\rh_port.txt" 2>nul

if "%CODE%"=="200" (
  echo [OK] App already running at %API% - bringing console to front
  start "" ".\node_modules\electron\dist\electron.exe" .
  ping -n 3 127.0.0.1 >nul
  exit /b 0
)

if not exist ".\node_modules\electron\dist\electron.exe" (
  echo [ERR] Dependencies missing - run: npm install
  pause
  exit /b 1
)

echo [*] Starting RH Canvas Video Generator...
start "" ".\node_modules\electron\dist\electron.exe" .

rem Wait for API up to 20s
for /l %%i in (1,1,20) do (
  ping -n 2 127.0.0.1 >nul
  curl -s -o nul -w "%%{http_code}" --max-time 2 "%API%/api/status" > "%TEMP%\rh_port.txt"
  set /p CODE=<"%TEMP%\rh_port.txt"
  if "!CODE!"=="200" goto :ready
)
del "%TEMP%\rh_port.txt" 2>nul
echo [ERR] Startup timed out - check the console window
pause
exit /b 1

:ready
del "%TEMP%\rh_port.txt" 2>nul
echo [OK] Started. API at %API%
echo      First use: console window -^> "Show canvas" -^> login
exit /b 0

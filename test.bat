@echo off
rem  RH Canvas Video Generator - API smoke test
rem  Usage: test.bat        connectivity + login + scan only (no canvas writes)
rem         test.bat gen   also runs one generate job (nodes auto-cleaned after)
cd /d "%~dp0"
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\test-api.ps1" %*
pause

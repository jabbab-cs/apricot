@echo off
rem Starts Apricot. The first run installs everything it needs (Android tools, a virtual phone, ~2 GB).
setlocal
set "ROOT=%~dp0"
if not exist "%ROOT%server\vendor\.setup-done" goto setup
if not exist "%ROOT%server\node_modules" goto setup
goto start
:setup
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\setup-windows.ps1" || exit /b 1
:start
node "%ROOT%server\src\index.js" %*

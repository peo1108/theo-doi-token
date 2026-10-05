@echo off
rem Start tray icon + hidden server, then open the dashboard. For server logs run: node tracker.js serve
cd /d "%~dp0"
start "" powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0tray.ps1" -Open

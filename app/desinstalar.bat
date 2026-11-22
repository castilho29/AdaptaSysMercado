@echo off
cd /d "%~dp0"
title Desinstalar AdaptaSys Mercado
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0desinstalar.ps1"
echo.
pause

@echo off
cd /d "%~dp0"
title Instalar AdaptaSys Mercado
rem --- pede permissao de administrador sozinho ---
net session >nul 2>&1
if errorlevel 1 (
  echo Pedindo permissao de administrador...
  if "%~1"=="" (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  ) else (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
  )
  exit /b
)
echo.
echo  ==============================================
echo    Instalar / atualizar o AdaptaSys Mercado
echo  ==============================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar.ps1" %*
echo.
pause

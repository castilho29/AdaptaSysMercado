@echo off
rem Gera o instalador .exe neste PC (precisa do Node.js 22 e do Inno Setup 6 instalados)
cd /d "%~dp0.."
node scripts\montar.js || goto erro
set /p VERSAO=<dist\versao.txt
"%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" /DVersao=%VERSAO% instalador\MercadoOnline.iss || goto erro
echo.
echo Pronto: dist\MercadoOnline-Setup-%VERSAO%.exe
pause
exit /b 0
:erro
echo Falhou.
pause
exit /b 1

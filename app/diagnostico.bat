@echo off
cd /d "%~dp0"
title Diagnostico do Mercado Online
if exist "%~dp0instalado.txt" goto instalado
echo Versao do Node:
node --version
echo.
echo Ligando o servidor nesta janela (feche a janela para parar)...
echo Se aparecer um erro, tire um print desta tela.
echo.
node --no-warnings server.js
echo.
echo O servidor parou. Codigo: %errorlevel%
pause
exit /b

:instalado
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
type "%~dp0instalado.txt"
echo.
"%~dp0node\node.exe" --version
echo.
echo --- tarefa do Windows ---
schtasks /Query /TN "Mercado Online" /V /FO LIST | findstr /I "Status Ultimo Last Executar Run"
echo.
echo --- porta ---
type "%ProgramData%\MercadoOnline\pub\porta.txt"
echo.
echo --- o servidor esta respondendo? ---
powershell -NoProfile -Command "try { $p=(Get-Content \"$env:ProgramData\MercadoOnline\pub\porta.txt\" -Raw).Trim(); $r=Invoke-RestMethod -UseBasicParsing -Uri \"http://127.0.0.1:$p/api/status\" -TimeoutSec 4; 'SIM, porta ' + $p + ', versao ' + $r.versao } catch { 'NAO: ' + $_.Exception.Message }"
echo.
echo --- teste: ligar o servidor e ver se da erro ---
set "PDV_DATA=%ProgramData%\MercadoOnline\dados"
set "PDV_PUB=%ProgramData%\MercadoOnline\pub"
set "PDV_SO_TESTAR=1"
"%~dp0node\node.exe" --no-warnings "%~dp0server.js"
set "PDV_SO_TESTAR="
echo.
if exist "%ProgramData%\MercadoOnline\dados\erro-ao-ligar.txt" (
  echo --- ERRO DA ULTIMA VEZ QUE TENTOU LIGAR ---
  type "%ProgramData%\MercadoOnline\dados\erro-ao-ligar.txt"
  echo.
)
echo --- ultimas linhas do log ---
powershell -NoProfile -Command "Get-Content \"$env:ProgramData\MercadoOnline\dados\log.txt\" -Tail 40 -Encoding UTF8"
echo.
echo Tire um print desta janela e mande para o suporte.
pause

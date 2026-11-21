@echo off
rem Para o servidor do PDV (precisa de administrador quando o PDV esta instalado).
if exist "%~dp0instalado.txt" (
  net session >nul 2>&1
  if errorlevel 1 (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
  )
  echo.> "%ProgramData%\MercadoOnline\dados\parar.flag"
  schtasks /End /TN "Mercado Online" >nul 2>&1
)
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'wscript.exe' -and $_.CommandLine -like '*iniciar.vbs*') -or ($_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*iniciar-servidor.bat*') -or ($_.Name -eq 'conhost.exe' -and $_.CommandLine -like '*server.js*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 300; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo Servidor do PDV parado. (Instalado: ele volta sozinho em alguns minutos ou ao reiniciar o computador.)
if exist "%~dp0instalado.txt" pause

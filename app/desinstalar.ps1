# Remove o PDV deste computador. Os DADOS (vendas, notas, certificado) ficam guardados,
# a menos que voce digite APAGAR.
$ErrorActionPreference = 'Continue'
$app = Join-Path $env:ProgramFiles 'AdaptaSysMercado'
$base = Join-Path $env:ProgramData 'AdaptaSysMercado'
Write-Host ''
Write-Host '  Isto remove o PDV deste computador.' -ForegroundColor Yellow
$r = Read-Host '  Digite SIM para continuar'
if ($r -ne 'SIM') { Write-Host '  Nada foi feito.'; exit }
try { Stop-ScheduledTask -TaskName 'AdaptaSys Mercado' -ErrorAction SilentlyContinue } catch { }
Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'wscript.exe' -and $_.CommandLine -like '*iniciar.vbs*') -or (($_.Name -eq 'node.exe' -or $_.Name -eq 'conhost.exe') -and $_.CommandLine -like '*server.js*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1
try { Unregister-ScheduledTask -TaskName 'AdaptaSys Mercado' -Confirm:$false -ErrorAction SilentlyContinue } catch { }
Get-NetFirewallRule -DisplayName 'AdaptaSys Mercado*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
$desk = [Environment]::GetFolderPath('CommonDesktopDirectory'); $start = [Environment]::GetFolderPath('CommonStartup')
foreach ($v in @("$desk\PDV AdaptaSys Mercado.lnk", "$desk\Gestao AdaptaSys Mercado.lnk", "$desk\Reiniciar PDV.lnk", "$start\Abrir PDV AdaptaSys Mercado.lnk")) { Remove-Item $v -ErrorAction SilentlyContinue }
Set-Location $env:TEMP
Remove-Item $app -Recurse -Force -ErrorAction SilentlyContinue
Write-Host '  [ok] Programa removido.' -ForegroundColor Green
Write-Host ''
Write-Host "  Os dados continuam guardados em $base\dados" -ForegroundColor Cyan
Write-Host '  (se instalar de novo, tudo volta como estava).'
$r = Read-Host '  Para APAGAR TAMBEM os dados (vendas, notas, certificado) digite APAGAR, ou Enter para manter'
if ($r -eq 'APAGAR') { Remove-Item $base -Recurse -Force -ErrorAction SilentlyContinue; Write-Host '  Dados apagados.' } else { Write-Host '  Dados mantidos.' }

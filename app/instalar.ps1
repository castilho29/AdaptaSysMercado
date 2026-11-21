# Instalador do Mercado Online (PDV + Gestao), um por empresa
#  - Programa em  C:\Program Files\MercadoOnline   (usuarios comuns so leem)
#  - Dados em     C:\ProgramData\MercadoOnline\dados (so o Windows/SYSTEM e administradores)
#  - Atualiza sozinho uma instalacao antiga "PDV-Mezzomo" (traz dados, atalhos e tarefa)
#  - O servidor roda como tarefa do Windows na conta SYSTEM, sem janela, desde o boot.
#  - Modo "servidor com caixas na rede": cria sozinho a liberacao do firewall,
#    valendo so para a rede local da loja e so para o programa do PDV.
param([string]$Modo = '')
$ModoPedido = $Modo
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$src   = Split-Path -Parent $MyInvocation.MyCommand.Path
$app   = Join-Path $env:ProgramFiles 'MercadoOnline'
$base  = Join-Path $env:ProgramData 'MercadoOnline'
$appV  = Join-Path $env:ProgramFiles 'PDV-Mezzomo'      # nome antigo do programa
$baseV = Join-Path $env:ProgramData 'PDV-Mezzomo'
$dados = Join-Path $base 'dados'
$pub   = Join-Path $base 'pub'
$TASK  = 'Mercado Online'
$FWNOME = 'Mercado Online (caixas da loja)'
$TASKV = 'PDV Mezzomo'
$PORTAS = @(7070, 8765, 18765, 28765, 5765, 3765, 9876, 6543)
$ws = New-Object -ComObject WScript.Shell
function Ok($t)   { Write-Host "  [ok] $t" -ForegroundColor Green }
function Info($t) { Write-Host "       $t" }
function Aviso($t){ Write-Host "  [!]  $t" -ForegroundColor Yellow }

$adm = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $adm) { Aviso 'Precisa ser executado como administrador (use o instalar.bat).'; exit 1 }

# ---------------------------------------------------------------- modo
$atual = ''
$instTxt = if (Test-Path "$app\instalado.txt") { "$app\instalado.txt" } elseif (Test-Path "$appV\instalado.txt") { "$appV\instalado.txt" } else { $null }
if ($instTxt) {
  $l = Get-Content $instTxt | Where-Object { $_ -like 'modo=*' } | Select-Object -First 1
  if ($l) { $atual = $l.Substring(5).Trim() }
}
$nomes = @{ servidor = 'Servidor (so este computador)'; rede = 'Servidor com outros caixas na rede'; caixa = 'Caixa da rede (outro computador)' }
if ($Modo -eq 'manter') { $Modo = $atual }
if (-not $Modo) {
  Write-Host ''
  if ($atual) { Write-Host "  Ja instalado neste computador como: $($nomes[$atual])" -ForegroundColor Cyan; Write-Host '' }
  Write-Host '  Como este computador vai ser usado?'
  Write-Host ''
  Write-Host '   1 - SERVIDOR: o computador principal, so ele usa o PDV'
  Write-Host '   2 - SERVIDOR + CAIXAS: o computador principal, e outros caixas da loja vao usar ele'
  Write-Host '   3 - CAIXA: um caixa a mais, que usa o servidor da loja pela rede'
  Write-Host ''
  $dica = if ($atual) { ' (Enter = manter como esta)' } else { '' }
  do {
    $r = Read-Host "  Digite 1, 2 ou 3$dica"
    if (-not $r -and $atual) { $Modo = $atual }
    elseif ($r -eq '1') { $Modo = 'servidor' } elseif ($r -eq '2') { $Modo = 'rede' } elseif ($r -eq '3') { $Modo = 'caixa' }
  } while (-not $Modo)
}
if (-not $nomes.ContainsKey($Modo)) { Aviso "Modo desconhecido: $Modo"; exit 1 }
Write-Host ''
Write-Host "  Instalando como: $($nomes[$Modo])" -ForegroundColor Cyan
Write-Host ''

# ---------------------------------------------------------------- 0) conferir o pacote e as versoes
function Ver-De($pasta) { try { return [string](Get-Content (Join-Path $pasta 'manifest.json') -Raw | ConvertFrom-Json).versao } catch { return '' } }
if (-not (Test-Path (Join-Path $src 'server.js')) -or -not (Test-Path (Join-Path $src 'public\gestao.html')) -or -not (Test-Path (Join-Path $src 'manifest.json'))) {
  Aviso 'Esta pasta nao tem o programa completo.'
  Info 'Extraia o arquivo Mercado-Online.zip inteiro antes (botao direito > Extrair tudo)'
  Info 'e rode o atualizar.bat que esta DENTRO da pasta extraida (MercadoOnline).'
  exit 1
}
$verNova = Ver-De $src
$verVelha = if (Test-Path (Join-Path $app 'manifest.json')) { Ver-De $app } elseif (Test-Path (Join-Path $appV 'manifest.json')) { Ver-De $appV } else { '' }
$rodandoDaInstalada = (Test-Path $app) -and ((Resolve-Path $src).Path.TrimEnd('\') -ieq (Resolve-Path $app).Path.TrimEnd('\'))
if ($rodandoDaInstalada -and $ModoPedido -eq 'manter') {
  Aviso 'Voce rodou o atualizar.bat da pasta onde o sistema JA esta instalado.'
  Info 'Assim nada muda. Para atualizar: baixe o Mercado-Online.zip novo, extraia'
  Info 'e rode o atualizar.bat que esta dentro da pasta extraida.'
  Info "(versao instalada agora: $verVelha)"
  exit 1
}
if ($verVelha) { Write-Host "  Versao instalada: $verVelha   ->   versao nova: $verNova" -ForegroundColor Cyan }
else { Write-Host "  Versao a instalar: $verNova" -ForegroundColor Cyan }
if ($verVelha -and $verNova -and ($verNova -lt $verVelha)) { Aviso "Este pacote ($verNova) e MAIS ANTIGO que o instalado ($verVelha). Confira se baixou o arquivo certo." }
Write-Host ''

# ---------------------------------------------------------------- 1) parar o que estiver rodando
function Parar-Pdv {
  foreach ($t in @($TASK, $TASKV)) { try { Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue } catch { } }
  Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq 'wscript.exe' -and $_.CommandLine -like '*iniciar.vbs*') -or
    ($_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*iniciar-servidor.bat*') -or
    (($_.Name -eq 'node.exe' -or $_.Name -eq 'conhost.exe') -and $_.CommandLine -like '*server.js*')
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  # fecha as janelas do PDV e da Gestao (senao elas continuam mostrando a versao antiga ate alguem recarregar)
  Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') -and ($_.CommandLine -like '*MercadoOnline*navegador*' -or $_.CommandLine -like '*PDV-Mezzomo*navegador*')
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 1200
}
Parar-Pdv
Ok 'PDV parado para instalar.'

# ---------------------------------------------------------------- 2) pastas e copia do programa
New-Item -ItemType Directory -Force -Path $app, $base, $dados, $pub | Out-Null
$mesmo = ((Resolve-Path $src).Path.TrimEnd('\') -ieq (Resolve-Path $app).Path.TrimEnd('\'))
if (-not $mesmo) {
  & robocopy.exe "$src" "$app" /MIR /XD dados dados-ANTIGO* node node_modules navegador /XF instalado.txt *.log /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { Aviso "Falha ao copiar os arquivos (robocopy $LASTEXITCODE)."; exit 1 }
}
Get-ChildItem -Path $app -Recurse -File | Unblock-File -ErrorAction SilentlyContinue
$verCopiada = Ver-De $app
if ($verNova -and ($verCopiada -ne $verNova)) { Aviso "A copia nao terminou certo (na pasta do programa ficou a versao '$verCopiada'). Feche o PDV e rode de novo."; exit 1 }
Ok "Programa copiado para $app (versao $verCopiada)"

# ---------------------------------------------------------------- 3) Node.js proprio do PDV
function Versao-Ok($exe) {
  try { $v = ([string](& $exe -p "process.versions.node")).Trim(); $p = $v.Split('.'); return ([int]$p[0] -gt 22 -or ([int]$p[0] -eq 22 -and [int]$p[1] -ge 13)) } catch { return $false }
}
$nodeExe = Join-Path $app 'node\node.exe'
# o instalador .exe ja traz o Node.js junto (pasta node ao lado deste script): usa sem baixar nada
$nodeEmb = Join-Path $src 'node\node.exe'
if ((Test-Path $nodeEmb) -and (Versao-Ok $nodeEmb)) {
  $vEmb = ([string](& $nodeEmb -p "process.versions.node")).Trim()
  $vApp = if (Test-Path $nodeExe) { try { ([string](& $nodeExe -p "process.versions.node")).Trim() } catch { '' } } else { '' }
  if ($vEmb -ne $vApp) {
    New-Item -ItemType Directory -Force -Path (Join-Path $app 'node') | Out-Null
    Copy-Item $nodeEmb $nodeExe -Force
    Ok "Node.js $vEmb (incluso no instalador) pronto para o PDV."
  }
}
if (-not (Test-Path $nodeExe) -or -not (Versao-Ok $nodeExe)) {
  New-Item -ItemType Directory -Force -Path (Join-Path $app 'node') | Out-Null
  $baixou = $false
  try {
    Info 'Baixando o Node.js (so na primeira vez, uns 30 MB)...'
    $arq = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win-arm64' } elseif ([Environment]::Is64BitOperatingSystem) { 'win-x64' } else { 'win-x86' }
    $idx = Invoke-RestMethod -UseBasicParsing -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 30
    $ver = ($idx | Where-Object { $_.version -like 'v22.*' -and $_.lts } | Select-Object -First 1).version
    if (-not $ver) { throw 'versao nao encontrada' }
    $nome = "node-$ver-$arq"
    $tmp = Join-Path $env:TEMP ("pdvnode-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $zip = Join-Path $tmp "$nome.zip"
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$ver/$nome.zip" -OutFile $zip -TimeoutSec 600
    $sums = (Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$ver/SHASUMS256.txt" -TimeoutSec 30).Content
    $esper = ($sums -split "`n" | Where-Object { $_ -match "\s$([regex]::Escape($nome)).zip\s*$" } | Select-Object -First 1)
    $hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if (-not $esper -or -not $esper.ToLower().StartsWith($hash)) { throw 'o arquivo baixado nao confere (SHA256)' }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    Copy-Item (Join-Path $tmp "$nome\node.exe") $nodeExe -Force
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    $baixou = $true
    Ok "Node.js $ver instalado so para o PDV."
  } catch { Aviso "Nao consegui baixar o Node.js: $($_.Exception.Message)" }
  if (-not $baixou) {
    $sis = (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if ($sis -and (Versao-Ok $sis)) { Copy-Item $sis $nodeExe -Force; Ok "Usando o Node.js ja instalado no Windows ($sis)." }
    else {
      Aviso 'Sem Node.js. Conecte na internet e rode o instalador de novo'
      Info '(ou instale o Node.js LTS de https://nodejs.org/pt e rode de novo).'
      exit 1
    }
  }
} else { Ok 'Node.js do PDV ja estava instalado.' }

# ---------------------------------------------------------------- 4) trazer os dados da versao antiga
function Pasta-Antiga {
  $c = New-Object System.Collections.ArrayList
  [void]$c.Add((Join-Path $src 'dados'))
  [void]$c.Add('C:\PDV-Mezzomo\dados')
  foreach ($lnk in @("$([Environment]::GetFolderPath('Startup'))\Servidor PDV Mezzomo.lnk", "$([Environment]::GetFolderPath('Desktop'))\PDV Mercado Mezzomo.lnk")) {
    if (Test-Path $lnk) { try { $w = $ws.CreateShortcut($lnk).WorkingDirectory; if ($w) { [void]$c.Add((Join-Path $w 'dados')) } } catch { } }
  }
  foreach ($d in $c) { if ($d -and (Test-Path (Join-Path $d 'pdv.db')) -and ($d -ine $dados)) { return $d } }
  return $null
}
# instalacao anterior com o nome antigo (C:\ProgramData\PDV-Mezzomo): MOVE os dados para o lugar novo
if ((Test-Path (Join-Path $baseV 'dados\pdv.db')) -and -not (Test-Path (Join-Path $dados 'pdv.db'))) {
  Info 'Trazendo os dados da instalacao anterior (PDV-Mezzomo)...'
  & robocopy.exe (Join-Path $baseV 'dados') "$dados" /E /XF porta.txt parar.flag /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8 -or -not (Test-Path (Join-Path $dados 'pdv.db'))) { Aviso 'Falha ao copiar os dados anteriores. Nada foi apagado; chame o tecnico.'; exit 1 }
  $perfV = Join-Path $env:LOCALAPPDATA 'PDV-Mezzomo\navegador'; $perfN = Join-Path $env:LOCALAPPDATA 'MercadoOnline\navegador'
  if ((Test-Path $perfV) -and -not (Test-Path $perfN)) { & robocopy.exe "$perfV" "$perfN" /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null }
  try { Rename-Item -Path (Join-Path $baseV 'dados') -NewName ('dados-ANTIGO-ja-copiado-' + (Get-Date -Format 'yyyyMMdd-HHmm')) } catch { }
  Ok 'Dados da instalacao anterior trazidos (vendas, notas, certificado, configuracao).'
}
$velha = Pasta-Antiga
if ($velha -and -not (Test-Path (Join-Path $dados 'pdv.db'))) {
  Info "Trazendo vendas, produtos e notas de: $velha"
  & robocopy.exe "$velha" "$dados" /E /XD navegador /XF porta.txt parar.flag /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8 -or -not (Test-Path (Join-Path $dados 'pdv.db'))) { Aviso 'Falha ao copiar os dados antigos. Nada foi apagado; chame o tecnico.'; exit 1 }
  $perfil = Join-Path $env:LOCALAPPDATA 'MercadoOnline\navegador'
  if ((Test-Path (Join-Path $velha 'navegador')) -and -not (Test-Path $perfil)) {
    & robocopy.exe (Join-Path $velha 'navegador') "$perfil" /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  }
  $novoNome = 'dados-ANTIGO-ja-copiado-' + (Get-Date -Format 'yyyyMMdd-HHmm')
  try { Rename-Item -Path $velha -NewName $novoNome; Ok "Dados trazidos. A pasta antiga virou '$novoNome' (pode apagar depois de conferir)." }
  catch { Ok 'Dados trazidos. (A pasta antiga continua no lugar; pode apagar depois de conferir.)' }
} elseif ($velha) {
  Info "Ja existem dados na pasta protegida; a pasta antiga ($velha) nao foi usada."
}

# ---------------------------------------------------------------- 5) configuracao do modo
$cfgF = Join-Path $dados 'config.json'
$cfg = [ordered]@{}
if (Test-Path $cfgF) { try { ([IO.File]::ReadAllText($cfgF) | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $cfg[$_.Name] = $_.Value } } catch { } }
$cfg.Remove('lan')
if ($Modo -eq 'caixa') { $cfg['modo'] = 'caixa'; $cfg.Remove('rede') }
else { $cfg.Remove('modo'); $cfg['rede'] = ($Modo -eq 'rede') }
[IO.File]::WriteAllText($cfgF, ($cfg | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding $false))
$verPdv = ''; try { $verPdv = (Get-Content (Join-Path $app 'manifest.json') -Raw | ConvertFrom-Json).versao } catch { }
[IO.File]::WriteAllText((Join-Path $app 'instalado.txt'), "modo=$Modo`r`nversao=$verPdv`r`ninstalado=$(Get-Date -Format s)`r`n")
Ok 'Configuracao gravada.'

# ---------------------------------------------------------------- 6) trancar as pastas (permissoes do Windows)
# SIDs fixos: funciona em Windows em qualquer idioma.  S-1-5-18 = SYSTEM, S-1-5-32-544 = Administradores, S-1-5-32-545 = Usuarios
function Trancar($p, [string[]]$g) {
  & icacls.exe "$p" /inheritance:r /grant:r @g /Q | Out-Null
  & icacls.exe "$p" /setowner '*S-1-5-32-544' /T /C /Q | Out-Null
  Get-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue | ForEach-Object { & icacls.exe "$($_.FullName)" /reset /T /C /Q | Out-Null }
}
Trancar $app  @('*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-32-545:(OI)(CI)RX')
& icacls.exe "$base" /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' /Q | Out-Null
& icacls.exe "$base" /setowner '*S-1-5-32-544' /Q | Out-Null
& icacls.exe "$pub" /reset /T /C /Q | Out-Null
Trancar $dados @('*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F')
Ok 'Pastas trancadas: usuarios comuns nao conseguem abrir, mudar nem apagar os dados.'

# ---------------------------------------------------------------- 7) tarefa do Windows na conta SYSTEM
foreach ($t in @($TASK, $TASKV)) { try { Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue } catch { } }
$acao = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" -Argument "//B //Nologo `"$app\iniciar.vbs`"" -WorkingDirectory $app
$gat1 = New-ScheduledTaskTrigger -AtStartup
try { $gat2 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) }
catch { $gat2 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650) }
$quem = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$ajus = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TASK -Action $acao -Trigger @($gat1, $gat2) -Principal $quem -Settings $ajus -Description 'Mercado Online: servidor local do PDV (banco offline, notas e sincronizacao). Roda sem janela.' -Force | Out-Null
Ok 'O PDV liga sozinho junto com o Windows (antes de qualquer pessoa entrar) e se religa se parar.'

# ---------------------------------------------------------------- 8) firewall (so no modo servidor + caixas)
Get-NetFirewallRule -DisplayName 'PDV Mezzomo*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
Get-NetFirewallRule -DisplayName 'Mercado Online*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
try { & netsh.exe advfirewall firewall delete rule name="PDV Mezzomo" | Out-Null } catch { }
if ($Modo -eq 'rede') {
  New-NetFirewallRule -DisplayName $FWNOME -Description 'Permite que os caixas da rede local da loja usem o servidor do PDV. Vale so para a rede local e so para o programa do PDV.' `
    -Direction Inbound -Action Allow -Program $nodeExe -Protocol TCP -LocalPort $PORTAS -RemoteAddress LocalSubnet -Profile Any | Out-Null
  Ok 'Rede liberada so para os computadores da loja (rede local) e so para o programa do PDV.'
}

# ---------------------------------------------------------------- 9) atalhos para todos os usuarios
$udesk = [Environment]::GetFolderPath('Desktop'); $ustart = [Environment]::GetFolderPath('Startup')
$cdesk = [Environment]::GetFolderPath('CommonDesktopDirectory'); $cstart = [Environment]::GetFolderPath('CommonStartup')
foreach ($v in @("$ustart\Servidor PDV Mezzomo.lnk", "$ustart\Abrir PDV Mezzomo.lnk", "$ustart\iniciar-servidor*.lnk", "$udesk\PDV Mercado Mezzomo.lnk", "$udesk\Gestao Mercado Mezzomo.lnk", "$udesk\Reiniciar PDV.lnk",
                 "$cdesk\PDV Mercado Mezzomo.lnk", "$cdesk\Gestao Mercado Mezzomo.lnk", "$cstart\Abrir PDV Mezzomo.lnk")) {
  Remove-Item $v -ErrorAction SilentlyContinue
}
$desk = [Environment]::GetFolderPath('CommonDesktopDirectory'); $start = [Environment]::GetFolderPath('CommonStartup')
function Atalho($arq, $argumentos, $desc, $icone) {
  $s = $ws.CreateShortcut($arq)
  $s.TargetPath = "$env:WINDIR\System32\wscript.exe"; $s.Arguments = $argumentos; $s.WorkingDirectory = $app; $s.Description = $desc
  if ($icone) { $s.IconLocation = $icone } elseif (Test-Path "$app\pdv.ico") { $s.IconLocation = "$app\pdv.ico" }
  $s.Save()
}
Atalho "$desk\PDV Mercado Online.lnk"    "`"$app\abrir-pdv.vbs`""             'PDV do balcao - Mercado Online' $null
Atalho "$desk\Gestao Mercado Online.lnk" "`"$app\abrir-pdv.vbs`" gestao.html" 'Gestao da loja - Mercado Online' $null
Atalho "$desk\Reiniciar PDV.lnk"          "`"$app\reiniciar.vbs`""             'Religa o PDV quando a tela travar (nenhuma venda se perde)' "$env:WINDIR\System32\shell32.dll,238"
Atalho "$start\Abrir PDV Mercado Online.lnk"     "`"$app\abrir-pdv.vbs`""             'Abre a tela do PDV ao ligar o computador' $null
Ok 'Atalhos PDV, Gestao e Reiniciar PDV na area de trabalho (para todos os usuarios).'

try {
  New-Item -Path 'HKLM:\Software\Policies\Microsoft\Edge' -Force | Out-Null
  Set-ItemProperty -Path 'HKLM:\Software\Policies\Microsoft\Edge' -Name 'HideFirstRunExperience' -Value 1 -Type DWord
  Set-ItemProperty -Path 'HKLM:\Software\Policies\Microsoft\Edge' -Name 'TranslateEnabled' -Value 0 -Type DWord
} catch { }

# ---------------------------------------------------------------- 10) ligar e conferir
Remove-Item (Join-Path $pub 'porta.txt') -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $TASK
Info 'Ligando o PDV...'
$porta = $null
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 700
  if (-not (Test-Path (Join-Path $pub 'porta.txt'))) { continue }
  $p = (Get-Content (Join-Path $pub 'porta.txt') -Raw).Trim()
  try { Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$p/api/status" -TimeoutSec 2 | Out-Null; $porta = $p; break } catch { }
}
Write-Host ''
if (-not $porta) {
  Aviso 'O PDV nao respondeu. Testando para mostrar o motivo:'
  $env:PDV_DATA = $dados; $env:PDV_PUB = $pub; $env:PDV_SO_TESTAR = '1'
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & $nodeExe --no-warnings (Join-Path $app 'server.js') 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow } } catch { Write-Host "    $($_.Exception.Message)" -ForegroundColor Yellow }
  $ErrorActionPreference = $eap
  Remove-Item Env:PDV_SO_TESTAR -ErrorAction SilentlyContinue
  $ea = Join-Path $dados 'erro-ao-ligar.txt'
  if (Test-Path $ea) { Write-Host ''; Aviso 'Erro registrado ao ligar:'; Get-Content $ea | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow } }
  Write-Host ''
  Info 'Tire um print desta janela e mande para o suporte.'
  exit 1
}
Ok "PDV funcionando (porta $porta)."
try { $stv = (Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$porta/api/status" -TimeoutSec 3).versao } catch { $stv = '' }
if ($verNova -and $stv -and ($stv -ne $verNova)) { Aviso "O servidor respondeu com a versao '$stv' em vez de '$verNova'. Reinicie o computador." }
elseif ($verVelha -and ($verVelha -ne $verNova)) { Ok "ATUALIZADO: versao $verVelha -> $verNova" }
else { Ok "Versao $verNova." }
Write-Host ''
if ($Modo -eq 'rede') {
  Write-Host '  Para ligar um caixa a mais:' -ForegroundColor Cyan
  Info '1) No outro computador, rode este mesmo instalador e escolha a opcao 3 (CAIXA).'
  Info '2) Aqui, abra Gestao > Rede e seguranca > "Parear novo caixa" e digite o codigo la.'
  $ips = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }).IPAddress -join ', '
  if ($ips) { Info "(endereco deste servidor na rede: $ips)" }
} elseif ($Modo -eq 'caixa') {
  Write-Host '  Falta so conectar este caixa ao servidor:' -ForegroundColor Cyan
  Info 'No SERVIDOR, abra Gestao > Rede e seguranca > "Parear novo caixa".'
  Info 'A tela que vai abrir aqui procura o servidor sozinha; e so digitar o codigo de 6 numeros.'
} else {
  Info 'Na primeira vez abre a tela de configuracao: o banco online (Supabase) da empresa e a conta do dono.'
}
# abre a tela SEM privilegio de administrador (pelo Explorer)
# instalacao antiga com o nome PDV-Mezzomo: o programa velho sai (os dados ja vieram)
if (Test-Path $appV) { Remove-Item $appV -Recurse -Force -ErrorAction SilentlyContinue; Ok 'Programa antigo (PDV-Mezzomo) removido.' }
Start-Process -FilePath "$env:WINDIR\explorer.exe" -ArgumentList "`"$desk\PDV Mercado Online.lnk`""

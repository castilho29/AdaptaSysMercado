; Instalador .exe do Mercado Online (Inno Setup 6)
; Gerado pelo GitHub Actions. Para gerar no seu PC:
;   node scripts\montar.js
;   "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" /DVersao=2026.11.21-2000 instalador\MercadoOnline.iss
;
; O .exe só extrai os arquivos numa pasta temporária e roda o instalar.bat de sempre
; (mesmo instalador testado: pergunta o modo, mantém os dados, cria atalhos e a tarefa).

#ifndef Versao
  #define Versao "dev"
#endif
#ifndef ComNode
  #define ComNode FileExists(SourcePath + "..\build\node\node.exe")
#endif

[Setup]
AppId={{ADD6934C-EBA6-465B-86C0-3E44DBD7B84A}
AppName=Mercado Online
AppVersion={#Versao}
AppVerName=Mercado Online {#Versao}
AppPublisher=Mercado Online
VersionInfoVersion=1.0.0.0
VersionInfoProductTextVersion={#Versao}
CreateAppDir=no
Uninstallable=no
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=admin
OutputDir=..\dist
OutputBaseFilename=MercadoOnline-Setup-{#Versao}
SetupIconFile=..\app\pdv.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "pt"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Messages]
pt.WelcomeLabel2=Este assistente vai instalar ou ATUALIZAR o Mercado Online (versão {#Versao}) neste computador.%n%nSe já estiver instalado, os dados, vendas e configurações são mantidos.%n%nNo próximo passo abre uma janela perguntando como este computador vai ser usado (servidor ou caixa).

[Files]
Source: "..\dist\MercadoOnline\*"; DestDir: "{tmp}\MercadoOnline"; Flags: recursesubdirs createallsubdirs ignoreversion
#if ComNode
Source: "..\build\node\node.exe"; DestDir: "{tmp}\MercadoOnline\node"; Flags: ignoreversion
#endif

[Run]
Filename: "{cmd}"; Parameters: "/c ""{tmp}\MercadoOnline\instalar.bat"""; WorkingDir: "{tmp}\MercadoOnline"; StatusMsg: "Instalando o Mercado Online... (siga a janela preta)"; Flags: waituntilterminated

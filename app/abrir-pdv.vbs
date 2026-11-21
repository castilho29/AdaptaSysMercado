' Abre o PDV numa janela propria (sem barra de endereco) na porta certa.
' Instalado: o servidor roda sozinho pela tarefa do Windows; aqui so esperamos ele responder.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
inst = fso.FileExists(dir & "\instalado.txt")
If inst Then
  pub = sh.ExpandEnvironmentStrings("%ProgramData%") & "\MercadoOnline\pub"
  perfil = sh.ExpandEnvironmentStrings("%LocalAppData%") & "\MercadoOnline\navegador"
Else
  pub = dir & "\dados"
  perfil = dir & "\dados\navegador"
End If

Function Vivo(p)
  Vivo = False
  On Error Resume Next
  Set h = CreateObject("WinHttp.WinHttpRequest.5.1")
  h.SetTimeouts 700, 700, 700, 1500
  h.Open "GET", "http://127.0.0.1:" & p & "/api/status", False
  h.Send
  If Err.Number = 0 Then
    If h.Status = 200 And InStr(h.ResponseText, """local"":true") > 0 Then Vivo = True
  End If
  Err.Clear
  On Error GoTo 0
End Function

Function Achar()
  Achar = 0
  If fso.FileExists(pub & "\porta.txt") Then
    On Error Resume Next
    Set f = fso.OpenTextFile(pub & "\porta.txt", 1)
    p = Trim(f.ReadAll): f.Close
    On Error GoTo 0
    If Len(p) > 0 Then
      If Vivo(p) Then Achar = p: Exit Function
    End If
  End If
  For Each p In Array(7070, 8765, 18765, 28765, 5765, 3765, 9876, 6543)
    If Vivo(p) Then Achar = p: Exit Function
  Next
End Function

porta = Achar()
If porta = 0 Then
  If Not inst Then sh.Run "wscript.exe """ & dir & "\iniciar.vbs""", 0, False
  If inst Then sh.Popup "Ligando o sistema do PDV... aguarde alguns segundos.", 3, "Mercado Online", 64
  For i = 1 To 120
    WScript.Sleep 500
    porta = Achar()
    If porta <> 0 Then Exit For
  Next
End If
If porta = 0 Then
  If inst Then
    r = MsgBox("O sistema do PDV nao respondeu." & vbCrLf & vbCrLf & _
      "Tente reiniciar o computador. Se continuar, abra o diagnostico" & vbCrLf & _
      "e mande um print da janela para o suporte." & vbCrLf & vbCrLf & _
      "Abrir o diagnostico agora?", 4 + 48, "Mercado Online")
    If r = 6 Then sh.Run """" & dir & "\diagnostico.bat""", 1, False
  Else
    MsgBox "O servidor do PDV nao ligou." & vbCrLf & vbCrLf & _
      "Na pasta " & dir & " de dois cliques em diagnostico.bat" & vbCrLf & _
      "e mande um print da janela que abrir.", 48, "Mercado Online"
  End If
  WScript.Quit
End If

url = "http://localhost:" & porta & "/pdv.html"
If WScript.Arguments.Count > 0 Then url = "http://localhost:" & porta & "/" & WScript.Arguments(0)
pf = sh.ExpandEnvironmentStrings("%ProgramFiles%")
pf86 = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%")
la = sh.ExpandEnvironmentStrings("%LocalAppData%")
nav = ""
For Each c In Array(pf & "\Google\Chrome\Application\chrome.exe", pf86 & "\Google\Chrome\Application\chrome.exe", la & "\Google\Chrome\Application\chrome.exe", pf86 & "\Microsoft\Edge\Application\msedge.exe", pf & "\Microsoft\Edge\Application\msedge.exe")
  If fso.FileExists(c) Then nav = c: Exit For
Next
' Janela do PDV "presa": o navegador do PDV ficou rodando escondido (sem janela) e engole o pedido de abrir.
' Nesse caso fecha esses processos antes de abrir de novo. Se ja tem janela visivel, nao mexe.
ps = "$p=Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') -and $_.CommandLine -like '*MercadoOnline*navegador*' }; " & _
     "if($p){ $v=$p | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } | Where-Object { $_.MainWindowHandle -ne 0 }; " & _
     "if(-not $v){ $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 900 } }"
If nav <> "" Then sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command """ & ps & """", 0, True
If nav = "" Then
  sh.Run url
Else
  fl = " --autoplay-policy=no-user-gesture-required --kiosk-printing --start-maximized --no-first-run --no-default-browser-check --disable-features=Translate,msEdgeSidebarV2,msHubApps --hide-crash-restore-bubble --disable-session-crashed-bubble --overscroll-history-navigation=0 --disable-pinch"
  sh.Run """" & nav & """ --app=" & url & fl & " --user-data-dir=""" & perfil & """", 1, False
End If

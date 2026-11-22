' Reinicia o PDV: pede ao servidor para religar e abre a tela do caixa de novo.
' Use quando a tela travar ou algo ficar estranho. Nenhuma venda se perde.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
inst = fso.FileExists(dir & "\instalado.txt")
If inst Then pub = sh.ExpandEnvironmentStrings("%ProgramData%") & "\AdaptaSysMercado\pub" Else pub = dir & "\dados"

' fecha as janelas do PDV deste usuario (Chrome/Edge em modo aplicativo com o perfil do PDV)
ps = "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') -and ($_.CommandLine -like '*AdaptaSysMercado*navegador*' -or $_.CommandLine -like '*dados\navegador*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command """ & ps & """", 0, True

ok = False
p0 = ""
If fso.FileExists(pub & "\porta.txt") Then
  On Error Resume Next
  Set f = fso.OpenTextFile(pub & "\porta.txt", 1): p0 = Trim(f.ReadAll): f.Close
  On Error GoTo 0
End If
For Each p In Array(p0, 7070, 8765, 18765, 28765, 5765, 3765, 9876, 6543)
  If Len(p & "") > 0 And Not ok Then
    On Error Resume Next
    Set h = CreateObject("WinHttp.WinHttpRequest.5.1")
    h.SetTimeouts 700, 700, 1500, 3000
    h.Open "POST", "http://127.0.0.1:" & p & "/api/reiniciar", False
    h.SetRequestHeader "content-type", "application/json"
    h.Send "{}"
    If Err.Number = 0 Then
      If h.Status = 200 Then ok = True
    End If
    Err.Clear
    On Error GoTo 0
  End If
Next

If Not ok And Not inst Then
  ' versao sem instalar: derruba e liga de novo pelo jeito antigo
  ps = "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'wscript.exe' -and $_.CommandLine -like '*iniciar.vbs*') -or (($_.Name -eq 'node.exe' -or $_.Name -eq 'conhost.exe') -and $_.CommandLine -like '*server.js*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
  sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command """ & ps & """", 0, True
  WScript.Sleep 1500
  sh.Run "wscript.exe """ & dir & "\iniciar.vbs""", 0, False
End If
WScript.Sleep 4000
sh.Run "wscript.exe """ & dir & "\abrir-pdv.vbs""", 1, False

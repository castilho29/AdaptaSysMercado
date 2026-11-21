' Liga o servidor do PDV SEM JANELA e religa sozinho se ele parar.
' Instalado (instalado.txt existe): roda pela tarefa do Windows na conta SYSTEM,
' com os dados na pasta protegida C:\ProgramData\MercadoOnline\dados.
' Sem instalar (pasta solta): usa a pasta "dados" ao lado deste arquivo.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
inst = fso.FileExists(dir & "\instalado.txt")
If inst Then
  base = sh.ExpandEnvironmentStrings("%ProgramData%") & "\MercadoOnline"
  dados = base & "\dados": pub = base & "\pub"
  Set env = sh.Environment("PROCESS")
  env("PDV_DATA") = dados
  env("PDV_PUB") = pub
  If Not fso.FolderExists(base) Then fso.CreateFolder(base)
  If Not fso.FolderExists(pub) Then fso.CreateFolder(pub)
Else
  dados = dir & "\dados": pub = dados
End If
If Not fso.FolderExists(dados) Then fso.CreateFolder(dados)

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
  For Each pf In Array(pub & "\porta.txt", dados & "\porta.txt")
    If fso.FileExists(pf) Then
      On Error Resume Next
      Set f = fso.OpenTextFile(pf, 1)
      p = Trim(f.ReadAll): f.Close
      On Error GoTo 0
      If Len(p) > 0 Then
        If Vivo(p) Then Achar = p: Exit Function
      End If
    End If
  Next
  For Each p In Array(7070, 8765, 18765, 28765, 5765, 3765, 9876, 6543)
    If Vivo(p) Then Achar = p: Exit Function
  Next
End Function

' acha o Node.js: primeiro o que veio com o instalador, depois o do Windows
node = ""
cands = Array(dir & "\node\node.exe", _
              sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe", _
              sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\nodejs\node.exe", _
              sh.ExpandEnvironmentStrings("%LocalAppData%") & "\Programs\nodejs\node.exe", _
              sh.ExpandEnvironmentStrings("%NVM_SYMLINK%") & "\node.exe")
For Each c In cands
  If fso.FileExists(c) Then node = c: Exit For
Next
If node = "" Then node = "node"

cmd = """" & node & """ --no-warnings """ & dir & "\server.js"""
' fora da tarefa do Windows, o conhost --headless evita a janela preta no Windows 11
hl = sh.ExpandEnvironmentStrings("%WINDIR%") & "\System32\conhost.exe"
If Not inst And fso.FileExists(hl) Then cmd = """" & hl & """ --headless " & cmd

' sobra de um "parar" antigo nao pode impedir o religamento
If fso.FileExists(dados & "\parar.flag") Then fso.DeleteFile(dados & "\parar.flag")

' ja tem um servidor ligado? entao este vigia nao precisa ficar
If Achar() <> 0 Then WScript.Quit

Do
  sh.Run cmd, 0, True              ' fica aqui enquanto o servidor estiver ligado
  WScript.Sleep 3000
  If fso.FileExists(dados & "\parar.flag") Then fso.DeleteFile(dados & "\parar.flag"): WScript.Quit
  If Achar() <> 0 Then WScript.Quit ' outro vigia ja religou
Loop

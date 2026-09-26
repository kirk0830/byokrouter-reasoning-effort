' ============================================================================
'  paratera-proxy-lan-hidden.vbs
'  Windowless launcher for the LAN proxy, used by paratera-proxy-lan.bat.
'
'  Arguments (expanded by the .bat):
'     0 = node.exe            1 = ..\..\src\proxy.mjs
'     2 = working directory   3 = pid file
'     4 = port
'
'  Environment set for the child process:
'     BIND=0.0.0.0                       listen on every interface
'     PORT=<port>
'     BYOKROUTER_ADMIN_TOKEN / BYOKROUTER_NO_ADMIN / BYOKROUTER_ALLOWLIST /
'     BYOKROUTER_ALLOWLIST_STRICT / BYOKROUTER_TRUST_FORWARDED   (copied from this process)
'
'  The client token is NOT passed here - the proxy reads it from
'  ..\..\.state\client.token next to itself.
'
'  NOTE: ASCII only. The VBScript engine reads this file using the console
'  codepage (936 here), so non-ASCII comments cause a syntax error and the
'  launcher fails silently.
' ============================================================================
Option Explicit

Dim nodeExe, scriptPath, workDir, pidFile, port, shell, env, src
Dim cmd, pid, fso, ts, names, n

If WScript.Arguments.Count < 5 Then
  WScript.Echo "[error] needs 5 arguments"
  WScript.Quit 2
End If

nodeExe    = WScript.Arguments(0)
scriptPath = WScript.Arguments(1)
workDir    = WScript.Arguments(2)
pidFile    = WScript.Arguments(3)
port       = WScript.Arguments(4)

Set fso = CreateObject("Scripting.FileSystemObject")
If Not fso.FileExists(nodeExe) Then
  WScript.Echo "[error] node.exe not found: " & nodeExe
  WScript.Quit 2
End If
If Not fso.FileExists(scriptPath) Then
  WScript.Echo "[error] proxy script not found: " & scriptPath
  WScript.Quit 2
End If

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = workDir

Set src = shell.Environment("PROCESS")
Set env = shell.Environment("PROCESS")

env("BIND") = "0.0.0.0"
env("PORT") = Trim("" & port)

' Windows Script Host starts the child with a fresh environment, so the hardening
' switches must be copied over explicitly.
names = Array("BYOKROUTER_ADMIN_TOKEN", "BYOKROUTER_NO_ADMIN", "BYOKROUTER_ALLOWLIST", _
              "BYOKROUTER_ALLOWLIST_STRICT", "BYOKROUTER_TRUST_FORWARDED")
For Each n In names
  If Len(Trim("" & src(n))) > 0 Then env(n) = src(n)
Next

cmd = """" & nodeExe & """ """ & scriptPath & """"
' 0 = hidden window, False = do not wait for it to exit
pid = shell.Run(cmd, 0, False)

On Error Resume Next
Set ts = fso.OpenTextFile(pidFile, 2, True)
ts.WriteLine pid
ts.Close
If Err.Number <> 0 Then
  WScript.Echo "[warn] could not write pid file: " & pidFile
  Err.Clear
End If
On Error GoTo 0

WScript.Echo pid

' ============================================================================
'  paratera-proxy-hidden.vbs
'  Launches ..\..\src\proxy.mjs with NO console window and writes its PID.
'  Called by paratera-proxy.bat; you normally never run this directly.
'
'  Arguments (supplied by the .bat, already fully expanded):
'     0 = full path to node.exe
'     1 = full path to ..\..\src\proxy.mjs
'     2 = working directory
'     3 = full path to the pid file
' ============================================================================
Option Explicit

Dim nodeExe, scriptPath, workDir, pidFile, shell, cmd, pid, fso, ts

If WScript.Arguments.Count < 4 Then
  WScript.Echo "[error] paratera-proxy-hidden.vbs needs 4 arguments"
  WScript.Quit 2
End If

nodeExe    = WScript.Arguments(0)
scriptPath = WScript.Arguments(1)
workDir    = WScript.Arguments(2)
pidFile    = WScript.Arguments(3)

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

' window style 0 = hidden, False = do not wait for it to exit
cmd = """" & nodeExe & """ """ & scriptPath & """"
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

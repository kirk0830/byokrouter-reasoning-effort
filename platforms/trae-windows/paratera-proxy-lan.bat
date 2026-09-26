@echo off
rem ============================================================================
rem  paratera-proxy-lan.bat -- start the thinking-effort proxy (LAN/public mode)
rem
rem  One script does everything: pick the port, start the proxy, and print the
rem  Base URL + API key to paste into the client (Trae).
rem
rem  Arguments (all optional):
rem      --port N        bind this port (pick one uncommon value once and keep it)
rem      --random-port   pick a free random port, remembered for later starts
rem      --rotate-token  issue a NEW client token (note: in Trae this means
rem                      deleting and re-adding every model)
rem      --no-pause      do not wait for a keypress (for scripts)
rem
rem  RUN AS ADMINISTRATOR, otherwise the firewall rule cannot be added.
rem
rem  NOTE this file is intentionally ASCII-only: cmd reads .bat files using the
rem  console codepage (936 here), so non-ASCII box characters corrupt parsing.
rem ============================================================================
setlocal EnableExtensions EnableDelayedExpansion

set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"

set "DO_PAUSE=1"
set "LANINFO_ARGS="

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--no-pause" goto arg_nopause
if /i "%~1"=="--port" goto arg_port
if /i "%~1"=="--random-port" goto arg_random
if /i "%~1"=="--rotate-token" goto arg_rotate
echo [warn] ignoring unknown argument: %~1
shift
goto parse

:arg_nopause
set "DO_PAUSE=0"
shift
goto parse

:arg_port
set "LANINFO_ARGS=%LANINFO_ARGS% --port %~2"
shift
shift
goto parse

:arg_random
set "LANINFO_ARGS=%LANINFO_ARGS% --random-port"
shift
goto parse

:arg_rotate
set "LANINFO_ARGS=%LANINFO_ARGS% --rotate-token"
shift
goto parse

:parsed

set "NODE=%NODE_EXE%"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if defined NODE goto have_node
echo [ERROR] node.exe not found. Set NODE_EXE and retry.
if "%DO_PAUSE%"=="1" pause
exit /b 2
:have_node

rem --- port / LAN address / token (node prints three lines) -------------------
set "PORT="
set "LANIP="
set "TOKEN="
set "LINENO=0"
for /f "usebackq delims=" %%L in (`%NODE% "%HERE%\lan-info.mjs" !LANINFO_ARGS!`) do (
  set /a LINENO+=1
  if !LINENO! EQU 1 set "PORT=%%L"
  if !LINENO! EQU 2 set "LANIP=%%L"
  if !LINENO! EQU 3 set "TOKEN=%%L"
)

if not defined PORT (
  echo [ERROR] could not determine the port ^(lan-info.mjs failed^). Diagnose with:
  echo         "%NODE%" "%HERE%\lan-info.mjs"
  if "%DO_PAUSE%"=="1" pause
  exit /b 2
)
if not defined LANIP (
  echo [ERROR] could not determine the LAN address.
  if "%DO_PAUSE%"=="1" pause
  exit /b 2
)
if not defined TOKEN (
  echo [ERROR] could not obtain a client token.
  if "%DO_PAUSE%"=="1" pause
  exit /b 2
)

rem --- remember the port so later runs reuse the same client URL --------------
rem   Written here rather than in lan-info.mjs: the .bat runs in the user's own
rem   shell, which is the reliable place to write files. (A restricted environment
rem   can deny node the right to create files, which would silently lose the port.)
> "%HERE%\..\..\.state\port" echo !PORT!

rem --- stop whatever is already running (this port and the recorded one) -----
for /f "usebackq tokens=5" %%A in (`netstat -ano -p tcp ^| findstr /R /C:":!PORT! .*LISTENING"`) do (
  echo   stopping pid %%A holding port !PORT! ...
  taskkill /PID %%A /T /F >nul 2>nul
)
if exist "%HERE%\..\..\.state\proxy.pid" (
  set /p OLDPID=<"%HERE%\..\..\.state\proxy.pid"
  if defined OLDPID taskkill /PID !OLDPID! /T /F >nul 2>nul
)
ping -n 2 127.0.0.1 >nul 2>nul

rem --- firewall rule (local subnet only) -------------------------------------
net session >nul 2>nul
if errorlevel 1 goto no_admin
netsh advfirewall firewall delete rule name="paratera-proxy-!PORT!" >nul 2>nul
netsh advfirewall firewall add rule name="paratera-proxy-!PORT!" dir=in action=allow protocol=TCP localport=!PORT! remoteip=localsubnet profile=any >nul
if errorlevel 1 echo   [warn] could not add the firewall rule.
if not errorlevel 1 echo   firewall : inbound TCP !PORT! allowed from the local subnet
goto fw_done
:no_admin
echo   [warn] not elevated - skipping the firewall rule.
echo          If the client cannot connect, re-run as Administrator, or run:
echo            netsh advfirewall firewall add rule name="paratera-proxy-!PORT!" dir=in action=allow protocol=TCP localport=!PORT! remoteip=localsubnet
:fw_done

rem --- start (hidden window) --------------------------------------------------
echo.
echo   starting the proxy ...
cscript //nologo "%HERE%\paratera-proxy-lan-hidden.vbs" "%NODE%" "%HERE%\..\..\src\proxy.mjs" "%HERE%" "%HERE%\..\..\.state\proxy.pid" "!PORT!" >nul 2>nul

set "UP="
for /l %%I in (1,1,25) do (
  if not defined UP (
    ping -n 2 127.0.0.1 >nul 2>nul
    netstat -ano -p tcp 2>nul | findstr /R /C:":!PORT! .*LISTENING" >nul && set "UP=1"
  )
)

echo.
echo ============================================================================
if not defined UP goto failed

echo   PROXY IS UP
echo.
echo   ---- paste these into the client (Trae) ------------------------------
echo.
echo     Base URL : http://!LANIP!:!PORT!/chat/completions
echo     API key  : !TOKEN!
echo.
echo     Model names (case sensitive, copy exactly):
echo       GLM-5.3-Flash
echo       DeepSeek-V4.1-Flash
echo       Qwen3.8-Flash
echo       Qwen3.8-Max
echo       Kimi-K3
echo.
echo   ---- thinking effort in effect ----------------------------------------
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%\paratera-proxy-ctl.ps1" status !PORT!
echo.
echo   status  : double-click paratera-status.bat
echo   stop    : double-click paratera-proxy-stop.bat
echo   lock it : paratera-hardening.bat --collect   then   --enforce
echo ============================================================================
echo.
if "%DO_PAUSE%"=="1" pause
endlocal
exit /b 0

:failed
echo   [FAILED] the proxy did not come up on port !PORT!.
echo            See the error by running it in a console:
echo              "%NODE%" "%HERE%\..\..\src\proxy.mjs"
echo.
if "%DO_PAUSE%"=="1" pause
endlocal
exit /b 3

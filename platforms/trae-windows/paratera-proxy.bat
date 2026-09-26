@echo off
rem ============================================================================
rem  paratera-proxy.bat -- start the Paratera reasoning-effort proxy
rem
rem  Extra arguments (optional):
rem      --no-check    skip the startup self-check (fast restart)
rem      --full-check  run the full test suite instead of the quick smoke test
rem      --no-pause    do not wait at the end (when launched from a script)
rem
rem  The proxy lets Trae CN send a thinking-effort tier ("reasoning_effort") for
rem  custom models on your gateway, which Trae itself has no
rem  setting for. The self-check output explains what it is for, how to use it in
rem  Trae, and how to change the tiers.
rem
rem  Stop it with paratera-proxy-stop.bat
rem ============================================================================
setlocal EnableExtensions

set "PORT=8798"
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"

set "DO_CHECK=1"
set "CHECK_ARGS="
set "DO_PAUSE=1"
:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--no-check"   set "DO_CHECK=0"
if /i "%~1"=="--full-check" set "CHECK_ARGS=--full"
if /i "%~1"=="--no-pause"   set "DO_PAUSE=0"
shift
goto parse
:parsed

set "NODE=%NODE_EXE%"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

if not defined NODE (
  echo [ERROR] node.exe not found.
  echo         Set it explicitly, e.g.   set NODE_EXE=C:\path\to\node.exe
  echo.
  if "%DO_PAUSE%"=="1" pause
  exit /b 2
)
if not exist "%HERE%\..\..\src\proxy.mjs" (
  echo [ERROR] ..\..\src\proxy.mjs not found next to this script: "%HERE%"
  echo.
  if "%DO_PAUSE%"=="1" pause
  exit /b 2
)

rem --- already running? -------------------------------------------------------
netstat -ano -p tcp 2>nul | findstr /R /C:":%PORT% .*LISTENING" >nul && (
  echo Proxy already listening on port %PORT%.
  echo   status: http://127.0.0.1:%PORT%/_status
  set "ALREADY=1"
) || set "ALREADY="

if defined ALREADY (
  if "%DO_CHECK%"=="1" call :selfcheck
  if "%DO_PAUSE%"=="1" pause
  exit /b 0
)

rem --- start it (hidden, via the VBS launcher) --------------------------------
if "%DO_CHECK%"=="1" (
  echo Starting the Paratera thinking-effort proxy on port %PORT% ...
  echo.
) else (
  echo Starting the Paratera thinking-effort proxy on port %PORT% ^(no self-check^) ...
)

cscript //nologo "%HERE%\paratera-proxy-hidden.vbs" "%NODE%" "%HERE%\..\..\src\proxy.mjs" "%HERE%" "%HERE%\..\..\.state\proxy.pid" >nul 2>nul

rem --- wait for the listener --------------------------------------------------
set "UP="
for /l %%I in (1,1,25) do (
  if not defined UP (
    ping -n 2 127.0.0.1 >nul 2>nul
    netstat -ano -p tcp 2>nul | findstr /R /C:":%PORT% .*LISTENING" >nul && set "UP=1"
  )
)

rem --- resolve the pid from the listener (authoritative) ----------------------
set "PID="
for /f "usebackq tokens=5" %%A in (`netstat -ano -p tcp ^| findstr /R /C:":%PORT% .*LISTENING"`) do set "PID=%%A"
if defined PID > "%HERE%\..\..\.state\proxy.pid" echo %PID%

if not defined UP (
  echo.
  echo   [FAIL] the proxy did not come up on port %PORT%.
  echo          node used : %NODE%
  echo          start it in a console to see the error:
  echo              "%NODE%" "%HERE%\..\..\src\proxy.mjs"
  echo.
  if "%DO_PAUSE%"=="1" pause
  exit /b 3
)

if defined PID echo   [OK] proxy is listening on port %PORT% ^(pid %PID%^).
echo.

if "%DO_CHECK%"=="1" call :selfcheck

if "%DO_PAUSE%"=="1" (
  echo Press any key to close this window. The proxy keeps running in the background.
  pause >nul
)
endlocal
exit /b 0

rem ---------------------------------------------------------------------------
rem  :selfcheck -- run the pytest self-check through the pixi environment, and
rem  fall back to the bundled python, then to a plain status probe, so a broken
rem  or missing env never blocks the proxy from being usable.
rem ---------------------------------------------------------------------------
:selfcheck
set "PIXI="
for /f "delims=" %%P in ('where pixi 2^>nul') do if not defined PIXI set "PIXI=%%P"

if defined PIXI (
  pushd "%HERE%\proxy-tests"
  "%PIXI%" run python selfcheck.py %CHECK_ARGS%
  popd
  goto :eof
)

echo [warn] pixi not found - skipping the test self-check.
echo        Install pixi, or run it later with: proxy-tests\run-tests.bat
echo.
echo   status page: http://127.0.0.1:%PORT%/_status
goto :eof

@echo off
rem ============================================================================
rem  paratera-proxy-stop.bat -- stop the Paratera reasoning-effort proxy
rem
rem  Delegates to paratera-proxy-ctl.ps1 (safe process matching by command line
rem  and by the listening port; no tasklist PID-0 false matches).
rem ============================================================================
setlocal EnableExtensions
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"
set "PORT=8798"

echo Stopping Paratera proxy on port %PORT% ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%\paratera-proxy-ctl.ps1" stop %PORT%

if exist "%HERE%\..\..\.state\proxy.pid" del /q "%HERE%\..\..\.state\proxy.pid" >nul 2>nul

echo.
echo   Models in Trae that point at http://127.0.0.1:%PORT% will not work until
echo   you start the proxy again ^(paratera-proxy.bat^).
echo.
endlocal

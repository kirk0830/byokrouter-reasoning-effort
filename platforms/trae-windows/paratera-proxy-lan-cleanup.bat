@echo off
rem ============================================================================
rem  paratera-proxy-lan-cleanup.bat -- undo everything the LAN proxy set up
rem    * stops the proxy
rem    * removes its firewall rule (for the remembered port and the default)
rem    * removes the saved tokens and port
rem ============================================================================
setlocal EnableExtensions EnableDelayedExpansion
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"

rem remembered port, so the right firewall rule is removed
set "PORT="
if exist "%HERE%\..\..\.state\port" set /p PORT=<"%HERE%\..\..\.state\port"
if not defined PORT set "PORT=8798"

echo Removing firewall rules ...
net session >nul 2>nul
if errorlevel 1 goto no_admin
for %%P in (%PORT% 8798) do (
  netsh advfirewall firewall delete rule name="paratera-proxy-%%P" >nul 2>nul
  netsh advfirewall firewall show rule name="paratera-proxy-%%P" >nul 2>nul && (
    echo   [warn] rule paratera-proxy-%%P is still present
  ) || (
    echo   removed rule paratera-proxy-%%P ^(or it did not exist^)
  )
)
goto fw_done
:no_admin
echo   [warn] not elevated - remove the rules manually as Administrator:
echo            netsh advfirewall firewall delete rule name="paratera-proxy-%PORT%"
echo            netsh advfirewall firewall delete rule name="paratera-proxy-8798"
:fw_done

echo Stopping the proxy ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%\paratera-proxy-ctl.ps1" stop %PORT% >nul 2>nul
if exist "%HERE%\..\..\.state\proxy.pid" (
  set /p PPIDV=<"%HERE%\..\..\.state\proxy.pid"
  if defined PPIDV taskkill /PID !PPIDV! /T /F >nul 2>nul
)

echo Removing saved secrets and settings ...
for %%F in (..\..\.state\client.token ..\..\.state\admin.token ..\..\.state\port ..\..\.state\proxy.pid) do (
  if exist "%HERE%\%%F" (
    del /q "%HERE%\%%F"
    echo   removed %%F
  )
)

echo.
echo Done. Nothing of the proxy remains:
echo   * no listener, no firewall rule, no tokens
echo   * the client (Trae) still has the custom models - delete those in the UI
echo   * to start again:  paratera-proxy-lan.bat
echo.
pause
endlocal

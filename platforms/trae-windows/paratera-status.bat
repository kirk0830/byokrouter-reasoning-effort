@echo off
rem ============================================================================
rem  paratera-status.bat -- one-click status of the Paratera effort proxy
rem
rem  Shows: is it running, which address is bound, the tiers in effect, request
rem  counters, the client token, and the exact Base URL / API key to paste into a
rem  client (Trae).
rem ============================================================================
setlocal EnableExtensions EnableDelayedExpansion
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"

rem Port comes from lan-info.mjs (which remembers the chosen one), so status works
rem with any port, not just the default.
set "PORT="
set "KEY="
set "LANIP="
set "NODE=%NODE_EXE%"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if defined NODE (
  set "LINENO=0"
  for /f "usebackq delims=" %%L in (`%NODE% "%HERE%\lan-info.mjs"`) do (
    set /a LINENO+=1
    if !LINENO! EQU 1 set "PORT=%%L"
    if !LINENO! EQU 2 set "LANIP=%%L"
    if !LINENO! EQU 3 set "KEY=%%L"
  )
)
if not defined PORT set "PORT=8798"

echo ============================================================================
echo  Paratera thinking-effort proxy - status
echo ============================================================================
echo.

rem --- listener -----------------------------------------------------------------
set "BOUND="
for /f "usebackq tokens=2" %%A in (`netstat -ano -p tcp ^| findstr /R /C:":%PORT% .*LISTENING"`) do (
  if not defined BOUND set "BOUND=%%A"
)
if not defined BOUND (
  echo   state   : NOT RUNNING on port %PORT%
  echo.
  echo   start it with:
  echo       paratera-proxy-lan.bat     ^(LAN/public address - the Trae setup^)
  echo       paratera-proxy.bat         ^(loopback only^)
  echo.
  goto :done
)

echo   state   : running, bound to %BOUND% ^(port %PORT%^)
if "%BOUND%"=="127.0.0.1" (
  echo             ^(loopback only - clients whose server fetches the URL cannot use this^)
) else (
  echo             ^(reachable from outside - client token required^)
)

rem --- status page --------------------------------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%\paratera-proxy-ctl.ps1" status %PORT%

rem --- token -------------------------------------------------------------------
if defined KEY (
  echo.
  echo   Paste into the client:
  echo       Base URL : http://!LANIP!:%PORT%/chat/completions
  echo       API key  : !KEY!
  echo       Models   : GLM-5.3-Flash / DeepSeek-V4.1-Flash / Qwen3.8-Flash
  echo                  Qwen3.8-Max / Kimi-K3
  echo.
  echo   ^(Tiers are configured in effort.json - see the operation manual.^)
) else (
  echo.
  echo   No client token - the proxy is not requiring one. Fine for loopback use,
  echo   but NOT for a LAN/public bind.
)

:done
echo.
echo ============================================================================
pause
endlocal

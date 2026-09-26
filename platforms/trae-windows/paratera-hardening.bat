@echo off
rem ============================================================================
rem  paratera-hardening.bat -- lock the LAN proxy down further
rem
rem  Run this (as Administrator) INSTEAD of paratera-proxy-lan.bat when you want
rem  the proxy reachable only by the addresses you trust.
rem
rem  What it does, on top of paratera-proxy-lan.bat:
rem    * requires an admin token for the loopback-only /_status and /_control
rem    * restricts the Windows Firewall rule to BYOKROUTER_ALLOWLIST addresses
rem    * optionally runs the proxy in strict allowlist mode
rem
rem  ORDER MATTERS. Do NOT start with strict mode: first collect the addresses the
rem  client actually uses, otherwise you lock the client out.
rem
rem      1) run this with  --collect      send real messages from the client,
rem                                       then run:  node paratera-allowlist.mjs
rem      2) edit  paratera-allowlist.txt  with the prefixes it suggests
rem      3) run this with  --enforce      firewall + strict mode
rem
rem  Undo with paratera-proxy-lan-cleanup.bat (removes the firewall rule and the
rem  saved tokens), then start the plain LAN script again.
rem ============================================================================
setlocal EnableExtensions EnableDelayedExpansion
set "PORT=8798"
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"

set "MODE=%~1"
if "%MODE%"=="" set "MODE=--collect"

if /i not "%MODE%"=="--collect" if /i not "%MODE%"=="--enforce" (
  echo usage: paratera-hardening.bat [--collect ^| --enforce]
  pause & exit /b 2
)

set "NODE=%NODE_EXE%"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE ( echo [ERROR] node.exe not found & pause & exit /b 2 )

set "ALLOWFILE=%HERE%\paratera-allowlist.txt"
set "ADMINTOKFILE=%HERE%\..\..\.state\admin.token"

rem --- admin token (shared by both modes) ------------------------------------
if exist "%ADMINTOKFILE%" (
  set /p ADMINTOK=<"%ADMINTOKFILE%"
) else (
  set "ADMINTOK="
  set "LANIP="
  set "LINENO=0"
  for /f "usebackq delims=" %%T in (`%NODE% "%HERE%\lan-info.mjs" --token-length 32`) do (
    set /a LINENO+=1
    if !LINENO! EQU 1 set "LANIP=%%T"
    if !LINENO! EQU 2 set "ADMINTOK=%%T"
  )
  if defined ADMINTOK > "%ADMINTOKFILE%" echo !ADMINTOK!
)
if not defined ADMINTOK ( echo [ERROR] could not create an admin token & pause & exit /b 2 )

rem --- allowlist --------------------------------------------------------------
set "ALLOW="
if exist "%ALLOWFILE%" (
  for /f "usebackq tokens=* delims=" %%L in ("%ALLOWFILE%") do (
    set "LINE=%%L"
    if not "!LINE!"=="" if not "!LINE:~0,1!"=="#" (
      if defined ALLOW ( set "ALLOW=!ALLOW!,!LINE!" ) else ( set "ALLOW=!LINE!" )
    )
  )
)

echo ============================================================================
echo  Paratera proxy - hardening (%MODE%)
echo ============================================================================
echo   port         : %PORT%
echo   admin token  : %ADMINTOK%
echo                  (file: ..\..\.state\admin.token)
if "%MODE%"=="--collect" (
  echo   allowlist    : not enforced yet - collecting real client addresses
  echo   strict mode  : OFF
) else (
  if defined ALLOW (
    echo   allowlist    : %ALLOW%
    echo   strict mode  : ON
  ) else (
    echo   [ERROR] %ALLOWFILE% is empty or missing.
    echo           Run --collect first, then fill in the prefixes.
    pause & exit /b 2
  )
)
echo ============================================================================
echo.

rem --- stop the current instance so the new settings apply --------------------
netstat -ano -p tcp 2>nul | findstr /R /C:":%PORT% .*LISTENING" >nul && (
  echo Stopping the current proxy ...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%\paratera-proxy-ctl.ps1" stop %PORT% >nul
  ping -n 3 127.0.0.1 >nul 2>nul
)

rem --- firewall rule -----------------------------------------------------------
rem   Two different address syntaxes are needed:
rem     BYOKROUTER_ALLOWLIST  : bare prefixes, matched by the proxy against
rem                        x-forwarded-for (the TCP peer is the router here)
rem     firewall remoteip: CIDR, matched against the real TCP source
rem   So when enforcing, an optional paratera-firewall-allowlist.txt (CIDR, one per
rem   line) is preferred; otherwise the proxy list is converted naively.
net session >nul 2>nul
if errorlevel 1 (
  echo [warn] not elevated - skipping the firewall rule ^(run as Administrator^).
  echo.
) else (
  set "REMOTEIP=localsubnet"
  if "%MODE%"=="--enforce" (
    set "FWALLOWFILE=%HERE%\paratera-firewall-allowlist.txt"
    set "REMOTEIP="
    if exist "!FWALLOWFILE!" (
      for /f "usebackq tokens=* delims=" %%L in ("!FWALLOWFILE!") do (
        set "L=%%L"
        if not "!L!"=="" if not "!L:~0,1!"=="#" (
          if defined REMOTEIP ( set "REMOTEIP=!REMOTEIP!;!L!" ) else ( set "REMOTEIP=!L!" )
        )
      )
      echo   firewall     : allowlist from paratera-firewall-allowlist.txt
    ) else (
      rem no CIDR file: convert bare prefixes, and say what was assumed
      for %%A in ("!ALLOW:,=" "!") do (
        set "E=%%~A"
        if not "!E!"=="" (
          set "CIDR="
          if "!E!"=="127.0.0.1" set "CIDR=127.0.0.1/32"
          if not defined CIDR set "CIDR=!E!"
          if defined REMOTEIP ( set "REMOTEIP=!REMOTEIP!;!CIDR!" ) else ( set "REMOTEIP=!CIDR!" )
        )
      )
      echo   firewall     : converted from the proxy list - for anything other than
      echo                  bare prefixes must be CIDR already, or create
      echo                  paratera-firewall-allowlist.txt with proper CIDR values.
    )
  )
  if defined REMOTEIP (
    netsh advfirewall firewall delete rule name="paratera-proxy-%PORT%" >nul 2>nul
    netsh advfirewall firewall add rule name="paratera-proxy-%PORT%" dir=in action=allow protocol=TCP localport=%PORT% remoteip="!REMOTEIP!" profile=any >nul
    if errorlevel 1 ( echo   [warn] firewall rule rejected remoteip="!REMOTEIP!" - keeping the old rule ) else ( echo   firewall     : inbound TCP %PORT% from !REMOTEIP! )
  ) else (
    echo   [warn] could not derive a firewall allowlist - leaving the rule unchanged.
  )
)

rem --- launch ------------------------------------------------------------------
rem   The client reaches this proxy through the router (NAT), so the TCP peer is
rem   the router - which is why the proxy policy is judged on x-forwarded-for.
set "BYOKROUTER_ADMIN_TOKEN=%ADMINTOK%"
if "%MODE%"=="--enforce" (
  set "BYOKROUTER_ALLOWLIST=%ALLOW%"
  set "BYOKROUTER_ALLOWLIST_STRICT=1"
  set "BYOKROUTER_TRUST_FORWARDED=1"
) else (
  set "BYOKROUTER_ALLOWLIST="
  set "BYOKROUTER_ALLOWLIST_STRICT="
  set "BYOKROUTER_TRUST_FORWARDED="
)

echo.
echo Starting ^(LAN bind, client token required, admin token required^) ...
cscript //nologo "%HERE%\paratera-proxy-lan-hidden.vbs" "%NODE%" "%HERE%\..\..\src\proxy.mjs" "%HERE%" "%HERE%\..\..\.state\proxy.pid" >nul 2>nul
ping -n 4 127.0.0.1 >nul 2>nul

echo.
echo   Status ^(needs the admin token now^):
powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%\paratera-proxy-ctl.ps1" status %PORT%
echo.
if "%MODE%"=="--collect" (
  echo   NEXT: send a few messages from the client, then run:
  echo           "%NODE%" "%HERE%\paratera-allowlist.mjs"
  echo         put the suggested prefixes into paratera-allowlist.txt,
  echo         then run this script again with --enforce
) else (
  echo   Strict mode is ON. Rejected sources are visible in the proxy log.
)
echo.
pause
endlocal

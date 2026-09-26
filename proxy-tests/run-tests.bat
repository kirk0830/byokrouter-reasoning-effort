@echo off
rem ============================================================================
rem  run-tests.bat -- run the OpenAI-SDK test suite against the running proxy
rem
rem  Needs the proxy to be up first (..\paratera-proxy.bat).
rem  Everything else (pixi env with python + openai) is created on first run.
rem
rem  Pass through extra args, e.g.:
rem      run-tests.bat --samples 3
rem      run-tests.bat --direct          (also compares against the gateway itself)
rem ============================================================================
setlocal EnableExtensions
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"

where pixi >nul 2>nul
if errorlevel 1 (
  echo [ERROR] pixi not found on PATH. Install it, or run manually:
  echo             python "%HERE%\test_proxy.py"
  echo.
  pause
  exit /b 2
)

pushd "%HERE%"
echo Running proxy tests ^(pixi env: %HERE%\.pixi^) ...
echo.
pixi run python test_proxy.py %*
set "RC=%ERRORLEVEL%"
popd

echo.
if "%RC%"=="0" (
  echo   [OK] all checks passed.
) else (
  echo   [FAIL] exit code %RC% - see the failed lines above.
)
echo.
pause
exit /b %RC%

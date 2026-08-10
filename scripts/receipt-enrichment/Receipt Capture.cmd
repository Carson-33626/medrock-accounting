@echo off
setlocal

rem ---------------------------------------------------------------------------
rem  Receipt Capture — Control Panel launcher.
rem
rem  Double-click this file. It starts the loopback server and opens the panel in
rem  a standalone Chrome window. THIS CONSOLE WINDOW *IS* THE SERVER — closing it
rem  stops the panel.
rem
rem  Every path inside the program is relative to web/, so the cd below is
rem  load-bearing, not cosmetic. %~dp0 is scripts\receipt-enrichment\ ; two
rem  levels up is web\.
rem ---------------------------------------------------------------------------

cd /d "%~dp0..\.."

if not exist "package.json" (
  echo.
  echo  ERROR: expected to find web\package.json at "%CD%".
  echo  This launcher must stay in scripts\receipt-enrichment\ inside the repo.
  echo.
  pause
  exit /b 1
)

where npx >nul 2>nul
if errorlevel 1 (
  echo.
  echo  ERROR: Node.js ^(npx^) is not on your PATH.
  echo  Install Node.js, then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist ".env.local" (
  echo.
  echo  WARNING: web\.env.local not found. The panel will start, but vendor
  echo  credential checks will show red and live actions will fail.
  echo.
)

echo Starting Receipt Capture control panel...
echo Close this window to stop the server.
echo.

npx tsx scripts/receipt-enrichment/ui/serve.ts

rem Only reached if the server exits on its own (crash, port in use, Ctrl+C).
echo.
echo Panel stopped ^(exit code %errorlevel%^).
pause

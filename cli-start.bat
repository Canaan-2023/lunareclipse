@echo off
chcp 65001 >nul
title Eclipse CLI (TUI)
cd /d "%~dp0"
echo ============================================
echo   Eclipse CLI (TUI)
echo ============================================
echo.

rem ============================================================
rem  Node runtime resolution (same as launch-Dev.bat, self-contained)
rem  Prefer project bundled .tools\node.exe; fall back to PATH.
rem  Keep this file pure ASCII - cmd mis-parses UTF-8 CJK comments.
rem ============================================================
set "PROJECT_NODE=%~dp0.tools"
if exist "%PROJECT_NODE%\node.exe" (
  set "PATH=%PROJECT_NODE%;%PATH%"
)

set "NODE_VER="
for /f "delims=" %%v in ('node --version 2^>nul') do set "NODE_VER=%%v"
if "%NODE_VER%"=="" (
  echo [ERROR] No usable Node.js found. Tried: .tools\node.exe then PATH.
  pause >nul
  exit /b 1
)
echo Node: %NODE_VER% (.tools bundled or PATH)

if not exist "out\cli\cli-ui.mjs" (
  echo [ERROR] CLI build not found: out\cli\cli-ui.mjs
  echo Run build first:  node scripts\build-cli.mjs
  pause >nul
  exit /b 1
)

echo Starting Eclipse CLI (TUI, persistent REPL)...
echo Tips:
echo   - Chat: type message and press Enter
echo   - /exit quits; /help shows commands; Ctrl-C aborts current reply or exits
echo   - If desktop app is running, pass -c with an apiPort=0 config to avoid port conflict
echo.
node "out\cli\cli-ui.mjs" %*
set "EXIT_CODE=%errorlevel%"
echo.
echo CLI exited with code %EXIT_CODE%
pause >nul
exit /b %EXIT_CODE%
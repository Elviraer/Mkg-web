@echo off
setlocal

set "ROOT=%~dp0"
cd /d "%ROOT%"

set "PORT=4080"
set "MK_SERVER_HOST=127.0.0.1"
set "MK_WEB_DIST_DIR=%ROOT%web"
set "MK_DATA_DIR=%ROOT%data"
set "MK_UPLOADS_DIR=%ROOT%uploads"

set "NODE_EXE="
if exist "%ROOT%runtime\node\node.exe" set "NODE_EXE=%ROOT%runtime\node\node.exe"
if not defined NODE_EXE if exist "%ROOT%node-runtime.exe" set "NODE_EXE=%ROOT%node-runtime.exe"

echo [MK Web] Starting on http://127.0.0.1:%PORT%/
echo.

if defined NODE_EXE (
  "%NODE_EXE%" "%ROOT%scripts\start.mjs"
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo Node.js 24 or later is required.
    echo Install Node.js, or place a portable runtime at runtime\node\node.exe.
    pause
    exit /b 1
  )
  node "%ROOT%scripts\start.mjs"
)

endlocal

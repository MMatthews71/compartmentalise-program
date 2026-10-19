@echo off
REM ============================================================
REM  Compartmentalise - double-click launcher for Windows
REM  Installs dependencies on first run, then starts the app.
REM ============================================================
setlocal

REM Work from the folder this script lives in, wherever it's launched from.
cd /d "%~dp0"

REM Make sure Node.js is available.
where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo  Node.js was not found on your PATH.
    echo  Install it from https://nodejs.org/ then run this file again.
    echo.
    pause
    exit /b 1
)

REM Install dependencies the first time (when node_modules is missing).
if not exist "node_modules" (
    echo Installing dependencies ^(first run only^)...
    call npm install
    if errorlevel 1 (
        echo.
        echo  npm install failed. See the messages above.
        echo.
        pause
        exit /b 1
    )
)

echo Starting Compartmentalise...
call npm start

REM Keep the window open if the app exits with an error.
if errorlevel 1 pause
endlocal

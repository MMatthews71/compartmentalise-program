@echo off
REM ============================================================
REM  Compartmentalise - update and run (Windows)
REM  Pulls the latest code from GitHub, installs any new
REM  dependencies, then starts the app.
REM ============================================================
setlocal

REM Work from the folder this script lives in.
cd /d "%~dp0"

REM Need git to pull updates.
where git >nul 2>nul
if errorlevel 1 (
    echo.
    echo  git was not found on your PATH.
    echo  Install it from https://git-scm.com/download/win then run this again.
    echo.
    pause
    exit /b 1
)

REM Need Node.js to run the app.
where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo  Node.js was not found on your PATH.
    echo  Install it from https://nodejs.org/ then run this again.
    echo.
    pause
    exit /b 1
)

echo Checking for updates...
git pull
if errorlevel 1 (
    echo.
    echo  Could not pull updates ^(see messages above^). Starting the current version.
    echo.
)

REM Install dependencies if they're missing or package.json changed recently.
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
) else (
    REM Quietly refresh in case a pulled update changed dependencies.
    call npm install --no-audit --no-fund >nul 2>nul
)

echo Starting Compartmentalise...
call npm start

if errorlevel 1 pause
endlocal

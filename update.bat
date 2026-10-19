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

REM This folder must be a git clone for updates to work. A ZIP download from
REM GitHub has no link back to the repo, so there is nothing to pull from.
if not exist ".git" (
    echo.
    echo  This folder is not a git clone, so it cannot receive updates.
    echo  Re-create it with:  git clone https://github.com/MMatthews71/compartmentalise-program.git
    echo  Starting the current version anyway...
    echo.
    goto run
)

echo Checking for updates...
REM Find the current branch and pull it explicitly, so this works even when no
REM upstream tracking is configured (which otherwise causes git to error).
set "BRANCH="
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "BRANCH=%%b"
if not defined BRANCH set "BRANCH=main"

git pull origin %BRANCH%
if errorlevel 1 (
    echo.
    echo  Could not pull updates ^(see messages above^). Starting the current version.
    echo.
) else (
    REM Remember the upstream so a plain 'git pull' works next time too.
    git branch --set-upstream-to=origin/%BRANCH% %BRANCH% >nul 2>nul
)

:run

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

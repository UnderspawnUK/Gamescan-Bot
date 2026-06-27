@echo off
title Gamescan — Build Tool
color 0F
cls

echo.
echo  ============================================
echo   GAMESCAN  -  Desktop App Build Tool
echo  ============================================
echo.

:: ── Check Node.js is installed ──────────────────────────────────────────────
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js not found.
    echo  Please install Node.js from https://nodejs.org then re-run this script.
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODE_VER=%%v
echo  Node.js %NODE_VER% detected

:: ── Move to script directory ─────────────────────────────────────────────────
cd /d "%~dp0"

:: ── Step 1: Install dependencies ────────────────────────────────────────────
echo.
echo  [1/3] Installing dependencies...
echo  ----------------------------------------
call npm install --prefer-offline 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  [ERROR] npm install failed. Check your internet connection and try again.
    pause
    exit /b 1
)
echo  Dependencies installed OK

:: ── Step 2: Bundle JS ────────────────────────────────────────────────────────
echo.
echo  [2/3] Bundling source files...
echo  ----------------------------------------
call node scripts\bundle.js
if %errorlevel% neq 0 (
    echo.
    echo  [ERROR] Bundle step failed. Check the output above for details.
    pause
    exit /b 1
)

:: ── Step 3: Build installer ──────────────────────────────────────────────────
echo.
echo  [3/3] Packaging installer (this takes ~60 seconds)...
echo  ----------------------------------------
call npx electron-builder --win 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  [ERROR] electron-builder failed. See above for details.
    echo  Common fixes:
    echo    - Make sure assets\icon.ico exists
    echo    - Make sure assets\tray.ico exists
    echo    - Run as Administrator if you hit permission errors
    pause
    exit /b 1
)

:: ── Done ─────────────────────────────────────────────────────────────────────
echo.
echo  ============================================
echo   BUILD COMPLETE
echo  ============================================
echo.
echo  Installer location:
echo.

:: Find the produced .exe
for /r dist %%f in (Gamescan-Setup-*.exe) do (
    echo    %%f
    set INSTALLER_PATH=%%f
)

echo.
set /p OPEN="  Open dist folder? [Y/N] "
if /i "%OPEN%"=="Y" (
    explorer dist
)

echo.
echo  Done. Press any key to exit.
pause >nul

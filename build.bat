@echo off
title Gamescan Build
color 0F
cls

echo.
echo  ================================
echo   Gamescan - Build Tool
echo  ================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
  echo  ERROR: Node.js not found. Install from https://nodejs.org
  pause & exit /b 1
)

cd /d "%~dp0"

:: Skip code signing (no certificate needed)
set CSC_IDENTITY_AUTO_DISCOVERY=false
set WIN_CSC_LINK=

echo  [1/3] Installing dependencies...
call npm install --prefer-offline
if %errorlevel% neq 0 ( echo  ERROR: npm install failed. & pause & exit /b 1 )

echo.
echo  [2/3] Bundling source files...
call node scripts\bundle.js
if %errorlevel% neq 0 ( echo  ERROR: Bundle failed. & pause & exit /b 1 )

echo.
echo  [3/3] Building installer...
call npx electron-builder --win
if %errorlevel% neq 0 ( echo  ERROR: Build failed. See above. & pause & exit /b 1 )

echo.
echo  ================================
echo   DONE
echo  ================================
echo.
echo  Installer is in the dist folder.
echo.
set /p O="Open dist folder? [Y/N] "
if /i "%O%"=="Y" explorer dist
echo.
pause

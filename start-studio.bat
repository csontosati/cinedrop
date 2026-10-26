@echo off
SET PATH=%PATH%;C:\Program Files\nodejs
cd /d "%~dp0"
echo Checking Expo CLI login...
call npx.cmd expo whoami >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo Please sign in to your Expo account:
    call npx.cmd expo login
)
echo Starting BB Direct Studio ^(Companion Bridge + Expo iOS Server^)...
call npm.cmd run dev
pause

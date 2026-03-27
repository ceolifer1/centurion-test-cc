@echo off
title Centurion Financial - Local Supabase Clean Start
color 0A

REM Add Docker to PATH
set "PATH=%PATH%;C:\Program Files\Docker\Docker\resources\bin;C:\ProgramData\DockerDesktop\version-bin"

cd /d "%~dp0local-supabase"

echo.
echo   ================================================
echo   Clean Start: Local Supabase
echo   ================================================
echo.

echo   Step 1: Full stop and cleanup...
echo.
call npx supabase stop --no-backup 2>nul
echo.

echo   Step 2: Starting fresh...
echo   (Please wait 1-3 minutes)
echo.
call npx supabase start
echo.

if %ERRORLEVEL% neq 0 (
    echo   ERROR: supabase start failed.
    pause
    exit /b 1
)

echo   Step 3: Resetting DB with migrations...
echo.
call npx supabase db reset
echo.

echo   Step 4: Status...
echo.
call npx supabase status
echo.

echo   ================================================
echo   DONE
echo   ================================================
echo.
pause

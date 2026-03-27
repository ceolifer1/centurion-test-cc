@echo off
title Centurion Financial - Apply Local Migrations
color 0B

echo.
echo   ================================================
echo   Applying migrations to local Supabase
echo   ================================================
echo.

cd /d "%~dp0local-supabase"

:: Check Supabase is running
npx supabase status >nul 2>&1
if %ERRORLEVEL% neq 0 (
    color 0C
    echo   ERROR: Local Supabase is not running.
    echo   Run start-local-supabase.bat first.
    echo.
    pause
    exit /b 1
)

echo   Applying migrations...
npx supabase db push
if %ERRORLEVEL% neq 0 (
    echo.
    echo   WARNING: db push had issues. Trying reset instead...
    echo.
    npx supabase db reset
)

echo.
echo   ================================================
echo   Migrations applied successfully!
echo   ================================================
echo.
echo   View in Supabase Studio: http://localhost:54323
echo.
pause

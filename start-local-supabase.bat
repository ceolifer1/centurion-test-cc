@echo off
title Centurion Financial - Start Local Supabase
color 0A

echo.
echo   Starting local Supabase...
echo.

cd /d "%~dp0local-supabase"

npx supabase start

if %ERRORLEVEL% neq 0 (
    color 0C
    echo.
    echo   Failed to start. Is Docker Desktop running?
    echo.
    pause
    exit /b 1
)

echo.
echo   Local Supabase is running!
echo.
echo   Dashboard:   http://localhost:54323
echo   API URL:     http://localhost:54321
echo   DB:          postgresql://postgres:postgres@localhost:54322/postgres
echo.
pause

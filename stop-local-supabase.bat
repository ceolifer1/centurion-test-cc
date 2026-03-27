@echo off
title Centurion Financial - Stop Local Supabase
color 0C

echo.
echo   Stopping local Supabase...
echo.

cd /d "%~dp0local-supabase"

npx supabase stop

echo.
echo   Local Supabase stopped.
echo   (Docker containers have been removed)
echo.
echo   To preserve data on stop, use: npx supabase stop --backup
echo.
pause

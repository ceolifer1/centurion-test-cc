@echo off
title Centurion Financial - Stop All Servers
color 0C

echo.
echo   Stopping all Vite dev servers...
echo.

taskkill /FI "WINDOWTITLE eq CommandCenter*" /F 2>nul
taskkill /FI "WINDOWTITLE eq Sav.Fund*" /F 2>nul
taskkill /FI "WINDOWTITLE eq LeadCRM*" /F 2>nul
taskkill /FI "WINDOWTITLE eq SPV Matrix*" /F 2>nul
taskkill /FI "WINDOWTITLE eq Centurion*" /F 2>nul

:: Also kill any stray vite/node processes on our ports
for %%p in (5173 5174 5175 5176 5177) do (
    for /f "tokens=5" %%a in ('netstat -aon ^| findstr :%%p ^| findstr LISTENING') do (
        taskkill /PID %%a /F 2>nul
    )
)

echo.
echo   All servers stopped.
echo.
pause

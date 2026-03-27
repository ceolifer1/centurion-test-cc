@echo off
title Centurion Financial - Ecosystem Dev Servers
color 0A

echo.
echo   ========================================
echo   Centurion Financial - Local Dev Servers
echo   ========================================
echo.

set SITES_ROOT=%~dp0

echo   Starting all 5 sites...
echo.

:: CommandCenter on port 5173
start "CommandCenter - :5173" cmd /k "cd /d %SITES_ROOT%commandcenter && npm install --silent 2>nul && echo. && echo   CommandCenter ready: http://localhost:5173 && echo. && npx vite --port 5173 --host"

:: Sav.Fund on port 5174
start "Sav.Fund - :5174" cmd /k "cd /d %SITES_ROOT%savfund && npm install --silent 2>nul && echo. && echo   Sav.Fund ready: http://localhost:5174 && echo. && npx vite --port 5174 --host"

:: LeadCRM on port 5175
start "LeadCRM - :5175" cmd /k "cd /d %SITES_ROOT%leadcrm && npm install --silent 2>nul && echo. && echo   LeadCRM ready: http://localhost:5175 && echo. && npx vite --port 5175 --host"

:: SPV Matrix on port 5176
start "SPV Matrix - :5176" cmd /k "cd /d %SITES_ROOT%spvmatrix && npm install --silent 2>nul && echo. && echo   SPV Matrix ready: http://localhost:5176 && echo. && npx vite --port 5176 --host"

:: Centurion Financial on port 5177
start "Centurion - :5177" cmd /k "cd /d %SITES_ROOT%centurion && npm install --silent 2>nul && echo. && echo   Centurion Financial ready: http://localhost:5177 && echo. && npx vite --port 5177 --host"

timeout /t 5 >nul

echo.
echo   All servers launching in separate windows!
echo.
echo   Site                      URL
echo   ----                      ---
echo   CommandCenter             http://localhost:5173
echo   Sav.Fund                  http://localhost:5174
echo   LeadCRM                   http://localhost:5175
echo   SPV Matrix                http://localhost:5176
echo   Centurion Financial       http://localhost:5177
echo.
echo   Close this window or the individual server windows to stop.
echo.
pause

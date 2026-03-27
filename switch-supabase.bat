@echo off
title Centurion Financial - Switch Supabase Target
color 0E

echo.
echo   ================================================
echo   Switch Supabase Target (Local vs Production)
echo   ================================================
echo.

:: Check current state
if exist "%~dp0commandcenter\.env.local" (
    echo   Current: LOCAL Supabase (http://localhost:54321)
    echo.
    echo   [1] Switch to PRODUCTION Supabase
    echo   [2] Keep LOCAL (no change)
    echo.
    set /p choice="  Enter choice (1 or 2): "
    if "!choice!"=="1" goto :switch_to_prod
    echo   No changes made.
    goto :end
) else (
    echo   Current: PRODUCTION Supabase
    echo.
    echo   [1] Switch to LOCAL Supabase
    echo   [2] Keep PRODUCTION (no change)
    echo.
    set /p choice="  Enter choice (1 or 2): "
    if "!choice!"=="1" goto :switch_to_local
    echo   No changes made.
    goto :end
)

:switch_to_prod
setlocal enabledelayedexpansion
echo.
echo   Switching to PRODUCTION Supabase...
for %%s in (commandcenter savfund leadcrm spvmatrix centurion) do (
    if exist "%~dp0%%s\.env.local" (
        ren "%~dp0%%s\.env.local" ".env.local.bak"
        echo   %%s: switched to production
    )
)
echo.
echo   All sites now pointing to PRODUCTION Supabase.
echo   Restart dev servers (stop-ecosystem.bat then start-ecosystem.bat)
echo   to pick up the changes.
goto :end

:switch_to_local
setlocal enabledelayedexpansion
echo.
echo   Switching to LOCAL Supabase...
for %%s in (commandcenter savfund leadcrm spvmatrix centurion) do (
    if exist "%~dp0%%s\.env.local.bak" (
        ren "%~dp0%%s\.env.local.bak" ".env.local"
        echo   %%s: switched to local
    ) else if not exist "%~dp0%%s\.env.local" (
        echo   %%s: WARNING - no .env.local found. Run setup-local-supabase.bat first.
    ) else (
        echo   %%s: already on local
    )
)
echo.
echo   All sites now pointing to LOCAL Supabase.
echo   Make sure local Supabase is running (start-local-supabase.bat)
echo   Restart dev servers to pick up the changes.
goto :end

:end
echo.
pause

@echo off
title Centurion Financial - Local Supabase Setup
color 0E

echo.
echo   ================================================
echo   Centurion Financial - Local Supabase Setup
echo   ================================================
echo.
echo   This script sets up a local Supabase instance
echo   for isolated development (no production impact).
echo.

:: ─── Check Docker ────────────────────────────────────
echo   [1/4] Checking Docker Desktop...
docker --version >nul 2>&1
if %ERRORLEVEL% neq 0 (
    color 0C
    echo.
    echo   ERROR: Docker is not installed or not in PATH.
    echo.
    echo   Please install Docker Desktop for Windows:
    echo   https://www.docker.com/products/docker-desktop/
    echo.
    echo   After installing:
    echo   1. Open Docker Desktop and let it start
    echo   2. Make sure "Use WSL 2 based engine" is enabled
    echo   3. Re-run this script
    echo.
    pause
    exit /b 1
)

:: Check Docker is running
docker info >nul 2>&1
if %ERRORLEVEL% neq 0 (
    color 0C
    echo.
    echo   ERROR: Docker Desktop is not running.
    echo.
    echo   Please start Docker Desktop and wait for it
    echo   to finish loading, then re-run this script.
    echo.
    pause
    exit /b 1
)
echo   Docker Desktop: OK
echo.

:: ─── Check/Install Supabase CLI ─────────────────────
echo   [2/4] Checking Supabase CLI...
where supabase >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo   Supabase CLI not found. Installing via npm...
    npm install -g supabase
    if %ERRORLEVEL% neq 0 (
        echo.
        echo   npm install failed. Trying npx instead...
        echo   You can also install manually:
        echo     scoop install supabase
        echo   or:
        echo     npm install -g supabase
        echo.
        pause
        exit /b 1
    )
)
echo   Supabase CLI: OK
supabase --version
echo.

:: ─── Initialize local Supabase ──────────────────────
echo   [3/4] Initializing local Supabase project...

set SUPABASE_DIR=%~dp0local-supabase

if not exist "%SUPABASE_DIR%\supabase\config.toml" (
    color 0C
    echo   ERROR: config.toml not found at %SUPABASE_DIR%\supabase\
    echo   Make sure you're running this from the centurion-ecosystem folder.
    pause
    exit /b 1
)

cd /d "%SUPABASE_DIR%"
echo   Working directory: %CD%
echo.

:: ─── Start Supabase ─────────────────────────────────
echo   [4/4] Starting local Supabase (this may take a few minutes on first run)...
echo.
echo   Pulling Docker images and starting services...
echo   (Postgres, Auth, Storage, Realtime, REST API, Studio)
echo.

supabase start

if %ERRORLEVEL% neq 0 (
    color 0C
    echo.
    echo   ERROR: supabase start failed.
    echo   Check the output above for details.
    echo   Common fixes:
    echo   - Make sure Docker Desktop is running
    echo   - Make sure ports 54321-54323 are available
    echo   - Try: supabase stop --no-backup  then re-run
    echo.
    pause
    exit /b 1
)

echo.
echo   ================================================
echo   Local Supabase is running!
echo   ================================================
echo.
echo   Dashboard:   http://localhost:54323
echo   API URL:     http://localhost:54321
echo   DB URL:      postgresql://postgres:postgres@localhost:54322/postgres
echo.
echo   The anon key and service_role key are shown above.
echo   These have been pre-configured in .env.local files
echo   for each site.
echo.
echo   IMPORTANT: Now run the migration script:
echo     apply-local-migrations.bat
echo.
echo   To stop Supabase later:
echo     stop-local-supabase.bat
echo.

pause

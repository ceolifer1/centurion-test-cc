# ============================================================
# Centurion Financial - Complete Local Dev Environment Setup
# ============================================================
# Run this script:
#   powershell -ExecutionPolicy Bypass -File setup-everything.ps1
# ============================================================

$ErrorActionPreference = "Continue"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "  ================================================" -ForegroundColor Cyan
Write-Host "  Centurion Financial - Full Local Setup" -ForegroundColor Cyan
Write-Host "  ================================================" -ForegroundColor Cyan
Write-Host ""

# --- Step 1: Verify Docker Desktop is running ---
Write-Host "  [1/4] Checking Docker Desktop..." -ForegroundColor Yellow

$dockerReady = $false
try {
    $null = docker info 2>$null
    if ($LASTEXITCODE -eq 0) {
        $dockerReady = $true
        Write-Host "  Docker is running!" -ForegroundColor Green
    }
} catch { }

if (-not $dockerReady) {
    $dockerExe = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    if (Test-Path $dockerExe) {
        Write-Host "  Docker Desktop found but not running. Starting it..." -ForegroundColor Yellow
        Start-Process $dockerExe
        Write-Host "  Waiting for Docker engine to be ready (up to 2 minutes)..." -ForegroundColor Gray
        $maxWait = 120
        $waited = 0
        while ($waited -lt $maxWait) {
            Start-Sleep -Seconds 5
            $waited += 5
            try {
                $null = docker info 2>$null
                if ($LASTEXITCODE -eq 0) {
                    Write-Host "  Docker is ready!" -ForegroundColor Green
                    $dockerReady = $true
                    break
                }
            } catch { }
            Write-Host "    Waiting... ($waited sec)" -ForegroundColor Gray
        }
    }

    if (-not $dockerReady) {
        Write-Host ""
        Write-Host "  ERROR: Docker Desktop is not running." -ForegroundColor Red
        Write-Host "  Please open Docker Desktop, wait for it to start," -ForegroundColor Red
        Write-Host "  then re-run this script." -ForegroundColor Red
        Read-Host "  Press Enter to exit"
        exit 1
    }
}

# --- Step 2: Verify npx is available ---
Write-Host ""
Write-Host "  [2/4] Checking npx (for Supabase CLI)..." -ForegroundColor Yellow

$npxAvailable = $false
try {
    $npxVer = npx --version 2>$null
    if ($npxVer) {
        Write-Host "  npx found: v$npxVer" -ForegroundColor Green
        $npxAvailable = $true
    }
} catch { }

if (-not $npxAvailable) {
    Write-Host "  ERROR: npx not found. Please install Node.js first." -ForegroundColor Red
    Read-Host "  Press Enter to exit"
    exit 1
}

# --- Step 3: Start local Supabase ---
Write-Host ""
Write-Host "  [3/4] Starting local Supabase via npx..." -ForegroundColor Yellow
Write-Host "  (First run downloads CLI + Docker images, may take 3-5 min)" -ForegroundColor Gray
Write-Host ""

$supabaseDir = Join-Path $scriptDir "local-supabase"

$configPath = Join-Path $supabaseDir "supabase\config.toml"
if (-not (Test-Path $configPath)) {
    Write-Host "  ERROR: config.toml not found at $configPath" -ForegroundColor Red
    Read-Host "  Press Enter to exit"
    exit 1
}

Set-Location $supabaseDir
Write-Host "  Working directory: $supabaseDir" -ForegroundColor Gray
Write-Host ""

Write-Host "  Running: npx supabase start" -ForegroundColor Gray
npx supabase start

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  First attempt failed. Cleaning up and retrying..." -ForegroundColor Yellow
    npx supabase stop --no-backup 2>$null
    Start-Sleep -Seconds 3
    npx supabase start
}

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  ERROR: supabase start failed." -ForegroundColor Red
    Write-Host "  Check that Docker Desktop is running and ports 54321-54323 are free." -ForegroundColor Red
    Read-Host "  Press Enter to exit"
    exit 1
}

# --- Step 4: Apply migrations ---
Write-Host ""
Write-Host "  [4/4] Applying database migrations..." -ForegroundColor Yellow

npx supabase db push

if ($LASTEXITCODE -ne 0) {
    Write-Host "  db push had issues. Trying db reset..." -ForegroundColor Yellow
    npx supabase db reset
}

# --- Done: Show status ---
Write-Host ""
npx supabase status

Write-Host ""
Write-Host "  ================================================" -ForegroundColor Green
Write-Host "  LOCAL SUPABASE IS READY!" -ForegroundColor Green
Write-Host "  ================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Dashboard:  http://localhost:54323" -ForegroundColor Cyan
Write-Host "  API URL:    http://localhost:54321" -ForegroundColor Cyan
Write-Host "  DB:         postgresql://postgres:postgres@localhost:54322/postgres" -ForegroundColor Cyan
Write-Host ""
Write-Host "  All 5 sites have .env.local files pointing to local Supabase." -ForegroundColor White
Write-Host "  Restart your dev servers (stop-ecosystem.bat then start-ecosystem.bat)" -ForegroundColor White
Write-Host "  to connect them to the local database." -ForegroundColor White
Write-Host ""
Write-Host "  To switch back to production: run switch-supabase.bat" -ForegroundColor Gray
Write-Host ""

Read-Host "  Press Enter to finish"

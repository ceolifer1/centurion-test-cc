@echo off
setlocal enabledelayedexpansion

set WORKSPACE=C:\Users\AshtonCouture\Claude\centurion-ecosystem
set TEST_SUPABASE_URL=https://jctxogntqulmdmjhvccl.supabase.co
set TEST_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpjdHhvZ250cXVsbWRtamh2Y2NsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0NzQyNjIsImV4cCI6MjA5MDA1MDI2Mn0.RCPs1F1qAeWIR_qMEDC7y59YxREna3jpwQhB0kqiyyk
set TEST_PROJECT_ID=jctxogntqulmdmjhvccl
set GITHUB_OWNER=ceolifer1
set LOG=%WORKSPACE%\.logs\deploy-test.log

echo === Centurion Test Environment Deployment === > %LOG%
echo %DATE% %TIME% >> %LOG%

REM Build and deploy savfund
echo Building savfund for test...
cd /d %WORKSPACE%\savfund
set VITE_SUPABASE_URL=%TEST_SUPABASE_URL%
set VITE_SUPABASE_PUBLISHABLE_KEY=%TEST_ANON_KEY%
set VITE_SUPABASE_PROJECT_ID=%TEST_PROJECT_ID%
call npx vite build --base=/centurion-test-sav/ >> %LOG% 2>&1
if errorlevel 1 (echo FAIL: savfund build >> %LOG%) else (echo OK: savfund build >> %LOG%)
copy dist\index.html dist\404.html >> %LOG% 2>&1

REM Copy to test repo
echo Deploying savfund to test repo...
cd /d %WORKSPACE%\centurion-test-sav
xcopy /E /Y /Q %WORKSPACE%\savfund\dist\* . >> %LOG% 2>&1
git add -A >> %LOG% 2>&1
git commit -m "Deploy test build v1.5.1 - role standardization" >> %LOG% 2>&1
git push origin HEAD:gh-pages --force >> %LOG% 2>&1
echo OK: savfund deployed >> %LOG%

REM Build and deploy leadcrm
echo Building leadcrm for test...
cd /d %WORKSPACE%\leadcrm
call npx vite build --base=/centurion-test-lead/ >> %LOG% 2>&1
if errorlevel 1 (echo FAIL: leadcrm build >> %LOG%) else (echo OK: leadcrm build >> %LOG%)
copy dist\index.html dist\404.html >> %LOG% 2>&1

echo Deploying leadcrm to test repo...
cd /d %WORKSPACE%\centurion-test-lead
xcopy /E /Y /Q %WORKSPACE%\leadcrm\dist\* . >> %LOG% 2>&1
git add -A >> %LOG% 2>&1
git commit -m "Deploy test build v1.5.1 - role standardization" >> %LOG% 2>&1
git push origin HEAD:gh-pages --force >> %LOG% 2>&1
echo OK: leadcrm deployed >> %LOG%

REM Build and deploy spvmatrix
echo Building spvmatrix for test...
cd /d %WORKSPACE%\spvmatrix
call npx vite build --base=/centurion-test-spv/ >> %LOG% 2>&1
if errorlevel 1 (echo FAIL: spvmatrix build >> %LOG%) else (echo OK: spvmatrix build >> %LOG%)
copy dist\index.html dist\404.html >> %LOG% 2>&1

echo Deploying spvmatrix to test repo...
cd /d %WORKSPACE%\centurion-test-spv
xcopy /E /Y /Q %WORKSPACE%\spvmatrix\dist\* . >> %LOG% 2>&1
git add -A >> %LOG% 2>&1
git commit -m "Deploy test build v1.5.1 - role standardization" >> %LOG% 2>&1
git push origin HEAD:gh-pages --force >> %LOG% 2>&1
echo OK: spvmatrix deployed >> %LOG%

echo.
echo === Deployment Complete ===
echo Check log: %LOG%
type %LOG% | findstr /i "OK FAIL"

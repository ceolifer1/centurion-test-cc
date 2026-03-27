@echo off
echo === SAVFUND VITE BUILD === > "%~dp0.logs\vite-results.txt" 2>&1
cd /d "%~dp0savfund"
call node_modules\.bin\vite.cmd build >> "%~dp0.logs\vite-results.txt" 2>&1
if %ERRORLEVEL% EQU 0 (echo SAVFUND: PASS >> "%~dp0.logs\vite-results.txt") else (echo SAVFUND: FAIL >> "%~dp0.logs\vite-results.txt")

echo === LEADCRM VITE BUILD === >> "%~dp0.logs\vite-results.txt" 2>&1
cd /d "%~dp0leadcrm"
call node_modules\.bin\vite.cmd build >> "%~dp0.logs\vite-results.txt" 2>&1
if %ERRORLEVEL% EQU 0 (echo LEADCRM: PASS >> "%~dp0.logs\vite-results.txt") else (echo LEADCRM: FAIL >> "%~dp0.logs\vite-results.txt")

echo === SPVMATRIX VITE BUILD === >> "%~dp0.logs\vite-results.txt" 2>&1
cd /d "%~dp0spvmatrix"
call node_modules\.bin\vite.cmd build >> "%~dp0.logs\vite-results.txt" 2>&1
if %ERRORLEVEL% EQU 0 (echo SPVMATRIX: PASS >> "%~dp0.logs\vite-results.txt") else (echo SPVMATRIX: FAIL >> "%~dp0.logs\vite-results.txt")

echo === COMMANDCENTER VITE BUILD === >> "%~dp0.logs\vite-results.txt" 2>&1
cd /d "%~dp0commandcenter"
call node_modules\.bin\vite.cmd build >> "%~dp0.logs\vite-results.txt" 2>&1
if %ERRORLEVEL% EQU 0 (echo COMMANDCENTER: PASS >> "%~dp0.logs\vite-results.txt") else (echo COMMANDCENTER: FAIL >> "%~dp0.logs\vite-results.txt")

echo === DONE === >> "%~dp0.logs\vite-results.txt"

@echo off
echo === SAVFUND TSC CHECK === > "%~dp0.logs\tsc-results.txt" 2>&1
cd /d "%~dp0savfund"
call node_modules\.bin\tsc.cmd --noEmit >> "%~dp0.logs\tsc-results.txt" 2>&1
if %ERRORLEVEL% EQU 0 (echo SAVFUND: PASS >> "%~dp0.logs\tsc-results.txt") else (echo SAVFUND: FAIL >> "%~dp0.logs\tsc-results.txt")

echo === LEADCRM TSC CHECK === >> "%~dp0.logs\tsc-results.txt" 2>&1
cd /d "%~dp0leadcrm"
call node_modules\.bin\tsc.cmd --noEmit >> "%~dp0.logs\tsc-results.txt" 2>&1
if %ERRORLEVEL% EQU 0 (echo LEADCRM: PASS >> "%~dp0.logs\tsc-results.txt") else (echo LEADCRM: FAIL >> "%~dp0.logs\tsc-results.txt")

echo === SPVMATRIX TSC CHECK === >> "%~dp0.logs\tsc-results.txt" 2>&1
cd /d "%~dp0spvmatrix"
call node_modules\.bin\tsc.cmd --noEmit >> "%~dp0.logs\tsc-results.txt" 2>&1
if %ERRORLEVEL% EQU 0 (echo SPVMATRIX: PASS >> "%~dp0.logs\tsc-results.txt") else (echo SPVMATRIX: FAIL >> "%~dp0.logs\tsc-results.txt")

echo === COMMANDCENTER TSC CHECK === >> "%~dp0.logs\tsc-results.txt" 2>&1
cd /d "%~dp0commandcenter"
call node_modules\.bin\tsc.cmd --noEmit >> "%~dp0.logs\tsc-results.txt" 2>&1
if %ERRORLEVEL% EQU 0 (echo COMMANDCENTER: PASS >> "%~dp0.logs\tsc-results.txt") else (echo COMMANDCENTER: FAIL >> "%~dp0.logs\tsc-results.txt")

echo === DONE === >> "%~dp0.logs\tsc-results.txt"

@echo off
echo === SAVFUND VITE BUILD === > "%~dp0.logs\savfund-rebuild.txt" 2>&1
cd /d "%~dp0savfund"
call node_modules\.bin\vite.cmd build >> "%~dp0.logs\savfund-rebuild.txt" 2>&1
if %ERRORLEVEL% EQU 0 (echo SAVFUND: PASS >> "%~dp0.logs\savfund-rebuild.txt") else (echo SAVFUND: FAIL >> "%~dp0.logs\savfund-rebuild.txt")
echo === DONE === >> "%~dp0.logs\savfund-rebuild.txt"

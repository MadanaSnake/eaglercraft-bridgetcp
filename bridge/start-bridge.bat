@echo off
setlocal
cd /d "%~dp0"

echo ==========================================
echo    Eaglercraft ^<^-^> Java TCP Bridge
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo Error: Node.js is not installed. Please install Node.js ^(https://nodejs.org^) first.
    pause
    exit /b 1
)

set "WS_PORT=%~1"
if "%WS_PORT%"=="" set "WS_PORT=8081"

echo Bridge is starting! Open the URL(s) it prints below to configure.
echo Press Ctrl+C to stop.
echo.
node bridge.js "%WS_PORT%" %2 %3 %4 %5
pause

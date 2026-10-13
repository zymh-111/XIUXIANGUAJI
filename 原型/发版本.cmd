@echo off
rem ============================================================
rem  One-click release for the prototype.
rem  Double-click it, or run:  fa-ban-ben.cmd "what changed"
rem  It rebuilds the single-file HTML, bumps the version, zips it,
rem  and runs the built-in self checks.
rem  (Kept ASCII-only so cmd codepage cannot mangle this file.)
rem ============================================================
chcp 65001 >nul
setlocal
set "NODE=C:\Users\1\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

if not exist "%NODE%" (
  echo [ERROR] node not found at:
  echo   %NODE%
  echo Tell Claude the path changed.
  echo.
  pause
  exit /b 1
)

set "NOTE=%~1"
if "%NOTE%"=="" set /p NOTE=Note for this build (optional, Enter to skip): 
if "%NOTE%"=="" set "NOTE=(no note)"

"%NODE%" "%~dp0_release.js" "%NOTE%"
echo.
pause

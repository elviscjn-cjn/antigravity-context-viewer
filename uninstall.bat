@echo off
setlocal
cd /d "%~dp0"

if not exist "%~dp0cli.js" (
  echo [ERROR] Please extract the zip archive completely before running uninstall.bat!
  pause
  exit /b 1
)

set "NODE_EXE="
set "ELECTRON_RUN_AS_NODE="

where node >nul 2>&1
if not errorlevel 1 set "NODE_EXE=node"

if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "D:\nodejs\node.exe" set "NODE_EXE=D:\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%APPDATA%\Antigravity\bin\agy-node.cmd" set "NODE_EXE=%APPDATA%\Antigravity\bin\agy-node.cmd"

if defined NODE_EXE goto :FOUND_NODE

if not exist "%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe" goto :CHECK_PF
set "NODE_EXE=%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe"
set "ELECTRON_RUN_AS_NODE=1"
goto :FOUND_NODE

:CHECK_PF
if not exist "%ProgramFiles%\Antigravity\Antigravity.exe" goto :CHECK_CODEX
set "NODE_EXE=%ProgramFiles%\Antigravity\Antigravity.exe"
set "ELECTRON_RUN_AS_NODE=1"
goto :FOUND_NODE

:CHECK_CODEX
for /d %%D in ("%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\*") do (
  if exist "%%~fD\bin\node.exe" set "NODE_EXE=%%~fD\bin\node.exe"
)
if defined NODE_EXE goto :FOUND_NODE

echo [ERROR] Neither Node.js nor Antigravity was detected on this machine.
echo Please make sure Antigravity or Node.js is installed.
pause
exit /b 1

:FOUND_NODE
call "%NODE_EXE%" cli.js restore %*
if errorlevel 1 (
  echo.
  echo [Notice] Uninstall exited with code %errorlevel%.
)
echo.
pause

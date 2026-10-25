@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"

set "NODE_EXE="
where node >nul 2>&1 && set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "D:\nodejs\node.exe" set "NODE_EXE=D:\nodejs\node.exe"
if not defined NODE_EXE (
  for /d %%D in ("%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\*") do (
    if exist "%%~fD\bin\node.exe" set "NODE_EXE=%%~fD\bin\node.exe"
  )
)
if not defined NODE_EXE if exist "%APPDATA%\Antigravity\bin\agy-node.cmd" set "NODE_EXE=%APPDATA%\Antigravity\bin\agy-node.cmd"

if not defined NODE_EXE (
  echo [错误] 未检测到 Node.js 运行环境，请先安装 Node.js ^(>=18.x^)。
  pause
  exit /b 1
)

"%NODE_EXE%" cli.js restore %*
echo.
if "%1"=="" pause

@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"

echo ========================================================
echo   Antigravity 对话上下文查看器 ^& Token 看板 - 卸载程序
echo ========================================================
echo.

tasklist /fi "imagename eq Antigravity.exe" 2>nul | find /i "Antigravity.exe" >nul
if not errorlevel 1 (
  echo [提示] 检测到 Antigravity 客户端正在运行！
  echo 因 Windows 系统的核心文件独占锁定机制，还原前请先关闭 Antigravity。
  echo 请在任务栏关闭 Antigravity 窗口，关闭后按任意键继续卸载...
  echo.
  pause >nul
)

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
  echo.
  pause
  exit /b 1
)

call "%NODE_EXE%" cli.js restore %*
echo.
pause

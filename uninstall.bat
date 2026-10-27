@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"

echo ========================================================
echo   Antigravity 对话上下文查看器 ^& Token 看板 - 卸载程序
echo ========================================================
echo.

if exist "%~dp0cli.js" goto :CHECK_FILES_OK
echo [错误] 请勿直接在压缩包内双击运行！
echo 请先将压缩包【全部解压缩到独立文件夹】后再运行 uninstall.bat。
echo.
pause
exit /b 1

:CHECK_FILES_OK
tasklist /fi "imagename eq Antigravity.exe" 2>nul | find /i "Antigravity.exe" >nul
if errorlevel 1 goto :SKIP_APP_LOCK_CHECK
echo [提示] 检测到 Antigravity 客户端正在运行！
echo 因 Windows 系统的核心文件独占锁定机制，还原前请先关闭 Antigravity。
echo 请在任务栏或系统托盘完全退出 Antigravity，关闭后按任意键继续卸载...
echo.
pause >nul

:SKIP_APP_LOCK_CHECK
set "NODE_EXE="
set "ELECTRON_RUN_AS_NODE="

where node >nul 2>&1
if not errorlevel 1 set "NODE_EXE=node"

if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "D:\nodejs\node.exe" set "NODE_EXE=D:\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%APPDATA%\Antigravity\bin\agy-node.cmd" set "NODE_EXE=%APPDATA%\Antigravity\bin\agy-node.cmd"

if defined NODE_EXE goto :RUN_RESTORE

if not exist "%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe" goto :CHECK_APPDATA_AGY
set "NODE_EXE=%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe"
set "ELECTRON_RUN_AS_NODE=1"
goto :RUN_RESTORE

:CHECK_APPDATA_AGY
if not exist "%ProgramFiles%\Antigravity\Antigravity.exe" goto :CHECK_CODEX_NODE
set "NODE_EXE=%ProgramFiles%\Antigravity\Antigravity.exe"
set "ELECTRON_RUN_AS_NODE=1"
goto :RUN_RESTORE

:CHECK_CODEX_NODE
for /d %%D in ("%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\*") do (
  if exist "%%~fD\bin\node.exe" (
    set "NODE_EXE=%%~fD\bin\node.exe"
  )
)
if defined NODE_EXE goto :RUN_RESTORE

echo [错误] 未检测到 Node.js 或 Antigravity 运行环境！
echo 请确保已安装 Antigravity 或 Node.js (>=18.x)。
echo.
pause
exit /b 1

:RUN_RESTORE
call "%NODE_EXE%" cli.js restore %*
if errorlevel 1 goto :RESTORE_ERROR
goto :RESTORE_END

:RESTORE_ERROR
echo.
echo ----------------------------------------------------
echo [提示] 卸载未完成或遇到异常，请查看上方详细输出。
echo ----------------------------------------------------

:RESTORE_END
echo.
pause

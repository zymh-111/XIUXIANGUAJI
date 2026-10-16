@echo off
chcp 65001 >nul
title 秘境录 · 启动器
cd /d "%~dp0"

rem ============================================================
rem  秘境录 · 一键启动
rem  起本地服务 + 无边框窗口 + 老板键 + 存档写真实文件
rem  ------------------------------------------------------------
rem  为什么要这个脚本：
rem   · 发布包原本是"双击 index.html"，而那个模式下浏览器【禁止静默写文件】
rem     ⇒ 存档只能塞在 localStorage 里。用这个脚本启动后，存档会写到旁边的
rem     存档.json（可备份 / 可手改 / 可塞网盘）。
rem   · R73 起默认用【桌面窗口壳】(_shell.py)：真无边框（连标题栏都没有）
rem     + 老板键 Ctrl+Alt+H + 置顶 Ctrl+Alt+P。
rem     ⚠️ 窗口壳需要 pywebview（装一次：pip install pywebview）；
rem        没装的话 _shell.py 会【自动退回】老的 Edge --app 窗口，不会卡住你。
rem ============================================================

set PY=
if exist "D:\Python314\python.exe" set PY=D:\Python314\python.exe
if not defined PY (
  where python >nul 2>nul && set PY=python
)
if not defined PY (
  where py >nul 2>nul && set PY=py
)

if not defined PY (
  echo.
  echo   [!] 没找到 Python。
  echo       方法一：装一个 Python 3（勾选 Add to PATH）后重试
  echo       方法二：直接双击 index.html —— 照样能玩，只是存档存在浏览器里
  echo.
  pause
  exit /b 1
)

"%PY%" "%~dp0_shell.py"
if errorlevel 1 (
  echo.
  echo   [!] 窗口壳启动失败，退回 Edge 窗口模式。详细报错见 窗口壳.log
  "%PY%" "%~dp0_launcher.py"
  if errorlevel 1 pause
)

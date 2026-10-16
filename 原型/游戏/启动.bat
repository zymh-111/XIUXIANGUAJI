@echo off
chcp 65001 >nul
title 秘境录 · 启动器
cd /d "%~dp0"

rem ============================================================
rem  秘境录 · 一键启动（R69）
rem  起本地服务 + 用 Edge 的无边框窗口打开 + 存档写真实文件
rem  ------------------------------------------------------------
rem  ⚠️ 为什么要这个：发布包原本是"双击 index.html"，而那个模式下
rem     浏览器【禁止静默写文件】⇒ 存档只能塞在 localStorage 里。
rem     用这个脚本启动后，存档会写到旁边的 存档.json（可备份/可手改）。
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

"%PY%" "%~dp0_launcher.py"
if errorlevel 1 pause

@echo off
chcp 65001 >nul
title 秘境录 · 打包成 exe
cd /d "%~dp0"

rem ============================================================
rem  把《秘境录》打包成一个单文件 exe（双击即玩，不需要 Python）
rem  ------------------------------------------------------------
rem  产物：原型\发布\秘境录\秘境录.exe（约 13 MB）
rem  它旁边必须躺着 index.html / _game.js / assets/ —— 脚本会自动同步过去。
rem  原理：PyInstaller 把 Python 解释器 + pywebview 打进 exe；
rem        WebView2 运行时 Win10/11 自带，不用管。
rem ============================================================

set PY=
if exist "D:\Python314\python.exe" set PY=D:\Python314\python.exe
if not defined PY ( where python >nul 2>nul && set PY=python )
if not defined PY ( where py >nul 2>nul && set PY=py )
if not defined PY (
  echo   [!] 没找到 Python，装一个再重试（勾选 Add to PATH）
  pause & exit /b 1
)

"%PY%" -c "import PyInstaller" 2>nul
if errorlevel 1 (
  echo   [i] 需要先装两个打包用的库：
  echo         pip install pywebview pyinstaller
  echo.
  set /p GO=现在装吗？(Y/N)
  if /i not "%GO%"=="Y" exit /b 1
  "%PY%" -m pip install pywebview pyinstaller || ( echo   安装失败 & pause & exit /b 1 )
)

rem 先同步一次发布包（保证 exe 旁边就是最新的游戏文件）
node "%~dp0_build_release.js" || ( echo   [!] 发布包同步失败 & pause & exit /b 1 )

set TMPB=%TEMP%\mijinglu_exe
set SP=
for /f "delims=" %%i in ('"%PY%" -c "import webview,os;print(os.path.dirname(webview.__file__))"') do set SP=%%i
if not defined SP ( echo   [!] pywebview 位置没取到 & pause & exit /b 1 )

echo.
echo   正在打包（约 1 分钟，别关这个窗口）...
"%PY%" -m PyInstaller --noconfirm --clean --onefile --noconsole ^
  --name 秘境录 ^
  --distpath "%TMPB%\dist" --workpath "%TMPB%\build" --specpath "%TMPB%" ^
  --add-data "%SP%\js;webview/js" --add-data "%SP%\lib;webview/lib" ^
  --hidden-import webview.platforms.edgechromium ^
  --hidden-import webview.platforms.winforms ^
  --collect-submodules webview ^
  "_shell.py"
if errorlevel 1 ( echo   [!] 打包失败，看上面的报错 & pause & exit /b 1 )

copy /y "%TMPB%\dist\秘境录.exe" "发布\秘境录\秘境录.exe" >nul
if errorlevel 1 ( echo   [!] 拷贝失败 & pause & exit /b 1 )

echo.
echo   ✅ 打包完成：原型\发布\秘境录\秘境录.exe
echo      那个目录整个发给别人就能玩（双击 exe，不需要装 Python）
pause

# -*- coding: utf-8 -*-
"""
秘境录 · 本地启动器（R69）

一次解决两件事：
  1) 【存档落成真文件】—— 发布包是"双击 index.html"（file://），该协议下浏览器
     **禁止静默写文件**（安全限制，无 API 可绕）。这里起一个本地服务，游戏把存档
     `POST /save` 过来，写成本目录下的 `存档.json`（可备份 / 可手改 / 可塞网盘）。
  2) 【无边框窗口】—— 用 Edge/Chrome 的 `--app=` 打开，**没有地址栏、没有标签页栏**，
     看起来就是一个独立小应用（顺手也绕开了标签页节流）。

⚠️ 它**不需要联网**：只监听 127.0.0.1（本机回环），不对外开放。

用法：双击同目录的「启动.bat」即可。
端点：
  GET  /ping  → {"app":"mijinglu","ok":true}   （游戏靠它判断"我在启动器下跑"）
  GET  /load  → 存档原文（没有则 404）
  POST /save  → 写入 存档.json（同时留一份 存档.bak.json 作上一次的快照）
"""
import json
import os
import socket
import subprocess
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
# ⚠️ 打包成 exe 后 `__file__` 是临时解包目录 ⇒ 改认 exe 自己所在的位置（游戏文件在它旁边）
if getattr(sys, 'frozen', False):
    ROOT = os.path.dirname(os.path.abspath(sys.executable))
SAVE = os.path.join(ROOT, '存档.json')
BACKUP = os.path.join(ROOT, '存档.bak.json')

SAVE_VER = 1        # 与 _game.js 的 SAVE_VER 保持一致（不符的档会在游戏侧被弃）


def pick_port():
    """挑一个空闲端口（避免和别人占用冲突）。"""
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    # ---------- 静音（不然每读一个素材都刷一行，滚屏看不清提示） ----------
    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/ping':
            return self._json(200, {'app': 'mijinglu', 'ok': True, 'save': os.path.exists(SAVE)})
        if path == '/load':
            if not os.path.exists(SAVE):
                return self._json(404, {'error': 'no-save'})
            with open(SAVE, 'rb') as f:
                data = f.read()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(data)
            return
        return super().do_GET()

    def do_POST(self):
        path = self.path.split('?')[0]
        if path != '/save':
            return self._json(404, {'error': 'not-found'})
        try:
            n = int(self.headers.get('Content-Length') or 0)
            raw = self.rfile.read(n).decode('utf-8')
            d = json.loads(raw)                      # 校验是合法 JSON 才落盘
            if not isinstance(d, dict) or 'v' not in d:
                return self._json(400, {'error': 'bad-save'})
            if os.path.exists(SAVE):                 # 留一份上一次的快照
                try:
                    os.replace(SAVE, BACKUP)
                except OSError:
                    pass
            tmp = SAVE + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                f.write(raw)
            os.replace(tmp, SAVE)                    # 原子替换，避免写一半断电留半个档
            self._json(200, {'ok': True, 'bytes': len(raw), 'v': d.get('v')})
        except Exception as e:                       # noqa: BLE001
            self._json(500, {'error': str(e)})


def find_browser():
    """找一个能开 --app 窗口的 Chromium 浏览器。"""
    cands = [
        r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
        r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
        r'C:\Program Files\Google\Chrome\Application\chrome.exe',
        r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    ]
    for c in cands:
        if os.path.exists(c):
            return c
    return None


def main():
    # 立刻刷 stdout —— 否则输出被重定向（日志/管道）时会被缓冲住，看不到任何提示
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
    port = pick_port()
    url = 'http://127.0.0.1:%d/index.html' % port
    srv = ThreadingHTTPServer(('127.0.0.1', port), Handler)

    print('=' * 58)
    print('  秘境录 · 本地启动器')
    print('=' * 58)
    print('  游戏地址   %s' % url)
    print('  存档位置   %s' % SAVE)
    print()
    print('  · 现在启动的是【无边框窗口】，没有地址栏和标签页')
    print('  · 存档每次自动写入上面的 存档.json（上一份留在 存档.bak.json）')
    print('  · 关掉这个黑窗口 = 关掉游戏服务；游戏窗口请单独关')
    print('=' * 58)

    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()

    br = None if '--no-browser' in sys.argv else find_browser()
    if br:
        # --app = 无边框窗口；--user-data-dir 单独一个，避免和你日常浏览器抢会话
        profile = os.path.join(os.environ.get('LOCALAPPDATA', ROOT), 'MijingluApp')
        subprocess.Popen([
            br, '--app=' + url,
            '--window-size=440,820',
            '--user-data-dir=' + profile,
            '--no-first-run', '--no-default-browser-check',
        ])
    elif '--no-browser' not in sys.argv:
        print('  ⚠️ 没找到 Edge/Chrome，请手动打开：%s' % url)

    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        print('\n已退出。')


if __name__ == '__main__':
    sys.exit(main())

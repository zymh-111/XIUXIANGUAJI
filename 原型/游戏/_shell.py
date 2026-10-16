# -*- coding: utf-8 -*-
"""
秘境录 · 桌面窗口壳（R73）

比 `_launcher.py`（Edge `--app` 窗口）多三件事，都是"上班摸鱼"场景的刚需：

  1) 【真无边框】—— `frameless` 窗口，**连标题栏都没有**。
     （`--app` 的窗口虽然没地址栏/标签页，但顶上还挂着一条标题栏和最小化/关闭按钮）
  2) 【老板键】  —— `Ctrl+Alt+H` 一键隐藏 / 显示，**连任务栏图标一起消失**。
  3) 【置顶开关】—— `Ctrl+Alt+T`，把窗口压在其他窗口上面。
     退出：`Ctrl+Alt+Q`（也可点标题栏上的「关闭」）

热键（全局，窗口没焦点也管用）：
    Ctrl+Alt+H   老板键：隐藏 / 显示
    Ctrl+Alt+T   置顶开关
    Ctrl+Alt+Q   退出（退出前会让游戏先存档）

⚠️ 需要 **pywebview**（+ WebView2 运行时，Win10/11 自带）。
   **缺 pywebview 时自动退回 `_launcher.py` 的 `--app` 窗口**，不会把用户卡死。
   装法：`pip install pywebview`

⚠️ 为什么不用 pywebview 的 `easy_drag`：它往页面里插的是**全局 `mousedown` 监听**
   （见 `webview/js/customize.js`），会把游戏里**所有按钮点击都变成拖窗口**。
   这里改成"只有顶部那一条能拖"，靠 Win32 的 `WM_NCLBUTTONDOWN + HTCAPTION`
   让系统自己进入移动窗口的模态循环 —— 这是无边框窗口最稳的拖法。

⚠️ 控制台窗口默认会被藏起来（不然任务栏挂着个黑框，一点不像"应用"）。
   出问题看同目录的 `窗口壳.log`；想留着控制台加 `--keep-console`。
"""
import ctypes
import ctypes.wintypes as wt
import os
import sys
import threading
import time
import traceback

ROOT = os.path.dirname(os.path.abspath(__file__))
# ⚠️ 打包成 exe（PyInstaller）后 `__file__` 指向的是**临时解包目录**（_MEIPASS），
#    游戏文件（index.html / assets）其实躺在 exe 旁边 ⇒ 必须改认 exe 自己的位置，
#    否则打包版会 404 找不到 index.html。
if getattr(sys, 'frozen', False):
    ROOT = os.path.dirname(os.path.abspath(sys.executable))
sys.path.insert(0, ROOT)

TITLE = '秘境录'
BAR = 26                       # 顶部自定义标题栏高度（px）
GAME_W, GAME_H = 420, 760      # 游戏的设计尺寸（与 index.html 的 #win 一致）
LOG = os.path.join(ROOT, '窗口壳.log')

u32 = ctypes.windll.user32
k32 = ctypes.windll.kernel32


# ----------------------------------------------------------------------------
# 日志：控制台会被藏起来，所以必须落文件（否则出错时用户什么都看不到）
# ----------------------------------------------------------------------------
def log(msg):
    line = time.strftime('[%H:%M:%S] ') + str(msg)
    try:
        with open(LOG, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except OSError:
        pass
    try:
        print(line, flush=True)
    except Exception:
        pass


# ----------------------------------------------------------------------------
# Win32 小工具
# ----------------------------------------------------------------------------
SW_HIDE, SW_SHOW = 0, 5
WM_NCLBUTTONDOWN = 0x00A1
HTCAPTION = 2
SWP_NOMOVE, SWP_NOSIZE = 0x0002, 0x0001
# ⚠️ 必须声明 argtypes：HWND_TOPMOST 是 -1，不声明的话 ctypes 按 32 位传
#    ⇒ 变成 0x00000000FFFFFFFF（无效句柄）⇒ SetWindowPos **静默失败**
u32.SetWindowPos.argtypes = [wt.HWND, wt.HWND, ctypes.c_int, ctypes.c_int,
                            ctypes.c_int, ctypes.c_int, ctypes.c_uint]
HWND_TOPMOST, HWND_NOTOPMOST = wt.HWND(-1), wt.HWND(-2)


def find_hwnd(title, tries=40, gap=0.25):
    """按标题找窗口句柄。找不到返回 0。"""
    for _ in range(tries):
        h = u32.FindWindowW(None, title)
        if h:
            return h
        time.sleep(gap)
    return 0


def start_drag(hwnd):
    """拖动无边框窗口：让系统自己跑"移动窗口"的模态循环。"""
    if not hwnd:
        return
    u32.ReleaseCapture()
    u32.SendMessageW(hwnd, WM_NCLBUTTONDOWN, HTCAPTION, 0)


def hide_console():
    """把跟着 .bat 一起起来的黑框藏掉。"""
    try:
        h = k32.GetConsoleWindow()
        if h:
            u32.ShowWindow(h, SW_HIDE)
            return True
    except Exception:
        pass
    return False


class Hotkeys(threading.Thread):
    """全局热键。

    ⚠️ 必须跑在**自己的线程**上：`RegisterHotKey(hwnd=NULL, ...)` 把热键绑到
       **调用线程**的消息队列，而主线程被 `webview.start()` 自己的消息循环占着。
       在这个线程里跑 `GetMessageW` 就能收到 `WM_HOTKEY`。

    ⚠️ 每个动作给**一串候选键**：全局热键是"先到先得"的，Ctrl+Alt+T 这类常见组合
       很容易被别的软件（截图/录屏/输入法）先占用，`RegisterHotKey` 会直接返回 0。
       实测本机 Ctrl+Alt+T 就是注册失败 ⇒ 逐个往后试，并把**真正生效的那个**回报给用户。
    """
    MOD_ALT, MOD_CONTROL, MOD_NOREPEAT = 0x0001, 0x0002, 0x4000
    WM_HOTKEY = 0x0312

    def __init__(self, bindings):
        super().__init__(daemon=True)
        self.bindings = bindings          # {id: (名字, [vk 候选...], 回调)}
        self.resolved = {}                # id -> vk（真正生效的）

    def run(self):
        for hid, (name, vks, _fn) in self.bindings.items():
            for vk in vks:
                if u32.RegisterHotKey(None, hid, self.MOD_CONTROL | self.MOD_ALT | self.MOD_NOREPEAT, vk):
                    self.resolved[hid] = vk
                    log('热键 %-16s Ctrl+Alt+%s 已注册' % (name, chr(vk)))
                    break
            else:
                log('热键 %-16s ⚠️ 候选组合（%s）全被占用 ⇒ 这个动作只能点标题栏上的按钮'
                    % (name, '/'.join(chr(v) for v in vks)))
        msg = wt.MSG()
        while u32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            if msg.message == self.WM_HOTKEY:
                b = self.bindings.get(int(msg.wParam))
                if b:
                    try:
                        b[2]()
                    except Exception:
                        log('热键回调出错:\n' + traceback.format_exc())


# ----------------------------------------------------------------------------
# 注入到页面里的"自定义标题栏"
# ----------------------------------------------------------------------------
#  ⚠️ 一定要给 body 加 26px 的 padding-top，并且**把窗口高度 +26** ——
#     游戏本体是 `#win{height:min(760px,100%)}`，body 是 flex 居中。
#     加 padding 后内容区少 26px，所以窗口也要高 26px，游戏才能拿到完整的 760。
#  ⚠️ 拖动挂在单独的 `#__shelldrag` 上，不是整条 bar —— 否则点按钮也会开始拖。
INJECT_JS = r"""
(function () {
  if (document.getElementById('__shellbar')) return;
  var BTN = 'padding:3px 9px;border-radius:4px;cursor:pointer;'
          + 'background:#232a37;border:1px solid #333c4d;font-size:11px';
  var bar = document.createElement('div');
  bar.id = '__shellbar';
  bar.style.cssText = 'position:fixed;left:0;right:0;top:0;height:26px;z-index:2147483647;'
    + 'display:flex;align-items:center;padding:0 8px;box-sizing:border-box;'
    + 'background:linear-gradient(#1b212c,#151a22);border-bottom:1px solid rgba(0,0,0,.45);'
    + 'font:12px/1 system-ui,-apple-system,sans-serif;color:#8a93a6;user-select:none';
  bar.innerHTML =
      '<span style="color:#c8b08a;font-weight:600;letter-spacing:1px">秘境录</span>'
    + '<span style="color:#5d574c;margin-left:8px;font-size:10px">Ctrl+Alt+H 老板键</span>'
    + '<span id="__shelldrag" style="flex:1;height:100%;cursor:move"></span>'
    + '<span data-b="top"  style="' + BTN + '">置顶</span>'
    + '<span data-b="hide" style="' + BTN + ';margin-left:5px">隐藏</span>'
    + '<span data-b="quit" style="' + BTN + ';margin-left:5px;color:#e0785f">关闭</span>';
  document.body.appendChild(bar);
  document.body.style.paddingTop = '26px';

  document.getElementById('__shelldrag').addEventListener('mousedown', function (e) {
    if (e.button === 0 && window.pywebview && window.pywebview.api) window.pywebview.api.drag();
  });
  bar.querySelectorAll('[data-b]').forEach(function (el) {
    el.addEventListener('click', function () {
      var b = el.getAttribute('data-b');
      if (!(window.pywebview && window.pywebview.api)) return;
      if (b === 'top') window.pywebview.api.top();
      else if (b === 'hide') window.pywebview.api.hide();
      else if (b === 'quit') window.pywebview.api.quit();
    });
    el.addEventListener('mouseenter', function () { el.style.background = '#2e3747'; });
    el.addEventListener('mouseleave', function () { el.style.background = '#232a37'; });
  });
  window.__shellReady = true;
})();
"""


class Shell:
    def __init__(self):
        self.hwnd = 0
        self.top = False
        self.hidden = False
        self.win = None

    # ---- 供 JS 调 ----
    def drag(self):
        start_drag(self.hwnd)

    def hide(self):
        self.toggle_hide()

    def top_toggle(self):
        self.toggle_top()

    def quit(self):
        log('收到退出请求 —— 先让游戏存档')
        try:
            # 触发游戏的 beforeunload（它里面调 saveGame → POST /save）
            self.win.evaluate_js(
                "try{window.dispatchEvent(new Event('beforeunload'));}catch(e){}")
        except Exception:
            pass
        time.sleep(0.7)                    # 给本地那次 POST 一点时间写完
        try:
            self.win.destroy()
        except Exception:
            pass

    # ---- 老板键 ----
    def toggle_hide(self):
        if not self.hwnd:
            return
        if self.hidden:
            u32.ShowWindow(self.hwnd, SW_SHOW)
            u32.SetForegroundWindow(self.hwnd)
            self.hidden = False
            log('老板键：显示')
        else:
            u32.ShowWindow(self.hwnd, SW_HIDE)
            self.hidden = True
            log('老板键：隐藏（▲ 再按 Ctrl+Alt+H 回来）')

    def toggle_top(self):
        if not self.hwnd:
            return
        self.top = not self.top
        ok = u32.SetWindowPos(self.hwnd,
                              HWND_TOPMOST if self.top else HWND_NOTOPMOST,
                              0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE)
        log('置顶：%s %s' % ('开' if self.top else '关', '' if ok else '（调用失败）'))


def _selftest(sh):
    """进程内自检：注入、无边框、老板键，以及最要紧的那条 ——
    **隐藏窗口到底会不会触发页面的 visibilitychange**（它决定老板键能不能
    顺带把"离开结算"接上：藏起来 = 离开，回来 = 结算）。"""
    out = []
    for _ in range(60):                      # 等窗口句柄
        if sh.hwnd:
            break
        time.sleep(0.25)
    hwnd = sh.hwnd
    out.append(('窗口句柄', hex(hwnd) if hwnd else '找不到'))
    if hwnd:
        s = u32.GetWindowLongW(hwnd, -16)
        out.append(('无标题栏 frameless', '%s  (style=%s)' % (not (s & 0x00C00000), hex(s & 0xFFFFFFFF))))
    js = ('JSON.stringify({bar:!!document.getElementById("__shellbar"),'
          'pad:(document.body.style.paddingTop||""),vis:document.visibilityState,'
          'bgAt:(window.__G&&window.__G._bgAt)||0,kills:(window.__G&&window.__G.totalKills)||0,'
          'hp:!!(window.__api)})')
    time.sleep(1.5)
    out.append(('注入结果', sh.win.evaluate_js(js)))
    k0 = sh.win.evaluate_js('(window.__G&&window.__G.totalKills)||0')
    u32.ShowWindow(hwnd, SW_HIDE)
    # ★ 最要紧的一条：藏起来之后游戏还在不在打？
    #   WebView2 在 SW_HIDE 下 **不改变 document.visibilityState**（实测仍是 visible）
    #   ⇒ Chromium 不会节流 ⇒ 大概率还在全速跑（对摸鱼是好事：藏起来照样挂机）。
    #   但这必须实测，不能靠推断 —— 所以这里直接比"隐藏前后击杀数"。
    time.sleep(6.0)
    out.append(('隐藏 6 秒后页面状态', sh.win.evaluate_js(js)))
    k1 = sh.win.evaluate_js('(window.__G&&window.__G.totalKills)||0')
    out.append(('隐藏期间是否还在打', '击杀 %s → %s（%s）' % (
        k0, k1, ('还在全速跑 ✅' if k1 > k0 else ('停了 ❌（被节流）')))))
    u32.ShowWindow(hwnd, SW_SHOW)
    time.sleep(1.5)
    out.append(('显示后页面状态', sh.win.evaluate_js(js)))
    log('===== 窗口壳自检 =====')
    for k, v in out:
        log('  %-14s %s' % (k, v))
    log('===== 自检结束 =====')
    time.sleep(1.0)
    try:
        sh.win.destroy()
    except Exception:
        pass


def main():
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass

    keep_console = '--keep-console' in sys.argv
    selftest = '--selftest' in sys.argv        # 进程内自检，见 _selftest()

    # ---- 起本地服务（复用 _launcher，不重复造一遍）----
    import _launcher as L
    from http.server import ThreadingHTTPServer
    port = L.pick_port()
    url = 'http://127.0.0.1:%d/index.html' % port
    srv = ThreadingHTTPServer(('127.0.0.1', port), L.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    # ---- 没有 pywebview 就退回 --app 窗口（不要让用户卡住）----
    try:
        import webview
    except ImportError:
        log('没装 pywebview ⇒ 退回 Edge --app 窗口（老板键/无边框这一版用不了）')
        log('想要无边框 + 老板键，装一次就行：  pip install pywebview')
        return L.main()

    sh = Shell()
    api = type('Api', (), {
        'drag': lambda s: sh.drag(),
        'hide': lambda s: sh.hide(),
        'top': lambda s: sh.top_toggle(),
        'quit': lambda s: sh.quit(),
    })()

    sh.win = webview.create_window(
        TITLE, url, js_api=api,
        width=GAME_W, height=GAME_H + BAR,          # ⚠️ +BAR 见 INJECT_JS 上方说明
        frameless=True, easy_drag=False,            # ⚠️ easy_drag 会吃掉所有点击
        resizable=False, background_color='#0f1319',
    )

    def on_loaded():
        try:
            sh.win.evaluate_js(INJECT_JS)
        except Exception:
            log('注入标题栏失败:\n' + traceback.format_exc())
            return
        if selftest:
            threading.Thread(target=_selftest, args=(sh,), daemon=True).start()

    sh.win.events.loaded += on_loaded

    def boot():
        sh.hwnd = find_hwnd(TITLE)
        if not sh.hwnd:
            log('⚠️ 没找到窗口句柄 ⇒ 老板键/置顶不可用（窗口本身还能用）')
            return
        log('窗口句柄 %s · 无边框已生效' % hex(sh.hwnd))
        hk = Hotkeys({
            # 老板键：H 最顺手，退而求其次用 B(oss)/M(inimize)
            1: ('老板键 隐藏/显示', [0x48, 0x42, 0x4D], sh.toggle_hide),
            2: ('置顶开关', [0x54, 0x50, 0x4F], sh.toggle_top),      # T / P / O
            3: ('退出', [0x51, 0x58], sh.quit),                       # Q / X
        })
        hk.start()
        sh.hotkeys = hk
        if not keep_console:
            log('控制台已隐藏（--keep-console 可保留）' if hide_console() else '没有控制台窗口')
        log('就绪：%s' % url)

    threading.Thread(target=boot, daemon=True).start()

    log('=' * 56)
    log('  秘境录 · 桌面窗口壳（无边框 + 老板键）')
    log('    Ctrl+Alt+H  隐藏 / 显示（老板键）')
    log('    Ctrl+Alt+T  置顶开关')
    log('    Ctrl+Alt+Q  退出')
    log('  存档：%s' % L.SAVE)
    log('=' * 56)
    try:
        webview.start(gui='edgechromium')
    except Exception:
        log('窗口壳启动失败 ⇒ 退回 --app 窗口:\n' + traceback.format_exc())
        return L.main()
    log('窗口已关闭。')


if __name__ == '__main__':
    sys.exit(main())

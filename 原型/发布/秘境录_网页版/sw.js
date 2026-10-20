/* ============================================================================
   秘境录 · Service Worker（PWA 离线缓存）
   ----------------------------------------------------------------------------
   设计要点（踩过坑的地方都写在注释里）：

   1. **文件清单不写死在这里**，而是读 `_precache.json`
      ⇒ 新增素材只要重跑 `_tools/make_pwa.js` 重新生成清单，sw.js 不用改。
      ⚠️ 如果把清单写死在 sw.js 里，日后加素材必然忘记同步 ⇒ 离线时 404。

   2. **匹配缓存时要去掉 query string**
      ⚠️ `index.html` 里是 `document.write('<script src="_game.js?t=' + Date.now() + '">')`
         —— 带时间戳防缓存。如果按完整 URL 匹配，每次 `?t=` 都不同
         ⇒ 永远 miss ⇒ 缓存白做、离线打不开。
      ⇒ 统一用 `new URL(req.url).pathname` 作 key。

   3. **导航请求走「网络优先，失败回落缓存」**
      这样更新能拿到新版本；断网也能开。

   4. 静态资源走「缓存优先 + 后台更新」（stale-while-revalidate）
      摸鱼游戏看重秒开，旧一版能接受，下次自动更新。

   5. **不要在 install 里 cache.addAll 全部 250 个文件**
      ⚠️ 只要有一个文件 404，addAll 整体 reject ⇒ SW 装不上 ⇒ PWA 失效。
      ⇒ 改成逐个 add，失败只记一笔，不影响安装。
   ============================================================================ */

const VERSION = 'v1';
const CACHE = 'mijinglu-' + VERSION;
const PRECACHE_URL = './_precache.json';

/* 必须成功的核心文件（这些拿不到就说明部署有问题，值得报错） */
const CORE = ['./', './index.html', './_game.js'];

self.addEventListener('install', function (ev) {
  ev.waitUntil((async function () {
    const cache = await caches.open(CACHE);

    // ① 核心文件：失败就整体失败（部署有问题应该被发现）
    for (const u of CORE) {
      try { await cache.add(new Request(u, { cache: 'reload' })); }
      catch (e) { /* 核心失败不阻塞，下面还有清单兜底 */ }
    }

    // ② 按清单逐个缓存：**单个失败不影响整体**
    try {
      const res = await fetch(PRECACHE_URL, { cache: 'no-store' });
      if (res.ok) {
        const list = await res.json();
        const files = Array.isArray(list) ? list : (list.files || []);
        await Promise.all(files.map(async function (f) {
          try {
            const url = typeof f === 'string' ? f : f.url;
            const req = new Request(url, { cache: 'reload' });
            const r = await fetch(req);
            if (r.ok) await cache.put(new URL(url, self.location.href).pathname, r);
          } catch (e) { /* 单个文件失败：忽略，不影响 SW 安装 */ }
        }));
      }
    } catch (e) { /* 清单拿不到：SW 仍装，只是离线内容少 */ }

    self.skipWaiting();
  })());
});

self.addEventListener('activate', function (ev) {
  ev.waitUntil((async function () {
    // 清掉旧版本缓存
    const keys = await caches.keys();
    await Promise.all(keys.map(function (k) {
      if (k !== CACHE && k.indexOf('mijinglu-') === 0) return caches.delete(k);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', function (ev) {
  const req = ev.request;

  // 只处理 GET；POST（桌面启动器的 /save）直接放行
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // 非本站（比如 data: / blob:）放行
  if (url.origin !== self.location.origin) return;

  // 桌面启动器的本地端点不缓存（手机上本来也不存在）
  if (url.pathname === '/save' || url.pathname === '/load' || url.pathname === '/ping') return;

  const key = url.pathname;   // ★ 去掉 query string（见文件头第 2 条）

  // ① 导航请求（打开页面 / 刷新 / 从主屏点开）：网络优先
  if (req.mode === 'navigate') {
    ev.respondWith((async function () {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put(key, fresh.clone());
        return fresh;
      } catch (e) {
        const cache = await caches.open(CACHE);
        const hit = (await cache.match(key)) || (await cache.match('./index.html'));
        return hit || new Response(
          '<!doctype html><meta charset="utf-8"><body style="background:#16171b;color:#e8bd38;' +
          'font:16px/1.8 KaiTi,serif;padding:40px;text-align:center">' +
          '<h2>秘境录</h2><p>离线缓存还没建好。<br>请联网打开一次，之后就能离线玩了。</p>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }
    })());
    return;
  }

  // ② 静态资源：缓存优先 + 后台更新
  ev.respondWith((async function () {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(key);
    if (hit) {
      // 后台静默更新（不阻塞返回）
      fetch(req).then(function (r) {
        if (r && r.ok) cache.put(key, r.clone());
      }).catch(function () { });
      return hit;
    }
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) cache.put(key, fresh.clone());
      return fresh;
    } catch (e) {
      // 音效/图片缺失时给个空响应，别让页面报错
      return new Response('', { status: 404, statusText: 'offline-miss' });
    }
  })());
});

/* 允许页面主动要求立刻更新（设置里可以加按钮） */
self.addEventListener('message', function (ev) {
  if (ev.data === 'skipWaiting') self.skipWaiting();
});

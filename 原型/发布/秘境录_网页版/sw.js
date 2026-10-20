/* ============================================================================
   秘境录 · Service Worker（PWA 离线缓存）
   ----------------------------------------------------------------------------
   设计要点（踩过坑的地方都写在注释里）：

   1. **文件清单不写死在这里**，而是读 `_precache.json`
      ⇒ 新增素材只要重跑 `_tools/make_pwa.js` 重新生成清单，sw.js 不用改。

   2. **匹配缓存时要去掉 query string**
      ⚠️ `index.html` 里是 `document.write('<script src="_game.js?t=' + Date.now() + '">')`
         —— 带时间戳防缓存。按完整 URL 匹配会永远 miss。

   3. **导航请求**走「网络优先，失败回落缓存」；静态资源走「缓存优先 + 后台更新」。

   4. **不要在 install 里 cache.addAll 全部 250 个文件**
      ⚠️ 只要有一个 404，addAll 整体 reject ⇒ SW 装不上 ⇒ PWA 失效。

   5. ★★ 也不要「Promise.all 一次性并发全部」★★
      ⚠️ 实测：257 个文件并发 ⇒ 手机/弱网被限流，SW 卡在 installing 几十秒
         （2026-10-20 真机前实测只缓存了 55/257）
      ⇒ 改成 **有限并发（6 条）+ 单请求超时（12s）**
         任何一个文件失败/超时都只跳过它，不阻塞整体安装。
   ============================================================================ */

const VERSION = 'v2';                         // ★ 改动过缓存策略就升版本号
const CACHE = 'mijinglu-' + VERSION;
const PRECACHE_URL = './_precache.json';

const CORE = ['./', './index.html', './_game.js'];

/* 并发上限：手机同时开太多连接会被限流，6 条最稳 */
const CONCURRENCY = 6;
/* 单个文件超时（毫秒）。超时 = 跳过，不阻塞安装 */
const FETCH_TIMEOUT = 12000;

function fetchWithTimeout(url) {
  return new Promise(function (resolve) {
    let done = false;
    const timer = setTimeout(function () {
      if (!done) { done = true; resolve(null); }
    }, FETCH_TIMEOUT);

    fetch(new Request(url, { cache: 'reload' }))
      .then(function (r) {
        if (done) return;
        done = true; clearTimeout(timer); resolve(r);
      })
      .catch(function () {
        if (done) return;
        done = true; clearTimeout(timer); resolve(null);
      });
  });
}

/* 有限并发跑一批任务 */
async function runPool(items, worker, limit) {
  let i = 0;
  const runners = [];
  for (let k = 0; k < Math.min(limit, items.length); k++) {
    runners.push((async function () {
      while (true) {
        const idx = i++;
        if (idx >= items.length) return;
        try { await worker(items[idx], idx); } catch (e) { /* 单个失败忽略 */ }
      }
    })());
  }
  await Promise.all(runners);
}

self.addEventListener('install', function (ev) {
  ev.waitUntil((async function () {
    const cache = await caches.open(CACHE);

    // ① 核心文件（失败不阻塞，清单里还有兜底）
    await runPool(CORE, async function (u) {
      const r = await fetchWithTimeout(u);
      if (r && r.ok) {
        try { await cache.put(new URL(u, self.location.href).pathname, r); } catch (e) { }
      }
    }, 3);

    // ② 按清单逐个缓存（有限并发）
    let files = [];
    try {
      const res = await fetch(PRECACHE_URL, { cache: 'no-store' });
      if (res.ok) {
        const list = await res.json();
        files = Array.isArray(list) ? list : (list.files || []);
      }
    } catch (e) { /* 清单拿不到：SW 仍装，只是离线内容少 */ }

    let ok = 0, fail = 0;
    await runPool(files, async function (f) {
      const url = (typeof f === 'string') ? f : f.url;
      const r = await fetchWithTimeout(url);
      if (r && r.ok) {
        try {
          await cache.put(new URL(url, self.location.href).pathname, r);
          ok++;
        } catch (e) { fail++; }
      } else fail++;
    }, CONCURRENCY);

    /* 方便排查：把结果挂在 SW 作用域上（可在 devtools 里看） */
    self.__PRECACHE_RESULT = { ok: ok, fail: fail, total: files.length };

    self.skipWaiting();
  })());
});

self.addEventListener('activate', function (ev) {
  ev.waitUntil((async function () {
    const keys = await caches.keys();
    await Promise.all(keys.map(function (k) {
      if (k !== CACHE && k.indexOf('mijinglu-') === 0) return caches.delete(k);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', function (ev) {
  const req = ev.request;

  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  /* 桌面启动器的本地端点不缓存 */
  if (url.pathname === '/save' || url.pathname === '/load' || url.pathname === '/ping') return;

  const key = url.pathname;   // ★ 去掉 query string

  // ① 导航请求：网络优先
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
      return new Response('', { status: 404, statusText: 'offline-miss' });
    }
  })());
});

self.addEventListener('message', function (ev) {
  if (ev.data === 'skipWaiting') self.skipWaiting();
  if (ev.data === 'stats') {
    ev.source.postMessage({ type: 'stats', result: self.__PRECACHE_RESULT || null });
  }
});

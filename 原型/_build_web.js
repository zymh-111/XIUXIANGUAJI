#!/usr/bin/env node
/* ============================================================================
   生成【网页版】部署包 —— 只含浏览器需要的东西
   ----------------------------------------------------------------------------
   为什么单独一个包：
     `发布/秘境录/` 是【桌面版】：除了网页文件，还带
       启动.bat / _launcher.py（本地存档通道）/ _shell.py（无边框窗口壳）
       玩之前看这里.txt
     这些传到服务器上纯属垃圾（.bat 在 Linux 服务器上是死文件，
     .py 不上传也能跑，反而可能被人直接下载源码）。
     ⇒ 网页版只留 6 项：index.html / _game.js / manifest.json / sw.js /
        _precache.json / assets/

   用法：
     node 原型/_build_web.js
   输出：
     原型/发布/秘境录_网页版/
   ============================================================================ */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '游戏');
const PKG = path.join(__dirname, '发布', '秘境录_网页版');

/* 只拷这 6 项 */
const FILES = ['index.html', '_game.js', 'manifest.json', 'sw.js', '_precache.json'];
const DIRS = ['assets'];

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  for (const name of fs.readdirSync(p)) {
    const q = path.join(p, name);
    const st = fs.statSync(q);
    if (st.isDirectory()) { rmrf(q); fs.rmdirSync(q); }
    else fs.unlinkSync(q);
  }
}

function copyDir(a, b) {
  if (!fs.existsSync(b)) fs.mkdirSync(b, { recursive: true });
  let n = 0;
  for (const name of fs.readdirSync(a)) {
    const s = path.join(a, name), d = path.join(b, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) n += copyDir(s, d);
    else { fs.copyFileSync(s, d); n++; }
  }
  return n;
}

function sizeOf(dir) {
  let n = 0, b = 0;
  (function walk(d) {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else { n++; b += st.size; }
    }
  })(dir);
  return { n, b };
}

/* ---------------- 开始 ---------------- */
console.log('=== 生成网页版部署包 ===');

if (!fs.existsSync(path.join(SRC, '_precache.json'))) {
  console.log('  ❌ 缺 _precache.json —— 先跑 node 游戏/_tools/make_pwa.js');
  process.exit(1);
}

rmrf(PKG);
fs.mkdirSync(PKG, { recursive: true });

let bad = 0;
for (const f of FILES) {
  const s = path.join(SRC, f);
  if (!fs.existsSync(s)) { console.log('  ❌ 缺文件: ' + f); bad++; continue; }
  fs.copyFileSync(s, path.join(PKG, f));
  console.log('  ✅ ' + f + '  ' + Math.round(fs.statSync(s).size / 1024) + ' KB');
}
for (const d of DIRS) {
  const s = path.join(SRC, d);
  if (!fs.existsSync(s)) { console.log('  ❌ 缺目录: ' + d); bad++; continue; }
  const n = copyDir(s, path.join(PKG, d));
  console.log('  ✅ ' + d + '/  ' + n + ' 个文件');
}

/* ---------------- nginx 配置 ---------------- */
fs.writeFileSync(path.join(PKG, 'nginx.conf.txt'), `# ============================================================================
# 秘境录 · nginx 配置片段
# ----------------------------------------------------------------------------
# 拷到你的 server{} 块里。假设部署在 /mijinglu/ 这个路径下；
# 如果直接放站点根目录，把 location 里的 /mijinglu/ 去掉即可。
#
# 三个必须点（缺一个都会"看起来正常但实际坏掉"）：
#   1. woff2 / webp / mp3 的 MIME —— 类型错了字体和音效会【静默不加载】
#   2. sw.js 必须 no-cache —— 否则浏览器永远拿旧版 Service Worker，改完不生效
#   3. index.html 也建议 no-cache —— 否则改了看不到
# ============================================================================

location /mijinglu/ {
    alias /srv/www/mijinglu/;
    index index.html;

    # ① MIME（nginx 默认 mime.types 一般已有，但显式写一遍更稳）
    types {
        text/html            html;
        application/javascript js;
        application/json     json;
        application/manifest+json json;
        text/css             css;
        image/png            png;
        image/webp           webp;
        image/svg+xml        svg;
        font/woff2           woff2;
        font/woff            woff;
        audio/mpeg           mp3;
    }
    default_type application/octet-stream;

    # ② 入口和 Service Worker 不许缓存
    location = /mijinglu/index.html {
        alias /srv/www/mijinglu/index.html;
        add_header Cache-Control "no-cache, must-revalidate";
    }
    location = /mijinglu/sw.js {
        alias /srv/www/mijinglu/sw.js;
        add_header Cache-Control "no-cache, must-revalidate";
        add_header Service-Worker-Allowed "/mijinglu/";
    }
    location = /mijinglu/_precache.json {
        alias /srv/www/mijinglu/_precache.json;
        add_header Cache-Control "no-cache, must-revalidate";
    }

    # ③ 带 hash 的静态资源可以长缓存（这里按目录粗放处理）
    location /mijinglu/assets/ {
        alias /srv/www/mijinglu/assets/;
        expires 30d;
        add_header Cache-Control "public, max-age=2592000";
    }
}

# ⚠️ 必须是 HTTPS（或 localhost）Service Worker 才会注册。
#    纯 http 也能玩，但【没有离线】和【不能添加到主屏】。
#    Let's Encrypt 免费证书：certbot --nginx -d 你的域名
`, 'utf8');

/* ---------------- Apache 配置 ---------------- */
fs.writeFileSync(path.join(PKG, '.htaccess'), `# ============================================================================
# 秘境录 · Apache 配置（放在本目录即可生效，需要 AllowOverride All）
# ============================================================================

# ① MIME 类型
<IfModule mod_mime.c>
  AddType application/javascript          .js
  AddType application/json                .json
  AddType image/webp                      .webp
  AddType font/woff2                      .woff2
  AddType audio/mpeg                      .mp3
</IfModule>

# ② 入口 + Service Worker 不缓存
<IfModule mod_headers.c>
  <FilesMatch "^(index\\.html|sw\\.js|_precache\\.json|manifest\\.json)$">
    Header set Cache-Control "no-cache, must-revalidate"
  </FilesMatch>
  <FilesMatch "\\.(png|webp|mp3|woff2)$">
    Header set Cache-Control "public, max-age=2592000"
  </FilesMatch>
</IfModule>

# ③ 默认首页
DirectoryIndex index.html

# ⚠️ 必须是 HTTPS（或 localhost）Service Worker 才会注册。
`, 'utf8');

/* ---------------- 部署说明 ---------------- */
fs.writeFileSync(path.join(PKG, '怎么部署.txt'), `秘境录 · 网页版部署说明
================================================================

【第一步】把本文件夹里的【全部内容】上传到服务器的网站目录。
          建议单独放一个子目录，例如：
              /srv/www/mijinglu/
          最终访问地址形如：
              https://你的域名/mijinglu/index.html

【第二步】配 MIME 和缓存（不配也能玩，但会有坑）
          · nginx  → 见 nginx.conf.txt（拷进 server{} 块）
          · Apache → .htaccess 已放在本目录，确保 AllowOverride All
          最关键的三条：
            1. woff2 / webp / mp3 的 MIME 要对（错了字体和音效静默不加载）
            2. sw.js 必须 no-cache（否则改了不生效）
            3. index.html 也要 no-cache

【第三步】开 HTTPS
          · Service Worker 只在 HTTPS / localhost 下工作
          · 纯 http 也能玩，但【没有离线】【不能添加到主屏】
          · 免费证书：Let's Encrypt  certbot --nginx -d 你的域名

【第四步】手机打开
          Android Chrome / iOS Safari 打开上面那个地址
          → 浏览器菜单 → 「添加到主屏幕」（iOS 是"共享 → 添加到主屏幕"）
          → 桌面出现「秘」图标，点开全屏、可离线

【自检清单】（打不开时按这个顺序查）
  □ https://你的域名/mijinglu/index.html       能出画面
  □ https://你的域名/mijinglu/manifest.json    返回 JSON（不是 404，不是 HTML）
  □ https://你的域名/mijinglu/sw.js            返回 JS（不是 404）
  □ https://你的域名/mijinglu/_precache.json   返回 JSON，里面有 files 数组
  □ 浏览器 F12 → Application → Manifest        没有红色报错
  □ 浏览器 F12 → Application → Service Workers 状态 activated
  □ 字体看着是【楷体风】（不是宋体/黑体）⇒ woff2 MIME 对了

【常见问题】
  · 画面出来了但字是宋体 → woff2 的 MIME 配错，或 assets/字体/ 没上传
  · 能玩但不能"添加到主屏" → 没有 HTTPS，或 manifest.json 404
  · 改了代码看不到变化 → sw.js 被缓存了，必须 no-cache
  · 音效没声音 → 正常，手机必须先点一下屏幕（自动播放限制）
  · 存档在浏览器里 → 换手机/清缓存会丢。这是网页版的固有局限
`, 'utf8');

/* ---------------- 自检 ---------------- */
const sz = sizeOf(PKG);
console.log('');
console.log('  ' + (bad ? '❌ 有缺文件' : '✅ 打包完成') + '：' + sz.n + ' 个文件 · ' + (sz.b / 1024 / 1024).toFixed(2) + ' MB');

/* 不许混入桌面版文件 */
const forbidden = ['启动.bat', '_launcher.py', '_shell.py', '玩之前看这里.txt', '秘境录.exe'];
const leaked = forbidden.filter(function (f) { return fs.existsSync(path.join(PKG, f)); });
console.log('  ' + (leaked.length ? '❌ 混入桌面文件: ' + leaked.join(', ') : '✅ 没有桌面版文件'));

/* 必须自包含：index.html 里不许有 ../ 或绝对路径 */
const html = fs.readFileSync(path.join(PKG, 'index.html'), 'utf8');
const outside = [];
// 用字符串扫描而不是正则（正则里转义 ../ 很容易写错，踩过一次）
['src="../', "src='../", 'href="../', "href='../", 'url("../', "url('../"].forEach(function (pat) {
  if (html.indexOf(pat) >= 0) outside.push(pat);
});
console.log('  ' + (outside.length ? '❌ 有指向目录外的引用: ' + outside.join(', ')
  : '✅ 全部相对路径，自包含'));

/* precache 清单里的文件都得真的存在 */
const pc = JSON.parse(fs.readFileSync(path.join(PKG, '_precache.json'), 'utf8'));
const lost = pc.files.filter(function (f) {
  const rel = (f.indexOf('./') === 0) ? f.slice(2) : f;
  return !fs.existsSync(path.join(PKG, rel));
});
console.log('  ' + (lost.length ? '❌ 清单里有 ' + lost.length + ' 个文件不存在: ' + lost.slice(0, 3).join(', ')
  : '✅ 离线清单 ' + pc.count + ' 项全部存在'));

if (bad || leaked.length || outside.length || lost.length) process.exit(1);

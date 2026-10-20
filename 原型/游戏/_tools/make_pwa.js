#!/usr/bin/env node
/* ============================================================================
   生成 PWA 的离线清单 `_precache.json`
   ----------------------------------------------------------------------------
   为什么单独一个脚本：
     素材随时会加（图标 / 音效 / 立绘），如果把文件清单写死在 sw.js 里，
     必然有一天忘记同步 ⇒ 离线时 404 且没人发现。
     ⇒ 清单是【生成物】，每次改完素材 / 打包前重跑一遍。

   用法：
     node _tools/make_pwa.js

   ⚠️ 用【白名单】而不是黑名单
      游戏目录里混着大量开发文件：`_预览_*.png`（几张就 1 MB+）、`_smoke.js`、
      `_tmp_*.png`、`index_宽屏版.bak.html`……
      黑名单永远列不全 ⇒ 曾一次算出 6.61 MB（真实内容只有 ~2.8 MB）。
      白名单只认「跑游戏真正需要的」四类，加新目录时显式补一行。
   ============================================================================ */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '_precache.json');

const files = [];

function push(abs) {
  let st;
  try { st = fs.statSync(abs); } catch (e) { return; }
  if (!st.isFile()) return;
  files.push({
    rel: './' + path.relative(ROOT, abs).split(path.sep).join('/'),
    bytes: st.size,
  });
}

/* 只缓存浏览器真正会去取的资源类型
   ⚠️ `assets/来源与授权.md` 是署名文档 —— 必须随包发布（CC BY 要求），
      但不需要进离线缓存（浏览器不会 fetch 它，缓存了纯浪费）
   ⇒ 按扩展名白名单过滤，而不是"目录里有什么就全拿" */
const WEB_EXT = new Set(['.webp', '.png', '.jpg', '.jpeg', '.gif', '.svg',
  '.mp3', '.ogg', '.wav', '.m4a',
  '.woff', '.woff2', '.ttf']);

function walkDir(absDir) {
  let names;
  try { names = fs.readdirSync(absDir); } catch (e) { return; }
  for (const name of names) {
    if (name.startsWith('.')) continue;          // .DS_Store / .workbuddy 之类
    if (name === '__MACOSX') continue;
    const p = path.join(absDir, name);
    let st;
    try { st = fs.statSync(p); } catch (e) { continue; }
    if (st.isDirectory()) walkDir(p);
    else if (WEB_EXT.has(path.extname(name).toLowerCase())) push(p);
  }
}

/* ---------------- 白名单：只缓存这四类 ---------------- */
// ① 入口与逻辑
push(path.join(ROOT, 'index.html'));
push(path.join(ROOT, '_game.js'));
// ② PWA 元数据
push(path.join(ROOT, 'manifest.json'));
// ③ 全部素材（立绘 / 音效 / 图标 / 场景）
walkDir(path.join(ROOT, 'assets'));
/* ------------------------------------------------------ */

const list = files.map(function (f) { return f.rel; })
  .sort(function (a, b) {
    const CORE = ['./index.html', './_game.js', './manifest.json'];
    const ia = CORE.indexOf(a), ib = CORE.indexOf(b);
    if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    return a.localeCompare(b);
  });

const totalBytes = files.reduce(function (a, f) { return a + f.bytes; }, 0);

const payload = {
  generated: new Date().toISOString(),
  count: list.length,
  bytes: totalBytes,
  note: '由 _tools/make_pwa.js 生成，勿手改。加了新素材要重跑。',
  files: list,
};

fs.writeFileSync(OUT, JSON.stringify(payload, null, 1), 'utf8');

console.log('  ✅ _precache.json 已生成');
console.log('     ' + payload.count + ' 个文件 · ' + (totalBytes / 1024 / 1024).toFixed(2) + ' MB');

/* ---------------- 自检 ---------------- */
let bad = 0;

// ① 核心文件必须在
const CORE = ['./index.html', './_game.js', './manifest.json'];
const missing = CORE.filter(function (f) { return list.indexOf(f) < 0; });
if (missing.length) { console.log('  ❌ 缺核心文件: ' + missing.join(', ')); bad++; }
else console.log('     核心文件齐全: ' + CORE.join(' '));

// ② 路径格式
const badPath = list.filter(function (f) { return f.indexOf('\\') >= 0 || /^[A-Za-z]:/.test(f) || f.indexOf('//') >= 0; });
if (badPath.length) { console.log('  ❌ 非法路径: ' + badPath.slice(0, 3).join(', ')); bad++; }
else console.log('     路径格式正常（相对 + 正斜杠）');

// ③ 不许混入开发文件（这条是上次 6.61 MB 的教训）
const dev = list.filter(function (f) {
  return /\/(_preview|_tmp|_tools|_smoke|_init_test)/.test(f) ||
         /_预览|_tmp_|\.bak\.|\.py$|\.md$|存档\.json/.test(f);
});
if (dev.length) { console.log('  ❌ 混入开发文件: ' + dev.slice(0, 5).join(', ')); bad++; }
else console.log('     没有混入开发文件');

// ④ 体积红线：超过 5 MB 说明规则又漏了
if (totalBytes > 5 * 1024 * 1024) {
  console.log('  ❌ 体积异常 ' + (totalBytes / 1024 / 1024).toFixed(2) + ' MB（真实内容约 2.8 MB）—— 白名单漏了？');
  bad++;
} else console.log('     体积正常');

if (bad) process.exit(1);

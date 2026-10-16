// ============================================================
//  打包脚本（Round 37）
//  生成：
//    发布/秘境录/             —— 可玩的发布目录
//    发布/秘境录_v3_发给朋友.zip
//  原则：
//    · 字体太大（52MB）⇒ 【不打包】，CSS 里 fallback 到楷体
//    · 背景图只有 132KB ⇒ 打包进去（否则画面会空）
//    · _game.js 零外部依赖 ⇒ 直接拷
// ============================================================
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = 'D:/游戏资料库';
const SRC = ROOT + '/原型/游戏';
const OUT = ROOT + '/原型/发布';
const PKG = OUT + '/秘境录';

function mk(p) { fs.mkdirSync(p, { recursive: true }); }
function copy(a, b) { fs.copyFileSync(a, b); }

// ---- 版本号：用 _game.js 的 mtime ----
const srcMtime = fs.statSync(SRC + '/_game.js').mtime;
const ver = 'v3';
const buildTime = new Date().toISOString().slice(0, 16).replace('T', ' ');
const stamp = Math.floor(srcMtime.getTime() / 1000);

console.log('=== 打包 秘境录 ' + ver + ' ===');

// 清空并重建
fs.rmSync(PKG, { recursive: true, force: true });
mk(PKG);
mk(PKG + '/assets');

// ---- ① index.html：重写路径 ----
let h = fs.readFileSync(SRC + '/index.html', 'utf8');

// 字体：删掉 @font-face（避免 404 请求），让 CSS fallback 生效
h = h.replace(/\s*@font-face\{[^}]*\}\s*/g, '\n');
// 背景图：改成包内相对路径
h = h.replace(/\.\.\/\.\.\/美术资源\/04_水墨背景\//g, 'assets/');
// 脚本：去掉 ?v= 查询串（file:// 下更稳）
h = h.replace(/_game\.js\?v=\d+/g, '_game.js');
// 标题下加版本行
h = h.replace('</head>', '<!-- 秘境录 ' + ver + ' · build ' + buildTime + ' -->\n</head>');
fs.writeFileSync(PKG + '/index.html', h, 'utf8');

// ---- ② _game.js ----
copy(SRC + '/_game.js', PKG + '/_game.js');

// ---- ②之二 本地启动器（R69）----
//   用户："存档不要存在浏览器上面"。而双击 index.html（file://）下浏览器
//   【禁止静默写文件】，必须有个能写盘的通道 ⇒ 启动器起本地服务 + 无边框窗口。
//   ⚠️ 加了新文件就要加进这里，不然发布包里没有（漏一次就是"启动.bat 点了没反应"）
for (const _lf of ['启动.bat', '_launcher.py']) {
  if (fs.existsSync(SRC + '/' + _lf)) { copy(SRC + '/' + _lf, PKG + '/' + _lf); console.log('  ✅ 启动器已打包：' + _lf); }
}

// ---- ③ 背景图（拷进来，因为它是画面的一部分）----
const bg = ROOT + '/美术资源/04_水墨背景/asian-mountain-forest-bg__sprite_northWindShrineBG.png';
if (fs.existsSync(bg)) {
  copy(bg, PKG + '/assets/asian-mountain-forest-bg__sprite_northWindShrineBG.png');
  console.log('  ✅ 背景图已打包');
} else {
  console.log('  ⚠️ 背景图缺失，画面会少一层山景');
}

// ---- ③之二 · 通用：整个 assets/ 递归拷进包 ----
//   ⚠️ 原来是一段段"逐个目录拷"（背景图 / 弟子 / 经络图）—— 每次加新素材都要改这个脚本，
//      漏一次就是发布版裂图（实际漏了：宗门地图、设施图标、妖怪立绘）
//   ⇒ 改成通用递归拷贝 + 反向校验，加了什么素材都不会漏
function copyDir(src, dst) {
  if (!fs.existsSync(src)) return 0;
  mk(dst);
  let n = 0;
  for (const f of fs.readdirSync(src)) {
    const sp = src + '/' + f, dp = dst + '/' + f;
    if (fs.statSync(sp).isDirectory()) n += copyDir(sp, dp);
    else { copy(sp, dp); n++; }
  }
  return n;
}
const assetN = copyDir(SRC + '/assets', PKG + '/assets');
console.log('  ✅ assets/ 已打包（' + assetN + ' 个文件）');

// ---- ④ 校验 ----
const files = [];
(function walk(p, rel) {
  for (const f of fs.readdirSync(p)) {
    const fp = p + '/' + f, r = rel ? rel + '/' + f : f;
    if (fs.statSync(fp).isDirectory()) walk(fp, r);
    else files.push({ r, size: fs.statSync(fp).size });
  }
})(PKG, '');
console.log('');
console.log('  包内文件：');
let total = 0;
for (const f of files) { total += f.size; console.log('    ' + f.r.padEnd(52) + Math.round(f.size / 1024) + ' KB'); }
console.log('    ' + '合计'.padEnd(52) + Math.round(total / 1024) + ' KB');

// 检查还有没有指向包外的路径
let bad = [];
for (const f of files) {
  if (!/\.(html|js)$/.test(f.r)) continue;
  const c = fs.readFileSync(PKG + '/' + f.r, 'utf8');
  const m = c.match(/\.\.\/\.\.\/[^\s'")]+/g);
  if (m) bad = bad.concat(m.map(x => f.r + ' -> ' + x));
}
console.log('');
console.log('  ' + (bad.length ? '❌ 仍有指向包外的路径：\n    ' + bad.join('\n    ') : '✅ 无指向包外的路径'));

// 检查引用的 assets 是否都在
const imgs = [];
for (const f of files) {
  if (!/\.html$/.test(f.r)) continue;
  const c = fs.readFileSync(PKG + '/' + f.r, 'utf8');
  for (const m of c.matchAll(/src="([^"]+)"/g)) {
    if (!/^(data:|http)/.test(m[1])) imgs.push(m[1]);
  }
}
const missing = imgs.filter(u => !fs.existsSync(PKG + '/' + u.split('?')[0]));
console.log('  ' + (missing.length ? '❌ 缺失资源：' + missing.join(', ') : '✅ 引用资源齐全 (' + imgs.length + ' 个)'));

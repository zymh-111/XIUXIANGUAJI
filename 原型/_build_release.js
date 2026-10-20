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
//
// ⚠️ R73：这一步**失败过，而且失败得很危险**——`rmSync` 有可能挂在半路
//   （本机就见过一次：删除被一个"移入回收站"的垫片接管，`ETIMEDOUT` 直接抛错）。
//   结果是【发布目录被删掉一半、脚本当场退出】⇒ 目录里只剩 assets，
//   index.html / _game.js / 启动器全没了。**如果没注意就把它发出去，就是个坏包。**
//   ⇒ 两道保险：① 删除失败不再直接抛，改成逐项删；② 最后断言关键文件真的在。
function wipeDir(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch (e) {
    console.log('  ⚠️ 整目录删除失败（' + e.message + '）⇒ 改成逐项删');
    try {
      for (const f of fs.readdirSync(p)) {
        try { fs.rmSync(p + '/' + f, { recursive: true, force: true }); }
        catch (e2) { console.log('  ⚠️ 删不掉：' + f + '（' + e2.message + '）'); }
      }
      return true;
    } catch (e2) {
      console.log('  ❌ 清空失败：' + e2.message);
      return false;
    }
  }
}
if (!wipeDir(PKG)) process.exit(1);
mk(PKG);
mk(PKG + '/assets');

// ---- ① index.html：重写路径 ----
let h = fs.readFileSync(SRC + '/index.html', 'utf8');

// 字体：★★ Round 54 起**不再删除 @font-face**
//   以前删掉是因为原路径指向 `../../美术资源/02_字体/`（游戏目录【外面】）
//   ⇒ 发布包里必然 404 ⇒ 只能退回系统兜底字体（等于发布包的字体一直是错的）
//   现在改成：字体已裁剪成 woff2 放进 `assets/字体/`，随包发布 ⇒ 可以正常引用了。
//   ⚠️ 只有真的缺文件时才退化成删除（避免 404）。
{
  const _fontDir = SRC + '/assets/字体';
  const _need = ['WenKai-Regular.woff2', 'WenKai-Medium.woff2', 'SmileySans-Oblique.woff2'];
  const _missing = _need.filter(function (f) { return !fs.existsSync(_fontDir + '/' + f); });
  if (_missing.length) {
    console.log('  ⚠️ 缺裁剪字体 ' + _missing.join(',') + ' ⇒ 删掉 @font-face 退回系统字体');
    console.log('     修法：python _tools/subset_fonts.py');
    h = h.replace(/\s*@font-face\{[^}]*\}\s*/g, '\n');
  } else {
    console.log('  ✅ 字体齐全，保留 @font-face（assets/字体/ 3 个 woff2）');
  }
}
// 背景图：改成包内相对路径
h = h.replace(/\.\.\/\.\.\/美术资源\/04_水墨背景\//g, 'assets/');
// 脚本：去掉 ?v= 查询串（file:// 下更稳）
h = h.replace(/_game\.js\?v=\d+/g, '_game.js');
// 标题下加版本行
h = h.replace('</head>', '<!-- 秘境录 ' + ver + ' · build ' + buildTime + ' -->\n</head>');
fs.writeFileSync(PKG + '/index.html', h, 'utf8');

// ---- ② _game.js ----
copy(SRC + '/_game.js', PKG + '/_game.js');

// ---- ②之二 本地启动器（R69 / R73）----
//   用户："存档不要存在浏览器上面"。而双击 index.html（file://）下浏览器
//   【禁止静默写文件】，必须有个能写盘的通道 ⇒ 启动器起本地服务 + 无边框窗口。
//   ⚠️ 加了新文件就要加进这里，不然发布包里没有（漏一次就是"启动.bat 点了没反应"）
//   R73：加了 `_shell.py`（桌面窗口壳：真无边框 + 老板键 + 置顶）。
//        它 import `_launcher` 复用本地服务 ⇒ 两个都要在。
for (const _lf of ['启动.bat', '_launcher.py', '_shell.py', '玩之前看这里.txt']) {
  if (fs.existsSync(SRC + '/' + _lf)) { copy(SRC + '/' + _lf, PKG + '/' + _lf); console.log('  ✅ 启动器已打包：' + _lf); }
  else console.log('  ⚠️ 缺文件（发布包里不会有）：' + _lf);
}

// ---- ②之三 PWA 三件套（Round 54）----
//   用户选的是"手机浏览器 + 添加到主屏"这条线。
//   ⚠️ 三个文件缺一个都会让 PWA 失效，而且【不会有报错】：
//      · manifest.json 缺 → 不能"添加到主屏幕"
//      · sw.js 缺        → 不能离线
//      · _precache.json 缺 → SW 装上了但离线内容是空的（最隐蔽）
for (const _pf of ['manifest.json', 'sw.js', '_precache.json']) {
  if (fs.existsSync(SRC + '/' + _pf)) { copy(SRC + '/' + _pf, PKG + '/' + _pf); console.log('  ✅ PWA 已打包：' + _pf); }
  else console.log('  ❌ 缺 PWA 文件（PWA 会失效）：' + _pf + '  —— 先跑 node _tools/make_pwa.js');
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

// ============================================================
// ★ R73：最后一道保险 —— 关键文件必须真的在，否则以【非 0 退出码】报错。
//   为什么加：清空步骤可能半途失败（见上方 wipeDir 的说明），而上面那些检查
//   只打印"缺资源"却照样 exit 0 ⇒ **一个坏包看起来像"打包成功"**。
//   实际踩过一次：发布目录只剩 assets/，index.html 和启动器全没了。
// ============================================================
const MUST = ['index.html', '_game.js', '启动.bat', '_launcher.py', '_shell.py', '玩之前看这里.txt',
  // ★ Round 54：PWA 三件套 + 裁剪字体（缺一个都"看起来正常"但实际坏掉）
  'manifest.json', 'sw.js', '_precache.json',
  'assets/字体/WenKai-Regular.woff2', 'assets/pwa/icon-192.png', 'assets/pwa/icon-512.png',
  'assets/pwa/icon-maskable-512.png', 'assets/pwa/apple-touch-icon.png'];
const absent = MUST.filter(f => !fs.existsSync(PKG + '/' + f));
if (absent.length || bad.length || missing.length) {
  console.log('');
  console.log('  ❌ 发布包不完整 —— 不要发出去！');
  if (absent.length) console.log('     缺关键文件：' + absent.join('、'));
  process.exit(1);
}
console.log('');
console.log('  ✅ 发布包完整：' + files.length + ' 个文件 · ' + Math.round(total / 1024) + ' KB');

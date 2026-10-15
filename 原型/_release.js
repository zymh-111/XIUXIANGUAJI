// ============================================================
// 一条命令发布原型（带资源的完整包）
//   node 原型\_release.js "这次改了什么"
//   或双击 原型\发版本.cmd
//
// 产物：发布/秘境录原型/  ← 可直接双击里面的 秘境录.html 试玩
//       发布/秘境录_原型_vN_完整包.zip ← 发给朋友的就是这个
//
// 为什么是"文件夹包"而不是单个 html：
//   现在这一版用了大量贴图（assets/ 86 个文件，路径由 JS 动态拼接）
//   和 3 个中文字体（共 52MB）。单文件内联必然缺图缺字，
//   所以必须保持 assets/ 与 字体/ 的目录结构一起发。
//
// 每次都会做：
//   1. 把 index.html 里的字体路径改成包内的 字体/ 目录
//   2. 把开发期的 document.write 时间戳加载改回固定 _game.js
//   3. 注入版本角标（页面右下角小字）+ 标题后缀
//   4. 复制 _game.js / assets 全量 / 用到的字体 / 机制验证器
//   5. 生成给朋友的说明书，打 zip（内置 zip 写入）
//   6. 自动校验：资源齐全、无外链、无越界路径、zip 完整、跑冒烟测试
//   7. 内容真变了才 +1 版本号，并往 发布/_更新记录.md 记一行
// ============================================================

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = __dirname;                             // 原型/
const OUT = path.join(ROOT, '发布');
const GAME_DIR = path.join(ROOT, '游戏');
const STAGE = path.join(OUT, '秘境录_完整版');        // 暂存目录（已加入 .gitignore）
const PACK_NAME = '秘境录_完整版';                    // zip 内的顶层目录名（固定，方便覆盖升级）
const STATE = path.join(OUT, '_build.json');
const CHANGELOG = path.join(OUT, '_更新记录.md');
const TEMPLATE = path.join(ROOT, '说明模板.txt');
const FONT_SRC = path.join(path.dirname(ROOT), '美术资源', '02_字体');

const NOTE = (process.argv[2] || '').trim() || '（未填备注）';
const sha = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const kb = n => (n / 1024).toFixed(0) + ' KB';
const mb = n => (n / 1024 / 1024).toFixed(1) + ' MB';

fs.mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------
// 〇、保险：源码最近 90 秒内还被改过 ⇒ 可能在编辑中，拒绝打包
//    确实要强行打包：加 --force
// ------------------------------------------------------------
const GUARD_SEC = 90;
if (!process.argv.includes('--force')) {
  const assetsDir = path.join(GAME_DIR, 'assets');
  const watch = [path.join(GAME_DIR, 'index.html'), assetsDir]   // 贴图改名也算"正在编辑"
    .concat(fs.readdirSync(GAME_DIR).filter(f => f.endsWith('.js')).map(f => path.join(GAME_DIR, f)));
  let newest = 0, who = '';
  for (const f of watch) {
    const t = fs.statSync(f).mtimeMs;
    if (t > newest) { newest = t; who = path.relative(ROOT, f); }
  }
  const age = (Date.now() - newest) / 1000;
  if (age < GUARD_SEC) {
    console.log(`\n⛔ 拒绝打包：${who} 在 ${age.toFixed(0)} 秒前还在改动，可能正编辑到一半。`);
    console.log('   等源码安静 90 秒后重跑，或加 --force 强行打包。');
    process.exit(1);
  }
}

// ------------------------------------------------------------
// 一、改造 index.html：字体路径 / 开发期加载 / 版本角标
// ------------------------------------------------------------
let html = fs.readFileSync(path.join(GAME_DIR, 'index.html'), 'utf8');
const rewrites = [];

// 1) 字体：'../../美术资源/02_字体/...' → '字体/<文件名>'
const fontsUsed = new Map();   // 包内名 → 源绝对路径
html = html.replace(/(['"])(?:\.\.\/)+美术资源\/02_字体\/([^'"]+)\1/g, (m, q, rel) => {
  const src = path.join(FONT_SRC, rel.split('/').join(path.sep));
  if (!fs.existsSync(src)) throw new Error('字体文件不存在：' + src);
  const base = path.basename(rel);
  fontsUsed.set(base, src);
  return `${q}字体/${base}${q}`;
});
if (fontsUsed.size) rewrites.push(`字体路径 ${fontsUsed.size} 处 → 字体/`);

// 2) 开发期的"每次换时间戳"加载 ⇒ 发布版改回固定名（源码注释里也是这么建议的）
const devLoader = /<script>\s*document\.write\('<script src="_game\.js\?t=' \+ Date\.now\(\) \+ '"><\\\/script>'\);\s*<\/script>/;
if (devLoader.test(html)) {
  html = html.replace(devLoader, '<script src="_game.js"></script>');
  rewrites.push('document.write 时间戳加载 → 固定 <script src="_game.js">');
} else {
  throw new Error('没找到开发期的 document.write 加载片段，index.html 结构变了，请检查打包脚本');
}

// 3) 版本角标（固定右下角，不影响 400×648 竖窗布局）+ 标题后缀
let prev = { v: 0, hash: '' };
if (fs.existsSync(STATE)) {
  try { prev = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { /* 坏了就重来 */ }
}

const assetList = [];
(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p);
    else assetList.push({ abs: p, rel: path.relative(GAME_DIR, p).replace(/\\/g, '/'), size: fs.statSync(p).size });
  }
})(path.join(GAME_DIR, 'assets'));
assetList.sort((a, b) => a.rel.localeCompare(b.rel));

// 内容指纹：html + js + assets 内容（不掺时间戳，用来判断"是否真的变了"）
const fp = crypto.createHash('sha256');
fp.update(html);
fp.update(fs.readFileSync(path.join(GAME_DIR, '_game.js')));
for (const a of assetList) fp.update(a.rel + ':' + fp2(a.abs));
function fp2(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
const stampInput = fp.digest('hex').slice(0, 16);

const changed = stampInput !== prev.hash;
const v = changed ? (prev.v || 0) + 1 : prev.v;
const ver = 'v' + v;

const d = new Date();
const pad = n => String(n).padStart(2, '0');
const buildTime = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
                  `${pad(d.getHours())}:${pad(d.getMinutes())}`;

const badge = `<div id="buildTag" style="position:fixed;right:6px;bottom:6px;z-index:99999;` +
  `font:9px/1.4 sans-serif;color:#cfc8ba80;pointer-events:none;letter-spacing:.5px">` +
  `构建 ${ver} · ${buildTime}</div>`;
if (!/id="buildTag"/.test(html)) {
  html = html.replace(/<\/body>/i, badge + '\n</body>');
  if (!/id="buildTag"/.test(html)) throw new Error('注入版本角标失败：找不到 </body>');
}
html = html.replace(/<\/title>/i, ` · ${ver}</title>`);
rewrites.push(`注入版本角标 ${ver}`);

// ------------------------------------------------------------
// 二、铺开 staging 目录（每次重建，避免残留旧文件）
// ------------------------------------------------------------
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

const entry = path.join(STAGE, 'index.html');   // 入口名与源码一致（另一个会话的包也是 index.html）
fs.writeFileSync(entry, html, 'utf8');

fs.copyFileSync(path.join(GAME_DIR, '_game.js'), path.join(STAGE, '_game.js'));

// assets 整份复制（路径是 JS 动态拼的，不能挑）
copyDir(path.join(GAME_DIR, 'assets'), path.join(STAGE, 'assets'));

// 只复制 html 里真正引用到的字体
const fontDir = path.join(STAGE, '字体');
fs.mkdirSync(fontDir, { recursive: true });
let fontBytes = 0;
for (const [base, src] of fontsUsed) {
  fs.copyFileSync(src, path.join(fontDir, base));
  fontBytes += fs.statSync(src).size;
}

// 机制验证器（本来就是单文件，没有再依赖）
fs.copyFileSync(path.join(ROOT, '验证原型.html'), path.join(STAGE, '秘境录_机制验证器.html'));

// 说明书
let readme;
if (fs.existsSync(TEMPLATE)) {
  readme = fs.readFileSync(TEMPLATE, 'utf8')
    .replace(/\{\{V\}\}/g, ver).replace(/\{\{BUILD\}\}/g, buildTime).replace(/\{\{NOTE\}\}/g, NOTE);
} else {
  readme = `秘境录 原型 ${ver}（构建于 ${buildTime}）\n本次改动：${NOTE}\n\n` +
           `解压整个文件夹后双击 秘境录.html 试玩（图片字体都在文件夹里，别单独把 html 拖出来）。\n`;
}
const readmePath = path.join(STAGE, '0_先看这个.txt');
fs.writeFileSync(readmePath, '\uFEFF' + readme, 'utf8');   // BOM：中文 Windows 记事本不乱码
// 同时在发布根目录留一份（.gitignore 里白名单了它 ⇒ 说明书也能进 git 版本历史）
fs.writeFileSync(path.join(OUT, '0_先看这个.txt'), '\uFEFF' + readme, 'utf8');

// ------------------------------------------------------------
// 三、打 zip
// ------------------------------------------------------------
const zipName = `秘境录_${ver}_完整版_含字体.zip`;
const zipPath = path.join(OUT, zipName);

const entries = [];
(function collect(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) collect(p);
    else entries.push({
      name: PACK_NAME + '/' + path.relative(STAGE, p).replace(/\\/g, '/'),
      data: fs.readFileSync(p),
    });
  }
})(STAGE);

writeZip(zipPath, entries);

// ------------------------------------------------------------
// 四、构建状态 + 更新记录（内容没变就不刷记录）
// ------------------------------------------------------------
fs.writeFileSync(STATE, JSON.stringify({
  v, hash: stampInput, ver, buildTime, note: NOTE, zip: zipName,
  files: entries.length, fontBytes, packBytes: fs.statSync(zipPath).size,
}, null, 2), 'utf8');

if (changed) {
  if (!fs.existsSync(CHANGELOG)) {
    fs.writeFileSync(CHANGELOG, '# 原型更新记录\n\n（发版本前建议写清改了啥，方便朋友对照反馈）\n\n', 'utf8');
  }
  fs.appendFileSync(CHANGELOG, `- **${ver}** · ${buildTime} · ${NOTE}\n`, 'utf8');
}

// ------------------------------------------------------------
// 五、报告
// ------------------------------------------------------------
const packBytes = fs.statSync(zipPath).size;
console.log(`\n${changed ? '🆕 内容有变化，版本号 +1' : '↩️  内容与上一版相同，沿用'} ${ver}`);
console.log(`   构建时间：${buildTime}`);
console.log(`   备注：${NOTE}`);
console.log(`   改造：${rewrites.join('；')}`);
console.log(`   目录：发布\\秘境录_完整版\\  （双击里面的 index.html 即可试玩）`);
console.log(`   打包：${entries.length} 个文件 · 贴图 ${mb(assetList.reduce((s, a) => s + a.size, 0))}` +
            ` · 字体 ${mb(fontBytes)}`);
console.log(`   ${zipName}   ${mb(packBytes)}   ← 发这个给朋友`);

// ------------------------------------------------------------
// 六、自动校验
// ------------------------------------------------------------
console.log('\n开始校验打包产物…');
require('./发布/_verify_pack.js');

// ============================================================
// 工具函数
// ============================================================
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, f.name), t = path.join(to, f.name);
    if (f.isDirectory()) copyDir(s, t);
    else fs.copyFileSync(s, t);
  }
}

// ZIP：deflate + UTF-8 文件名标记（不依赖 PowerShell / 7-Zip）
function writeZip(out, entries) {
  let T = null;
  const crcTable = () => {
    if (T) return T;
    T = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      T[n] = c;
    }
    return T;
  };
  const crc32 = buf => {
    const t = crcTable();
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ t[(c ^ buf[i]) & 0xFF];
    return (c ^ -1) >>> 0;
  };

  const now = new Date();
  const dTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
  const dDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const nm = Buffer.from(e.name, 'utf8');
    // 大文件（贴图/字体）用低压缩级别，省时间；文本用最高
    const lvl = e.data.length > 2 * 1024 * 1024 ? 6 : 9;
    const comp = zlib.deflateRawSync(e.data, { level: lvl });
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt16LE(dTime, 10); lh.writeUInt16LE(dDate, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nm.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, nm, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(dTime, 12); ch.writeUInt16LE(dDate, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nm.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, nm);
    offset += lh.length + nm.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  // ⚠️ 这里踩过坑：writeUInt16LE(0, 0) 会把签名前两字节覆盖掉，zip 直接打不开
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  fs.writeFileSync(out, Buffer.concat([...parts, cd, eocd]));
}

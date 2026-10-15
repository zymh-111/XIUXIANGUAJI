// ============================================================
// 校验"带资源的完整包"（不是校验源码）
//   1. 包内 秘境录.html 引用的每个 assets/、字体/ 文件都真实存在
//   2. assets 与源目录逐字节一致，且一个都没漏（路径是 JS 动态拼的）
//   3. 没有外链、没有越出包的 ../ 路径、开发期 document.write 已换掉
//   4. 版本角标与 _build.json 一致（防止改了源码忘了重新打包）
//   5. zip 完整性：读回中央目录、逐条解压、比对 CRC 与字节
//   6. 游戏逻辑冒烟测试（跑源码那套 _smoke.js）
// ============================================================

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const vm = require('vm');

const OUT = __dirname;
const STAGE = path.join(OUT, '秘境录_完整版');
const PACK = '秘境录_完整版';                 // zip 内顶层目录名
const SRC = path.join(__dirname, '..', '游戏');

let bad = 0;
const ok = m => console.log('  ✅ ' + m);
const no = m => { console.log('  ❌ ' + m); bad++; };

const state = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(OUT, '_build.json'), 'utf8')); } catch { return null; }
})();

// ---------- 1. 目录结构 ----------
console.log('\n【一】目录结构');
if (!fs.existsSync(STAGE)) { console.log('  ❌ staging 目录不存在：' + STAGE); process.exit(1); }
const need = ['index.html', '_game.js', 'assets', '字体', '0_先看这个.txt', '秘境录_机制验证器.html'];
for (const n of need) {
  fs.existsSync(path.join(STAGE, n)) ? ok(`${n}`) : no(`缺少 ${n}`);
}

const html = fs.readFileSync(path.join(STAGE, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(STAGE, '_game.js'), 'utf8');

// ---------- 2. 引用的资源是否都在 ----------
console.log('\n【二】资源引用完整性');
const refs = new Set(
  [...(html + js).matchAll(/assets\/[A-Za-z0-9_@\-\u4e00-\u9fa5\/\.]+/g)]
    .map(m => m[0].replace(/[.,)]+$/, ''))
);
const missing = [...refs].filter(r => !fs.existsSync(path.join(STAGE, r)));
// 动态拼接的路径只能看到前缀（形如 assets/妖怪/妖_），这些不算缺失
const dynPrefix = missing.filter(m => /[\/_]$/.test(m));
const realMissing = missing.filter(m => !/[\/_]$/.test(m));
if (realMissing.length) realMissing.forEach(m => no('引用了但包里没有：' + m));
else ok(`静态引用 ${refs.size} 条全部命中（其中 ${dynPrefix.length} 条是 JS 动态拼接的前缀，属正常）`);

// ---------- 3. assets 一个都不能少 ----------
console.log('\n【三】贴图全量核对（路径由 JS 拼，必须整份带上）');
const listFiles = root => {
  const out = [];
  (function w(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) w(p); else out.push(path.relative(root, p).replace(/\\/g, '/'));
    }
  })(root);
  return out.sort();
};
const srcAssets = listFiles(path.join(SRC, 'assets'));
const pkgAssets = listFiles(path.join(STAGE, 'assets'));
const absent = srcAssets.filter(a => !pkgAssets.includes(a));
if (absent.length) absent.slice(0, 10).forEach(a => no('包内缺贴图：' + a));
else ok(`源目录 ${srcAssets.length} 个贴图，包里 ${pkgAssets.length} 个，一个不少`);

const changedBytes = srcAssets.filter(a => {
  const h = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  return pkgAssets.includes(a) && h(path.join(SRC, 'assets', a)) !== h(path.join(STAGE, 'assets', a));
});
changedBytes.length ? no(`有 ${changedBytes.length} 个贴图与源目录不一致`) : ok('全部贴图与源目录逐字节一致');

// ---------- 4. 字体 ----------
console.log('\n【四】字体');
const fontRefs = [...new Set([...html.matchAll(/字体\/([^'")]+)/g)].map(m => m[1]))];
if (!fontRefs.length) no('html 里没有引用任何字体（确认是否需要）');
for (const f of fontRefs) {
  const p = path.join(STAGE, '字体', f);
  fs.existsSync(p) ? ok(`字体/${f}  ${(fs.statSync(p).size / 1024 / 1024).toFixed(1)} MB`) : no('字体缺失：' + f);
}
const fontFiles = fs.readdirSync(path.join(STAGE, '字体'));
const fontTotal = fontFiles.reduce((s, f) => s + fs.statSync(path.join(STAGE, '字体', f)).size, 0);
ok(`字体目录共 ${fontFiles.length} 个文件 / ${(fontTotal / 1024 / 1024).toFixed(1)} MB`);

// ---------- 5. 安全性 / 可离线 ----------
console.log('\n【五】离线可开 & 无越界引用');
const checks = [
  [/<script[^>]*\bsrc="(https?:)?\/\//i, '远程脚本'],
  [/\bfetch\s*\(/, 'fetch()'],
  [/XMLHttpRequest/, 'XMLHttpRequest'],
  [/https?:\/\/[^\s'"]+\.(js|css|png|jpg|ttf|woff2?)/i, '远程资源地址'],
  [/\.\.\/\.\.\/美术资源/, '仍指向包外的 美术资源/ 路径'],
  [/document\.write\('<script src="_game\.js\?t=/, '开发期时间戳加载未替换'],
];
for (const [re, name] of checks) {
  (re.test(html) || re.test(js)) ? no('仍存在：' + name) : ok('无 ' + name);
}
/<script src="_game\.js"><\/script>/.test(html) ? ok('入口脚本为固定 _game.js') : no('入口脚本不是固定引用');

// ---------- 6. 版本一致性 ----------
console.log('\n【六】版本一致性（防止改了源码忘打包）');
const m1 = html.match(/id="buildTag"[^>]*>([^<]*)</);
const m2 = html.match(/<title>([^<]*)<\/title>/);
if (!m1) no('页面里找不到版本角标 buildTag');
else if (state && !m1[1].includes(state.ver)) no(`角标「${m1[1].trim()}」与 _build.json 的 ${state.ver} 不符`);
else ok(`角标：${m1[1].trim()} ｜ 标题：${(m2 ? m2[1] : '?').trim()}`);

const h = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
h(path.join(STAGE, '_game.js')) === h(path.join(SRC, '_game.js'))
  ? ok('包内 _game.js 与源文件逐字节一致（下面的冒烟测试结论直接适用）')
  : no('包内 _game.js 与源文件不一致');

// ---- 机制验证器：语法自检 ----
try {
  const mech = fs.readFileSync(path.join(STAGE, '秘境录_机制验证器.html'), 'utf8');
  const blocks = [...mech.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(x => x[1]);
  new vm.Script(blocks.join('\n;\n'));
  ok(`机制验证器：内联脚本 ${blocks.length} 段，语法正确`);
} catch (e) { no('机制验证器脚本有问题：' + e.message); }

// ---------- 7. zip 完整性 ----------
console.log('\n【七】zip 完整性（读回中央目录 + 逐条解压比对）');
const TT = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; }
  return t;
})();
const crc32 = buf => { let c = -1; for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ TT[(c ^ buf[i]) & 0xFF]; return (c ^ -1) >>> 0; };

const zipPath = path.join(OUT, state ? state.zip : '__none__');
if (!state || !fs.existsSync(zipPath)) no('找不到 _build.json 记录的 zip：' + (state && state.zip));
else {
  const b = fs.readFileSync(zipPath);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) no('不是有效 zip：找不到 EOCD');
  else {
    const count = b.readUInt16LE(eocd + 10);
    let off = b.readUInt32LE(eocd + 16);
    const entries = [];
    for (let i = 0; i < count; i++) {
      const method = b.readUInt16LE(off + 10);
      const crc = b.readUInt32LE(off + 16);
      const compSize = b.readUInt32LE(off + 20);
      const size = b.readUInt32LE(off + 24);
      const nameLen = b.readUInt16LE(off + 28);
      const extraLen = b.readUInt16LE(off + 30);
      const cmtLen = b.readUInt16LE(off + 32);
      const localOff = b.readUInt32LE(off + 42);
      const name = b.slice(off + 46, off + 46 + nameLen).toString('utf8');
      const lnameLen = b.readUInt16LE(localOff + 26);
      const lextraLen = b.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lnameLen + lextraLen;
      const raw = b.slice(start, start + compSize);
      const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
      entries.push({ name, data, good: data.length === size && crc32(data) === crc });
      off += 46 + nameLen + extraLen + cmtLen;
    }

    const stageFiles = listFiles(STAGE);
    const expect = new Set(stageFiles.map(f => PACK + '/' + f));
    const got = new Set(entries.map(e => e.name));
    const lost = [...expect].filter(x => !got.has(x));
    const extra = [...got].filter(x => !expect.has(x));
    const broken = entries.filter(e => !e.good);

    entries.length === stageFiles.length
      ? ok(`zip 内 ${entries.length} 条条目，与 staging 文件数一致`)
      : no(`条目数不符：zip ${entries.length} / staging ${stageFiles.length}`);
    lost.length ? no(`zip 里缺 ${lost.length} 个文件，例如 ${lost[0]}`) : ok('zip 覆盖全部文件');
    if (extra.length) no(`zip 里有 ${extra.length} 个多余条目`);
    broken.length ? no(`${broken.length} 条解压后 CRC/长度不符，zip 可能损坏`) : ok('全部条目解压成功、CRC 校验通过');

    // 抽样逐字节比对（全量太慢：入口 + 脚本 + 说明 + 前几张图 + 字体头尾）
    const sample = [PACK + '/index.html', PACK + '/_game.js', PACK + '/0_先看这个.txt'];
    stageFiles.filter(f => f.startsWith('assets/') && f.endsWith('.png')).slice(0, 3)
      .forEach(f => sample.push(PACK + '/' + f));
    fontFiles.slice(0, 1).forEach(f => sample.push(PACK + '/字体/' + f));
    let diff = 0;
    for (const s of sample) {
      const e = entries.find(x => x.name === s);
      const local = fs.readFileSync(path.join(STAGE, s.replace(PACK + '/', '')));
      if (!e || !e.data.equals(local)) { no('抽样比对不一致：' + s); diff++; }
    }
    if (!diff) ok(`抽样 ${sample.length} 个文件（入口/脚本/说明/贴图/字体）与 staging 逐字节一致`);
    console.log(`  ℹ️  zip 体积 ${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB / ${entries.length} 个文件`);
  }
}

// ---------- 8. 冒烟测试 ----------
// ⚠️ _smoke.js 结尾是 process.exit()：直接 require 会把本校验进程一起带走
//    （曾因此丢掉全部结论）⇒ 这里临时接管 process.exit，把它的输出截下来自己判读
console.log('\n【八】游戏逻辑冒烟测试（跑源码那套 _smoke.js）');
const buf = [];
const origLog = console.log;
const origExit = process.exit;
console.log = (...a) => buf.push(a.join(' '));
process.exit = code => { const e = new Error('smoke-exit'); e.__smokeExit = code === undefined ? 0 : code; throw e; };
let crashed = null, smokeExit = null;
try { require('../游戏/_smoke.js'); } catch (e) {
  if (e && e.__smokeExit !== undefined) smokeExit = e.__smokeExit; else crashed = e;
}
process.exit = origExit;
console.log = origLog;
const text = buf.join('\n');
const passM = text.match(/全部通过（(\d+) 项）/);
const failM = text.match(/❌ (\d+) 项失败 \/ (\d+) 项通过/);
if (crashed) no('冒烟测试抛异常：' + crashed.message);
else if (passM && smokeExit === 0) ok(`全部通过（${passM[1]} 项）`);
else {
  no(`冒烟测试未全通过：${failM ? failM[0] : '退出码 ' + smokeExit}`);
  text.split('\n').filter(l => l.includes('❌')).slice(0, 8).forEach(l => console.log('     ' + l.trim()));
}

console.log(bad ? `\n⚠️  校验发现 ${bad} 处问题` : '\n🎉 全部校验通过');
if (bad) process.exitCode = 1;

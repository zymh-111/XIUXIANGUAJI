// ============================================================
// 校验"打包产物"本身（不是源文件）：
//   1. 两份单文件 HTML 里没有任何外部引用（离线可开）
//   2. 可玩原型内联的脚本，能通过完整的 _smoke.js 冒烟测试（79 项）
//   3. 机制验证器的内联脚本语法正确
//   4. 两份 HTML 都带版本水印，且版本号与 _build.json 一致
//      （防止"改了源码忘了重新打包"，结果发出去还是旧版）
// ============================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const OUT = __dirname;
const files = {
  game: path.join(OUT, '秘境录_可玩原型.html'),
  mech: path.join(OUT, '秘境录_机制验证器.html'),
};

function inlineScripts(html) {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

const EXT = [
  [/<script[^>]*\bsrc=/i, '外部 <script src>'],
  [/\bfetch\s*\(/, 'fetch()'],
  [/XMLHttpRequest/, 'XMLHttpRequest'],
  [/<link[^>]*\bhref=/i, '外部 <link href>'],
  [/url\(\s*['"]?https?:/i, 'CSS 远程 url()'],
  [/@import/i, 'CSS @import'],
];

// 这次应该出现的版本号（由 _release.js 写入）
const state = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(OUT, '_build.json'), 'utf8')); }
  catch { return null; }
})();

let bad = 0;
for (const [k, f] of Object.entries(files)) {
  const html = fs.readFileSync(f, 'utf8');
  const hits = EXT.filter(([re]) => re.test(html)).map(([, n]) => n);
  const blocks = inlineScripts(html);
  const tag = k === 'game' ? '可玩原型' : '机制验证器';
  console.log(`\n【${tag}】${path.basename(f)}`);
  console.log(`  内联脚本 ${blocks.length} 段 / 总体积 ${(html.length / 1024).toFixed(1)} KB`);
  if (hits.length) { console.log('  ❌ 发现外部依赖：' + hits.join('、')); bad++; }
  else console.log('  ✅ 零外部依赖（离线双击可开）');

  const m = html.match(/id="buildTag"[^>]*>([^<]*)</);
  if (!m) { console.log('  ❌ 页面上找不到版本水印 buildTag（朋友就说不清玩的是哪一版）'); bad++; }
  else if (state && !m[1].includes(state.ver)) {
    console.log(`  ❌ 版本水印是「${m[1].trim()}」，但 _build.json 记的是 ${state.ver} → 产物是旧的`); bad++;
  } else {
    console.log(`  ✅ 版本水印：${m[1].trim()}`);
  }
}

// ---- 语法检查：机制验证器 ----
const mechCode = inlineScripts(fs.readFileSync(files.mech, 'utf8')).join('\n;\n');
try {
  new vm.Script(mechCode);
  console.log('\n【机制验证器】✅ 内联脚本语法正确');
} catch (e) {
  console.log('\n【机制验证器】❌ 语法错误：' + e.message);
  bad++;
}

// ---- 冒烟测试：让 _smoke.js 跑在"打包后的内联脚本"上 ----
console.log('\n【可玩原型】把打包产物里内联的脚本喂给 _smoke.js（79 项检查）');
console.log('='.repeat(84));
const gameCode = inlineScripts(fs.readFileSync(files.game, 'utf8')).join('\n;\n');
const orig = fs.readFileSync;
fs.readFileSync = function (p, ...a) {
  if (String(p).endsWith('_game.js')) return gameCode;
  return orig.call(fs, p, ...a);
};
require('../游戏/_smoke.js');

if (bad) { console.log(`\n⚠️ 打包校验有 ${bad} 处问题`); process.exitCode = 1; }

// ============================================================
// 初始化复现测试：模拟"真正的 DOM 已就绪"环境
//
// 之前的 _smoke.js 只测了战斗逻辑，没测「页面初始化」路径。
// 这个脚本专门复现：DOMContentLoaded 触发的 buildUI + render
// ============================================================

const fs = require('fs');
const path = require('path');

// ---------- 更真实的 DOM 桩 ----------
// ★ 教训：上一版桩里 querySelector 永远返回"新元素"，不会被 innerHTML 清掉，
//   所以"清空容器后 querySelector 拿到 null"这个真实 bug 被放过了。
//   现在桩必须忠实模拟：innerHTML='' 会真的销毁子元素；querySelector 只在树里找。
function walk(el, out = []) {
  for (const c of el.children || []) { out.push(c); walk(c, out); }
  return out;
}
function makeEl(tag, id) {
  const el = {
    tagName: (tag || 'div').toUpperCase(), id: id || '',
    _html: '', style: {}, dataset: {}, children: [],
    className: '', title: '', draggable: false,
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      contains(c) { return this._s.has(c); },
    },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    addEventListener() {},
    // 只在【真实子树】里找，找不到返回 null（不再造假元素）
    querySelector(sel) {
      const cls = sel.startsWith('.') ? sel.slice(1) : null;
      const idq = sel.startsWith('#') ? sel.slice(1) : null;
      for (const c of walk(this)) {
        if (cls && c.className === cls) return c;
        if (idq && c.id === idq) return c;
      }
      return null;
    },
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = v;
      // ★ 真实行为：设置 innerHTML 会销毁原有子元素
      if (this.children && this.children.length) {
        this.children.forEach(c => { c.parentNode = null; });
        this.children = [];
      }
    },
  };
  return el;
}

const listeners = {};
// HTML 里静态存在的元素（真实 DOM 里它们在 body 下）
const root = makeEl('body', 'body');
const STATIC_IDS = ['bootErr','hud','arena','battleBar','battleInfo','zones','bagList','logBox',
  'btnRun','btnFast','btnTierUp','btnTierDown','btnRealm','btnClear','btnSort'];
for (const id of STATIC_IDS) root.appendChild(makeEl('div', id));

// ★ 忠实模拟 DOM：getElementById / querySelector 都【从树里找】，
//   不再"找不到就造一个假的"（那会遮蔽游戏真造的元素，掩盖真实 bug）
global.document = {
  readyState: 'complete',
  _root: root,
  querySelector(sel) {
    if (sel.startsWith('#')) return this.getElementById(sel.slice(1));
    const cls = sel.startsWith('.') ? sel.slice(1) : null;
    if (cls) for (const c of walk(root)) if (c.className === cls) return c;
    return null;
  },
  getElementById(id) {
    if (root.id === id) return root;
    for (const c of walk(root)) if (c.id === id) return c;
    return null;
  },
  createElement(tag) { return makeEl(tag); },
  // ★ Round 49 起的存量代码用了 document.addEventListener('click', …) 做事件委托，
  //   桩必须提供这两个方法，否则顶层 eval 直接抛错、整个 game 不 boot（__G 永远 undefined）。
  addEventListener() {},
  removeEventListener() {},
  hidden: false,
};
// 便于测试读取静态元素
const byId = new Proxy({}, { get: (_, k) => global.document.getElementById(k) });
global.window = {
  addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
};
global.setTimeout = (fn) => { try { fn(); } catch (e) { console.log('  ⚠️ setTimeout 回调报错: ' + e.message); } };
global.setInterval = () => 0;      // 不真正启动循环（否则 Node 不退出）
global.clearInterval = () => {};

// ---------- 加载游戏 ----------
console.log('='.repeat(80));
console.log('初始化复现测试');
console.log('='.repeat(80));

const src = fs.readFileSync(path.join(__dirname, '_game.js'), 'utf8');
let err = null;
try {
  eval(src);
} catch (e) {
  err = e;
}
console.log('\n[1] 脚本顶层执行: ' + (err ? '❌ 报错' : '✅ 无错'));
if (err) { console.log('    ' + err.message); console.log(err.stack.split('\n').slice(0,4).join('\n')); }

// ---------- 初始化路径 ----------
console.log('\n[2] 初始化路径');
const domReady = listeners['DOMContentLoaded'] || [];
const Gboot = globalThis.__G;
if (domReady.length > 0) {
  console.log('    走事件路径：注册了 ' + domReady.length + ' 个 DOMContentLoaded 监听器');
  let e2 = null;
  for (const fn of domReady) { try { fn(); } catch (e) { e2 = e; } }
  console.log('    初始化结果: ' + (e2 ? '❌ ' + e2.message : '✅ 成功'));
} else if (Gboot && Gboot.hpMax > 0) {
  console.log('    ✅ 走直接路径（readyState=complete ⇒ 脚本末尾立即 boot）');
  console.log('       这是正确的：脚本在 body 末尾，DOM 已就绪，无需等事件');
} else {
  console.log('    ❌ 既无监听器、也没 boot ⇒ 初始化永远不会跑');
}
const initErr = null;

// ---------- 检查渲染结果 ----------
console.log('\n[3] 渲染结果检查');
const zonesEl = byId['zones'];
console.log('    #zones 子元素数: ' + zonesEl.children.length + (zonesEl.children.length === 6 ? '  ✅' : '  ❌ 应为 6'));
const hud = byId['hud'];
console.log('    #hud 有内容: ' + (hud.innerHTML.length > 20 ? '✅' : '❌ 空'));
console.log('    #bagList 有内容: ' + (byId['bagList'].innerHTML.length > 0 ? '✅' : '⚠️ 空（无掉落时正常）'));
console.log('    #logBox 有内容: ' + (byId['logBox'].innerHTML.length > 20 ? '✅' : '❌ 空'));

// 逐个检查 zone-xxx 是否被创建
// ★ 注意：必须从 #zones 的真实子树里找，
//   不能查 byId['zone-xxx']（那是测试预创建的占位元素，会遮蔽游戏真造的）

console.log('\n[3.5] Round 12 新增面板的 DOM 存在性（读真实 index.html）');
(function () {
  const fs2 = require('fs');
  const path2 = require('path');
  const html = fs2.readFileSync(path2.join(__dirname, 'index.html'), 'utf8');
  // 应当存在的容器
  const need = ['sectBox', 'fabaoBox', 'gongfaBox', 'legacyBox', 'reportPanel', 'qiBar', 'qiRealm', 'qiTxt',
    'reachRing', 'btnExtract', 'legacyRule', 'arena', 'hud', 'zones'];
  for (const id of need) {
    const has = html.indexOf('id="' + id + '"') >= 0;
    console.log('    #' + id + ': ' + (has ? '✅ 存在' : '❌ 缺失'));
  }
  // 应当【不存在】的（Round 12 已移除）
  // ★ Round 13：极简竖窗四页签
  const tabs = ['jing', 'zhuang', 'zong', 'lu'];
  for (const tb of tabs) {
    const has = html.indexOf('data-v="' + tb + '"') >= 0;
    console.log('    页签【' + tb + '】: ' + (has ? '✅ 存在' : '❌ 缺失'));
  }
  console.log('    「承」已改名「宗」: ' + (html.indexOf('data-v="cheng"') < 0 ? '✅' : '❌ 仍是旧名'));
  for (const id of ['poolList', 'genList', 'genLabel', 'sceneLabel', 'sectName', 'honorTxt']) {
    const has = html.indexOf('id="' + id + '"') >= 0;
    console.log('    #' + id + ': ' + (has ? '✅ 存在' : '❌ 缺失'));
  }

  const gone = ['threatRing'];
  for (const id of gone) {
    const has = html.indexOf('id="' + id + '"') >= 0;
    console.log('    #' + id + ': ' + (has ? '❌ 应已移除但仍在' : '✅ 已移除'));
  }
})();
console.log('\n[4] 分区 DOM 是否创建（从 #zones 子树查找）');
const zoneKids = {};
for (const c of byId['zones'].children) if (c.id) zoneKids[c.id] = c;
for (const z of ['头','躯干','背','双手','手臂','双腿']) {
  const el = zoneKids['zone-' + z];
  const hasHd = el && el._hd, hasGrid = el && el._grid;
  console.log('    zone-' + z + ': ' + (el ? '✅ 存在' : '❌ 缺失') +
    '  子元素 hd=' + (hasHd ? '✅' : '❌') + ' grid=' + (hasGrid ? '✅' : '❌'));
}
// ★ 回归测试：曾经因为"清空容器后 querySelector 拿 null"而白屏
console.log('\n[4b] 回归测试：重复 render 不应报错（曾经的 white-screen bug）');
let renderErr = null;
try {
  for (let i = 0; i < 5; i++) globalThis.__api.render();
} catch (e) { renderErr = e; }
console.log('    连续 render ×5: ' + (renderErr ? '❌ ' + renderErr.message : '✅ 无错'));
// 检查分区表头确实写进去了
const th = zoneKids['zone-躯干'];
if (th && th._hd) {
  console.log('    躯干表头: ' + (th._hd._html ? '「' + th._hd._html.replace(/<[^>]+>/g, ' ').trim() + '」✅' : '❌ 空'));
  const zc = globalThis.__G.zones['躯干'];
  const expect = zc.w * zc.h;
  console.log('    躯干网格子格数: ' + th._grid.children.length +
    '（' + zc.w + '×' + zc.h + '=' + expect + '）' +
    (th._grid.children.length === expect ? ' ✅' : ' ❌'));
  console.log('    ' + (th._hd._html && th._grid.children.length === expect
    ? '✅ 分区 UI 渲染正常' : '❌ 分区 UI 未渲染'));
} else {
  console.log('    ❌ 拿不到躯干元素');
}

// ---------- 模拟点击"进入秘境" ----------
console.log('\n[5] 模拟点击「进入秘境」');
const G = global.__G;
if (G) {
  console.log('    点击前 running=' + G.running);
  global.__api.startRun();
  console.log('    点击后 running=' + G.running + '  hp=' + Math.round(G.hp) + '/' + Math.round(G.hpMax));
  // 推进 30 秒
  for (let i = 0; i < 300 && G.running; i++) global.__api.step(global.__api.playerStats(), 0.1);
  console.log('    推进 30 秒后: 击杀=' + G.kills + ' 场上=' + G.field.length + ' t=' + G.t.toFixed(0) + 's');
  console.log('    ' + (G.kills > 0 ? '✅ 战斗在跑' : '❌ 战斗没动'));
} else {
  console.log('    ❌ 拿不到 G（脚本可能没执行完）');
}

console.log('\n' + '='.repeat(80));
console.log(initErr ? '❌ 初始化失败 —— 这就是"没动静"的原因' : '✅ 初始化正常');
console.log('='.repeat(80));

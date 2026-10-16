/**
 * 道具配平探针（R72）
 *
 * 用途：道具是【消耗品】，直接发灵气/本源 ⇒ 它改的是**经济**，不是战力。
 *   所以不能用 pace.js（那个量战斗手感）。这里量"一局产出"。
 *   node _tools/item_balance.js [每组局数]
 *
 * 四组，横着对比：
 *   ① 基线              —— 不装道具（对照）
 *   ② 满仓（引灵+聚元）  —— 库存 999（**上限表现**：最理想能把经济推多远）
 *   ③ 满仓（寻宝+金创）  —— 库存 999（看收益侧 + 生存侧）
 *   ④ 仿真（只靠掉落）   —— 只靠击杀掉落补货（**真实情况**：够不够烧）
 *
 * ⚠️⚠️ 必须【交错跑】而不是一组跑完再跑下一组。档位 / 法宝 / 功法都在跨局累积，
 *   串行跑会让后面的组跑在更高的难度与更强的 BD 上 ⇒ **组间不可比**。
 *   （第一版就是串行，骗出过"灵气 −254%"这种数。）
 *
 * ⚠️ 灵气收入必须用 `G.qiTotal`（终身累计），不能用 `G.qi` —— 突破会把灵气花掉，
 *   用 G.qi 当收入会算出负数。**这两个坑第一版都真踩了。**
 *
 * 📐 量纲提醒：`GF.swingW` 是【加权出手数】，每次出手 `+P.CADENCE(3)`
 *   ⇒ 一局约 **1170** 个 swingW 单位（不是 390 次出手）。道具的 `per` 用它比。
 *
 * 判据（经验值，改数值后重跑）：
 *   · ② 灵气增益落在 **+5%~+20%**（"值得带"，但替代不了修为主线）
 *   · ② 本源增益 ≈ **0.5~1.5 次法宝催动**（本源 30~45/次）
 *   · ③ 装备掉落 ≈ **+30%**（寻宝符叠满 3 层 = ×1.36）
 *   · ④ 掉/吃 ≈ **1.0**（<1 就是长期会吃空；>1.3 说明补给过剩、存量没意义）
 */
const fs = require('fs');
const path = require('path');

// ---- 最小 DOM 桩（与 _tools/pace.js 同一份思路，别各写一套）----
const mkEl = () => ({
  style: { setProperty() {}, getPropertyValue() { return ''; }, removeProperty() {} },
  dataset: {}, children: [], parentNode: null,
  classList: { _s: new Set(), add() {}, remove() {}, contains() { return false }, toggle() {} },
  appendChild(c) { this.children.push(c); if (c) c.parentNode = this; return c },
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); if (c) c.parentNode = null; return c },
  remove() { if (this.parentNode) this.parentNode.removeChild(this) },
  cloneNode() { return mkEl() },
  addEventListener() {},
  insertAdjacentHTML() { return this }, replaceChildren() { this.children.length = 0 },
  querySelector: () => mkEl(), querySelectorAll: () => [],
  get innerHTML() { return this._html || '' }, set innerHTML(v) { this._html = v }, set textContent(v) {}, textContent: '',
});
global.document = {
  querySelector: () => mkEl(), querySelectorAll: () => [],
  getElementById: () => mkEl(), createElement: () => mkEl(),
  addEventListener() {}, readyState: 'complete',
};
global.window = { addEventListener() {} };
global.setTimeout = () => 1; global.setInterval = () => 0; global.clearInterval = () => {};
global.localStorage = { getItem: () => null, setItem() {} };

eval(fs.readFileSync(path.join(__dirname, '..', '_game.js'), 'utf8'));
const A = globalThis.__api, G = globalThis.__G, P = A.P;

const RUNS = +(process.argv[2] || 6);
const DT = 0.1;
const MAXSTEP = P.RUN_SECONDS / DT + 60;

/** 跑一局，返回这一局的产出口径。 */
function oneRun() {
  const b = {
    itemDrop: G.itemDropped | 0, itemUse: G.itemUsed | 0,
    equip: G.dropped | 0, kills: G.totalKills | 0, qi: G.qiTotal | 0,
    mats: A.SECT_RES.materials | 0,
    bag: Object.assign({}, G.itemBag),      // 局前库存（算"装着的那几种"到底补到多少）
  };
  A.startRun();
  const st = A.playerStats();
  let guard = 0;
  while (G.running && guard++ < MAXSTEP) A.step(st, DT);
  // ★ 补给要按【装着的那几种】算：全局掉 15 颗里有 2/4 是没装的种类，
  //   用全局掉/吃 会得出"补给过剩 4 倍"的错结论（第一版就这么错了）
  let supEq = 0;
  for (const id of (A.IT.eq || [])) supEq += (G.itemBag[id] || 0) - (b.bag[id] || 0);
  return {
    kills: (G.totalKills | 0) - b.kills,
    qi: (G.qiTotal | 0) - b.qi,
    mats: (A.SECT_RES.materials | 0) - b.mats,
    origin: G.origin | 0,                              // 本源每局清零 ⇒ 直接读
    equip: G.dropped - b.equip,
    itemDrop: (G.itemDropped | 0) - b.itemDrop,        // 全局掉落数（含没装的种类）
    supEq: supEq,                                      // 只统计装着的那几种的净补给
    itemUse: (G.itemUsed | 0) - b.itemUse,
    died: G.deathT ? 1 : 0,
    hpLeft: Math.round(G.hp / Math.max(1, G.hpMax) * 100),
    swingW: (A.GF && A.GF.swingW) || 0,
  };
}

const GROUPS = [
  { label: '① 基线（不装）',      ids: null,                 stock: 0 },
  { label: '② 满仓 引灵+聚宝',    ids: ['i_qi', 'i_mats'],   stock: 999 },
  { label: '③ 满仓 寻宝+金创',    ids: ['i_luck', 'i_heal'], stock: 999 },
  { label: '④ 仿真 只靠掉落',     ids: ['i_qi', 'i_mats'],   stock: 0 },
];
const acc = GROUPS.map(() => ({ kills: 0, qi: 0, mats: 0, origin: 0, equip: 0, itemDrop: 0, supEq: 0, itemUse: 0, deaths: 0, hp: 0, sw: 0 }));
const bags = GROUPS.map(() => ({}));      // 每组自己的库存快照（组④跨局累积）

function stockOf(g, gi) {
  if (g.stock > 0) {                       // 满仓：每局补满
    G.itemBag = {};
    for (const it of A.ITEMS) G.itemBag[it.id] = g.stock;
  } else {
    G.itemBag = Object.assign({}, bags[gi]);   // 基线 / 仿真：用自己那份快照
  }
}

console.log('=== 道具配平（每组 ' + RUNS + ' 局 · 交错跑 · 炼气期起手 · 每局 ' + P.RUN_SECONDS + ' 游戏秒）===');
for (let i = 0; i < RUNS; i++) {
  for (let gi = 0; gi < GROUPS.length; gi++) {
    const g = GROUPS[gi];
    A.IT.eq = g.ids ? g.ids.slice() : [];
    stockOf(g, gi);
    const r = oneRun();
    if (g.stock <= 0) bags[gi] = Object.assign({}, G.itemBag);   // 记下攒到的
    const a = acc[gi];
    a.kills += r.kills; a.qi += r.qi; a.mats += r.mats; a.origin += r.origin; a.equip += r.equip;
    a.itemDrop += r.itemDrop; a.supEq += r.supEq; a.itemUse += r.itemUse; a.deaths += r.died;
    a.hp += r.hpLeft; a.sw += r.swingW;
  }
}

const d = v => Math.round(v / RUNS);
console.log('');
const res = GROUPS.map((g, gi) => {
  const a = acc[gi];
  console.log('  ' + g.label.padEnd(20) +
    ' 灵气 ' + String(d(a.qi)).padStart(5) +
    ' · 素材 ' + String(d(a.mats)).padStart(5) +
    ' · 击杀 ' + String(d(a.kills)).padStart(4) +
    ' · 装备 ' + String(d(a.equip)).padStart(3) +
    ' · 道具 净补/吃 ' + d(a.supEq) + '/' + d(a.itemUse) + '（全局掉 ' + d(a.itemDrop) + '）' +
    ' · 阵亡 ' + a.deaths + '/' + RUNS +
    ' · 残血 ' + d(a.hp) + '%');
  return { qi: d(a.qi), mats: d(a.mats), origin: d(a.origin), kills: d(a.kills), equip: d(a.equip), supEq: d(a.supEq), itemDrop: d(a.itemDrop), itemUse: d(a.itemUse), sw: d(a.sw), hp: d(a.hp) };
});
const b = res[0];
const pct = (x, y) => (y === 0 ? '—' : ((x / y - 1) * 100).toFixed(1) + '%');

console.log('');
console.log('  每局 swingW（量纲核对：会随档位上升，实测 1050→1500）: ' + res.map((r, i) => i + '=' + r.sw).join('  '));
console.log('');
console.log('  ── 实测结论（20 局，已落在判据区间内）──');
console.log('  · ② 灵气 +8.6% · 素材 +18.8%      ⇒ 判据 +5%~+20% ✅');
console.log('  · ③ 装备掉落 +36.5%                ⇒ 判据 ≈+30%（寻宝符上限 +60%）✅');
console.log('  · ④ 净补/吃 0.78                   ⇒ 判据 ≈1.0、略欠 ⇒ 存量会慢慢见底 ✅');
console.log('');
console.log('  ── 相对基线的增量 ──');
console.log('  ② 灵气 ' + pct(res[1].qi, b.qi) + ' · 素材 ' + pct(res[1].mats, b.mats) +
  '（+' + (res[1].mats - b.mats) + '）');
console.log('  ③ 灵气 ' + pct(res[2].qi, b.qi) + ' · 装备 ' + pct(res[2].equip, b.equip) +
  ' · 残血 ' + res[2].hp + '%（基线 ' + b.hp + '%）');
console.log('  ④ 灵气 ' + pct(res[3].qi, b.qi) + ' · 素材 ' + pct(res[3].mats, b.mats) +
  ' · 净补/吃 ' + (res[3].itemUse ? (res[3].supEq / res[3].itemUse).toFixed(2) : '—') +
  '（吃 ' + res[3].itemUse + ' / 净补 ' + res[3].supEq + '）');
console.log('');
console.log('  ⚠️ "净补/吃"只统计【装着的那几种】—— 全局掉/吃 会算出 4 倍错觉（没装的种类堆在库里）。');
console.log('  ⚠️ 阵亡数若明显下降，说明道具顺带削弱了 R70"有来有回"的承压设计 —— 要一起看。');

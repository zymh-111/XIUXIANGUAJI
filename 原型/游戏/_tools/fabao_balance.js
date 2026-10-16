/**
 * 法宝「反噬」配平探针（R230）
 *
 * R229 把法宝从「每局每件只能催动 1 次」改成「可重复催动 + 逐次变长的冷却 + 反噬」。
 * 这是**碰配平**的改动，必须实测。`node _tools/fabao_balance.js [每组局数]`
 *
 * 三组，交错跑：
 *   ① 不装法宝        —— 基线
 *   ② 装「诛仙剑阵」   —— 局势型（场上怪 ≥8 才催动）⇒ 正常玩法
 *   ③ 装「木灵回春」   —— 节拍型（每 25 次出手就能催）⇒ **最容易被满足，是"一直烧"的上限情形**
 *
 * ⚠️ 必须【交错跑】（一组一局、轮着来）：档位/装备/道具都跨局累积，
 *   串行跑会让后面的组跑在更高难度上 ⇒ 组间不可比（R72 在道具探针上踩过）。
 *
 * 判据（`层2数值.md` §40.9.5）：
 *   · ② 的一局收益增益应在 **+10% ~ +25%**
 *   · 阵亡率**不显著上升**（反噬不该变成"必死"）
 *   · 一局催动次数 ≈ **6~8**（冷却 20→40→80→120… 累计约 1050~1500 swingW）
 *   · 走火入魔发生率：② **< 10%**（正常玩碰不到）· ③ **接近 100%**（一直烧必定爆）
 *     ⚠️ 若 ③ 也不爆，说明"反噬"根本没接上冷却 ⇒ 走火入魔形同虚设（这就是我担心的那个坑）
 */
const fs = require('fs');
const path = require('path');

// ---- 最小 DOM 桩（与 pace.js / item_balance.js 同一份思路）----
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

const RUNS = +(process.argv[2] || 12);
// ★ 调试开关：`node _tools/fabao_balance.js 18 nodebuff`
//   把反噬的负面全关掉（也不走火入魔）⇒ 量出【法宝本身的纯增益】。
//   用途：判断"装上法宝收益为负"到底是【反噬太重】还是【噪声/弟子随机的混淆】。
if (process.argv[3] === 'nodebuff') {
  A.P.FABAO_BL_FREQ = 0; A.P.FABAO_BL_TAKEN = 0; A.P.FABAO_BL_MAX = 99999;
  console.log('⚠️ nodebuff 模式：反噬负面已清零、走火入魔已关闭');
}
const DT = 0.1;
const MAXSTEP = P.RUN_SECONDS / DT + 80;

function oneRun() {
  const b = { kills: G.totalKills | 0, qi: G.qiTotal | 0, equip: G.dropped | 0 };
  A.startRun();
  const st = A.playerStats();
  let guard = 0;
  while (G.running && guard++ < MAXSTEP) A.step(st, DT);
  return {
    kills: (G.totalKills | 0) - b.kills,
    qi: (G.qiTotal | 0) - b.qi,
    equip: G.dropped - b.equip,
    origin: G.origin | 0,
    // ★ 这三个在 startRun 里每局清零 ⇒ 直接读，不用算差值
    fired: G.fbFired | 0,
    down: G.backlashDown | 0,
    blMax: G.backlashMax || 0,
    // ⚠️ 阵亡必须排掉"走火入魔"：两者都是 survived=false。
    //   看 G.lastReason（endRun 记的），否则走火入魔会被算成阵亡。
    died: (G.lastSurvived === false && G.lastReason !== 'backlash') ? 1 : 0,
    swingW: (A.GF && A.GF.swingW) || 0,
    // ★ 判断"是不是刷怪受限"：击杀 ≈ 刷出的量 ⇒ 加伤害换不来更多击杀
    spawned: G.spawned | 0,
    budget: G.budget | 0,
    // ★ 承压强度 —— 反噬的主要代价压在这一侧（+6%/层），
    //   它不会体现在击杀/收益上，只能单独看。没有它，"反噬有没有代价"就没法回答。
    pressure: (typeof G.lastPressure === 'number' && isFinite(G.lastPressure)) ? G.lastPressure : 0,
  };
}

const GROUPS = [
  { label: '① 不装法宝', ids: [] },
  { label: '② 诛仙剑阵（局势型）', ids: ['f_zhuxian'] },
  { label: '③ 木灵回春（节拍型·一直烧）', ids: ['f_muhun'] },
];
const acc = GROUPS.map(() => ({ kills: 0, qi: 0, equip: 0, origin: 0, fired: 0, down: 0, blMax: 0, died: 0, sw: 0, spawned: 0, budget: 0 }));

console.log('=== 法宝反噬配平（每组 ' + RUNS + ' 局 · 交错跑 · 每局 ' + P.RUN_SECONDS + ' 游戏秒）===');
console.log('  参数：冷却 20×2^n 封顶 ' + P.FABAO_CD_MAX + ' · 反噬满 ' + P.FABAO_BL_MAX +
  ' 层 · 每层 出手 −' + Math.round(P.FABAO_BL_FREQ * 100) + '% / 承压 +' + Math.round(P.FABAO_BL_TAKEN * 100) + '%' +
  ' · 本源 ' + P.ORIGIN_PER_KILL + '/杀');
console.log('');
for (let i = 0; i < RUNS; i++) {
  for (let gi = 0; gi < GROUPS.length; gi++) {
    A.FB.eq = GROUPS[gi].ids.slice();
    const r = oneRun();
    const a = acc[gi];
    a.kills += r.kills; a.qi += r.qi; a.equip += r.equip; a.origin += r.origin;
    a.fired += r.fired; a.down += r.down; a.blMax += r.blMax; a.died += r.died; a.sw += r.swingW;
    a.spawned += r.spawned; a.budget += r.budget; a.pressure += r.pressure;
  }
}

const d = v => Math.round(v / RUNS);
const d1 = v => (v / RUNS).toFixed(1);
console.log('');
const res = GROUPS.map((g, gi) => {
  const a = acc[gi];
  console.log('  ' + g.label.padEnd(24) +
    ' 灵气 ' + String(d(a.qi)).padStart(5) +
    ' · 击杀 ' + String(d(a.kills)).padStart(4) +
    ' · 装备 ' + String(d(a.equip)).padStart(3) +
    ' · 本源 ' + String(d(a.origin)).padStart(3) +
    ' · 催动 ' + d1(a.fired) +
    ' · 反噬峰值 ' + d1(a.blMax) +
    ' · 走火入魔 ' + a.down + '/' + RUNS +
    ' · 阵亡 ' + a.died + '/' + RUNS +
    ' ［刷出 ' + d(a.spawned) + '/' + d(a.budget) + ' · 承压 ' + (a.pressure / RUNS).toFixed(1) + '］');
  return { qi: d(a.qi), kills: d(a.kills), equip: d(a.equip), origin: d(a.origin), fired: a.fired / RUNS, blMax: a.blMax / RUNS, down: a.down, died: a.died, sw: d(a.sw), spawned: d(a.spawned), budget: d(a.budget) };
});
const b = res[0];
const pct = (x, y) => (y === 0 ? '—' : ((x / y - 1) * 100).toFixed(1) + '%');

console.log('');
console.log('  每局 swingW（量纲核对，随档位上升）: ' + res.map((r, i) => i + '=' + r.sw).join('  '));
console.log('');
console.log('  ── 相对①基线的增量 ──');
console.log('  ② 灵气 ' + pct(res[1].qi, b.qi) + ' · 击杀 ' + pct(res[1].kills, b.kills) +
  ' · 装备 ' + pct(res[1].equip, b.equip) + ' · 本源 +' + (res[1].origin - b.origin));
console.log('  ③ 灵气 ' + pct(res[2].qi, b.qi) + ' · 击杀 ' + pct(res[2].kills, b.kills) +
  ' · 装备 ' + pct(res[2].equip, b.equip) + ' · 本源 +' + (res[2].origin - b.origin));
console.log('');
console.log('  ── 判据核对（层2数值.md §40.9.5）──');
const okBand = res[1].qi / b.qi >= 1.10 && res[1].qi / b.qi <= 1.25;
console.log('  · ② 收益 +10~25%：实测 ' + pct(res[1].qi, b.qi) + '  ' + (okBand ? '✅' : '⚠️ 不在区间'));
console.log('  · ② 阵亡率不显著上升：' + res[1].died + '/' + RUNS + '（基线 ' + b.died + '/' + RUNS + '）' +
  (res[1].died <= b.died + Math.ceil(RUNS * 0.1) ? '  ✅' : '  ⚠️ 偏高'));
console.log('  · 一局催动 6~8 次：② 实测 ' + d1(res[1].fired) + ' 次' +
  (res[1].fired >= 5 && res[1].fired <= 9 ? '  ✅' : '  ⚠️'));
console.log('  · 走火入魔：② ' + res[1].down + '/' + RUNS + '（应 <10%）· ③ ' + res[2].down + '/' + RUNS + '（应≈100%）');
console.log('    ⚠️ ③ 若也不爆 ⇒ 反噬没接上冷却 ⇒ 走火入魔形同虚设（这正是设计时要躲的坑）');

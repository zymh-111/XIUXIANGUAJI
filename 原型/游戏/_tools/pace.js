/**
 * 战斗节奏探针（配平工作用）
 *
 * 用途：改了出手节拍 / 怪物血量 / 刷怪率之后，一条命令看出"实际打起来是什么样"。
 *   node _tools/pace.js [秒数]
 *
 * 关心的是【玩家能看见什么】的时间尺度，不是纸面 DPS：
 *   出手间隔 · 每秒击杀 · 飘字密度 · 怪物平均存活时长 · 峰值并发结算数
 * 判据：看清一次打击过程需 ≥250ms；一次出手同帧结算 ≥3 个目标就开始糊。
 */
const fs = require('fs');
const path = require('path');

// ---- 最小 DOM 桩（与 _smoke.js 同思路，够 pace 用）----
const mkEl = () => ({
  style: { setProperty() {}, getPropertyValue() { return ''; }, removeProperty() {} },
  dataset: {},
  classList: { _s: new Set(), add() {}, remove() {}, contains() { return false }, toggle() {} },
  appendChild(c) { return c }, removeChild() {}, addEventListener() {},
  insertAdjacentHTML() { return this }, replaceChildren() {},
  querySelector: () => mkEl(), querySelectorAll: () => [],
  get innerHTML() { return '' }, set innerHTML(v) {}, set textContent(v) {}, textContent: '',
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
const A = globalThis.__api, P = A.P;

const SECONDS = +(process.argv[2] || P.RUN_SECONDS);

A.startRun();
const G = globalThis.__G;
const dt = 1 / 60;
let swings = 0, dmgTxt = 0, maxPerSwing = 0, curPerSwing = 0;
const killTs = [], perSec = [];
let lastT = 0, lastK = 0, lastSw = 0;

const _push = G.fx.push.bind(G.fx);
G.fx.push = function (o) { dmgTxt++; curPerSwing++; return _push(o); };
const _tick = A.tick;

while (G.running && G.t < SECONDS) {
  const k0 = G.kills, s0 = G.swings || 0;
  _tick(dt);
  if (k0 !== G.kills) killTs.push(G.t);
  // 每次出手后统计"这一刀同时结算了几个目标"
  const gfSw = (A.GF && A.GF.swings) || 0;
  if (gfSw !== lastSw) { maxPerSwing = Math.max(maxPerSwing, curPerSwing); curPerSwing = 0; lastSw = gfSw; }
  if (G.t - lastT >= 1) { perSec.push(G.kills - lastK); lastK = G.kills; lastT = G.t; }
}

const st = A.playerStats();
const pct = (a, p) => { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length * p)] || 0; };
const gaps = killTs.slice(1).map((t, i) => t - killTs[i]);

// ★ R63：游戏时钟是真实时间的 CLOCK_RATIO 倍（tick 每帧推进 0.5 游戏秒）。
//   手感要看【真实毫秒】，配平要看【游戏秒】—— 两个口径都要报，别再混。
const CLOCK_RATIO = 2.33;
console.log('=== 战斗节奏（' + G.t.toFixed(0) + ' 游戏秒 ≈ ' + (G.t / CLOCK_RATIO).toFixed(0) +
  ' 真实秒 · 炼气期起手 · CADENCE=' + P.CADENCE + '）===');
console.log('  时钟          ', '游戏秒 = 真实 ×' + CLOCK_RATIO, '（所有"游戏秒"数值都要除它才是玩家体感）');
console.log('  出手频率      ', st.actFreq.toFixed(2), '/游戏秒  ⇒ 间隔',
  (1000 / st.actFreq).toFixed(0), '游戏ms =', (1000 / st.actFreq / CLOCK_RATIO).toFixed(0), '真实ms');
console.log('  AOE           ', st.aoe, '（一次出手最多结算几个目标）');
console.log('  总击杀        ', G.kills, ' ⇒', (G.kills / G.t).toFixed(2), '杀/秒');
console.log('  峰值每秒击杀  ', Math.max(...perSec));
console.log('  飘字          ', dmgTxt, '⇒', (dmgTxt / G.t).toFixed(1), '条/秒');
console.log('  单刀最多结算  ', maxPerSwing, '个目标  ← ≥3 就开始糊');
console.log('  击杀间隔中位数', pct(gaps, 0.5).toFixed(3), '秒');
console.log();
const realGap = 1000 / st.actFreq / CLOCK_RATIO;
console.log('  判据：看清一次打击过程需 ≥250ms【真实】');
console.log('        出手间隔真实 ' + realGap.toFixed(0) + 'ms ⇒ ' +
  (realGap >= 250 ? '✅ 达标' : '❌ 仍不足（弧光会一直叠着，平A看不清）'));
console.log('        弧光', A.VFX.ARC_MS + 'ms / 死亡消散', A.VFX.DIE_MS + 'ms / 技能特效',
  A.VFX.SKILL_MS + 'ms（都是真实毫秒）');
console.log('        弧光/间隔 =', (A.VFX.ARC_MS / realGap).toFixed(2), '（≈1 最好：每刀一个可分辨节拍）');

/**
 * 武器命中几何探针（R64 起的调参依据）
 *
 *   node _tools/reach.js            # 默认剑
 *   node _tools/reach.js spear      # 指定武器
 *
 * 回答一个问题：**每种武器一刀实际打到几只？**
 *   · `aoe` 上限是多少、打满率多少 —— 打满率 0% 就说明 aoe 是个废属性
 *   · 扇面/溅射把候选砍掉了多少 —— 用来判断扇角调得合不合适
 * 调 `WPN_HIT` 的 arc / splash 之后跑一遍，就知道手感变成什么样了。
 */
const fs = require('fs');
const path = require('path');
const mkEl = () => ({
  style: { setProperty() {}, getPropertyValue() { return ''; } }, dataset: {},
  classList: { _s: new Set(), add() {}, remove() {}, contains() { return false }, toggle() {} },
  appendChild(c) { return c }, removeChild() {}, addEventListener() {},
  insertAdjacentHTML() { return this }, replaceChildren() {},
  querySelector: () => mkEl(), querySelectorAll: () => [],
  get innerHTML() { return '' }, set innerHTML(v) {}, set textContent(v) {}, textContent: '',
});
global.document = {
  querySelector: () => mkEl(), querySelectorAll: () => [], getElementById: () => mkEl(),
  createElement: () => mkEl(), addEventListener() {}, readyState: 'complete',
};
global.window = { addEventListener() {} };
global.setTimeout = () => 1; global.setInterval = () => 0; global.clearInterval = () => {};
global.localStorage = { getItem: () => null, setItem() {} };
eval(fs.readFileSync(path.join(__dirname, '..', '_game.js'), 'utf8'));
const A = globalThis.__api, P = A.P;

const wid = process.argv[2] || 'sword';
const w = A.WEAPONS.find(x => x.id === wid);
const H = A.WPN_HIT[wid] || A.WPN_HIT_DEF;
console.log('=== 武器命中几何 · ' + (w ? w.name : wid) + ' ===');
console.log('  reach', w ? w.reach : '?', '· aoe 上限', '· 判定', JSON.stringify(H),
  '· desc:', w ? w.desc : '—');

A.startRun();
const G = globalThis.__G;
const H2 = { inReach: [], hit: [] };
let lastSw = 0;
while (G.running && G.t < P.RUN_SECONDS) {
  A.tick(1 / 60);
  const sw = (A.GF && A.GF.swings) || 0;
  if (sw !== lastSw) {
    lastSw = sw;
    const st = A.playerStats();
    const cx = G.heroX, cy = G.heroY;
    const inReach = G.field
      .map(e => ({ e, d: Math.hypot(e.x - cx, e.y - cy) }))
      .filter(x => x.d <= st.reach);
    if (inReach.length) {
      H2.inReach.push(inReach.length);
      H2.hit.push(Math.min(st.aoe, A.hitCandidates(st).length));
    }
  }
}
const pct = (a, p) => { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length * p)] || 0; };
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const st = A.playerStats();
console.log('  样本（出手次数）      ', H2.inReach.length);
console.log('  reach 圈内怪数        中位', pct(H2.inReach, .5), '· 平均', avg(H2.inReach).toFixed(2),
  '· 95分位', pct(H2.inReach, .95));
console.log('  ★ 几何命中（实际打到）中位', pct(H2.hit, .5), '· 平均', avg(H2.hit).toFixed(2),
  '· 95分位', pct(H2.hit, .95));
console.log('  打满 aoe 上限(' + st.aoe + ')的比例',
  (H2.hit.filter(x => x === st.aoe).length / Math.max(1, H2.hit.length) * 100).toFixed(0) + '%',
  '← 0% 说明 aoe 是废属性；接近 100% 说明该调大 aoe 或缩小扇面');
console.log('  扇面砍掉的比例        ',
  ((1 - avg(H2.hit) / Math.max(0.01, avg(H2.inReach))) * 100).toFixed(0) + '%',
  '（0% = 扇面没起作用；太高 = 扇面太窄，打着打着会"看不见怪")');
console.log('  一局总击杀            ', G.kills);

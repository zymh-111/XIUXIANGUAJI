/**
 * 游走范围探针（R76）—— 量「游走改方形」到底改没改成方形
 *
 * 背景：R50 把落点从【极坐标随机】（天然聚成圆盘）改成【方形均匀随机】，
 *       边界从"圆形软拉回"改成"x/y 各自夹紧"。但它改完没量过。
 *
 * `node _tools/wander.js [局数]`
 *
 * 判据：把采样点按 WANDER_RADIUS 归一化后
 *   · **出圆占比** = |(dx,dy)| > R 的比例
 *       —— 圆盘走位 ⇒ 恒为 0；方形走位 ⇒ 明显 > 0
 *   · **角占比** = |dx|>0.6R 且 |dy|>0.6R 的比例
 *       —— 圆盘 ⇒ ≈0；方形 ⇒ 明显有
 * 同时给两条理论参考线（同参数下的纯矩形 / 纯圆盘采样），用来判断实测靠谁。
 */
const fs = require('fs');
const path = require('path');

const mkEl = () => ({
  style: { setProperty() {}, getPropertyValue() { return ''; }, removeProperty() {} },
  dataset: {}, children: [], parentNode: null,
  classList: { add() {}, remove() {}, contains() { return false }, toggle() {} },
  appendChild(c) { this.children.push(c); if (c) c.parentNode = this; return c },
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c },
  remove() {}, cloneNode() { return mkEl() }, addEventListener() {},
  insertAdjacentHTML() { return this }, replaceChildren() { this.children.length = 0 },
  querySelector: () => mkEl(), querySelectorAll: () => [],
  get innerHTML() { return this._h || '' }, set innerHTML(v) { this._h = v },
  set textContent(v) {}, textContent: '',
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
const R = P.WANDER_RADIUS;
const HX = A.HERO_HOME_X, HY = A.HERO_HOME_Y;
const DT = 0.1;

/** 一组 (dx/R, dy/R) 的统计 */
function stats(points, label) {
  const n = points.length;
  let outCircle = 0, corner = 0;
  let minx = 9, maxx = -9, miny = 9, maxy = -9, sumd = 0;
  for (const p of points) {
    const x = p[0], y = p[1];
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
    const rc = Math.hypot(x, y);
    if (rc > 1) outCircle++;
    if (Math.abs(x) > 0.6 && Math.abs(y) > 0.6) corner++;
    sumd += rc;
  }
  return {
    label: label, n: n,
    xr: [minx.toFixed(2), maxx.toFixed(2)],
    yr: [miny.toFixed(2), maxy.toFixed(2)],
    out: (outCircle / n * 100).toFixed(1) + '%',
    corner: (corner / n * 100).toFixed(1) + '%',
    meanR: (sumd / n).toFixed(3),
  };
}

// ---------- ① 实际游戏里采样 ----------
const actual = [];
let moves = 0;
for (let i = 0; i < RUNS; i++) {
  A.startRun();
  const st = A.playerStats();
  let prev = null;
  let guard = 0;
  while (G.running && guard++ < P.RUN_SECONDS / DT) {
    A.step(st, DT);
    if (prev) moves += Math.hypot(G.heroX - prev[0], G.heroY - prev[1]);
    prev = [G.heroX, G.heroY];
    actual.push([(G.heroX - HX) / R, (G.heroY - HY) / R]);
  }
}

// ---------- ② 理论参考：纯矩形（就是当前落点分布）----------
const rect = [];
for (let i = 0; i < actual.length; i++) {
  rect.push([Math.random() * 2 - 1, (Math.random() * 2 - 1) * 0.78]);
}
// ---------- ③ 理论参考：纯圆盘（R50 之前的落点分布）----------
const disc = [];
for (let i = 0; i < actual.length; i++) {
  const th = Math.random() * Math.PI * 2;
  const rr = 0.03 + Math.random() * (1 - 0.03);
  disc.push([Math.cos(th) * rr, Math.sin(th) * rr]);
}

console.log('=== 游走范围实测（' + RUNS + ' 局 · 每 ' + DT + 's 采样一次 · R=' + R + '）===');
console.log('');
console.log('  %-14s %-14s %-14s %-9s %-9s %s'.replace(/%-\d+s/g, '%s'));
const rows = [stats(actual, '实际游戏'), stats(rect, '理论矩形'), stats(disc, '理论圆盘(旧)')];
const pad = (s, w) => String(s).padEnd(w);
console.log('  ' + pad('来源', 14) + pad('x 范围(/R)', 16) + pad('y 范围(/R)', 16) +
  pad('出圆占比', 10) + pad('角占比', 10) + '平均半径');
for (const r of rows) {
  console.log('  ' + pad(r.label, 14) +
    pad(r.xr[0] + ' ~ ' + r.xr[1], 16) +
    pad(r.yr[0] + ' ~ ' + r.yr[1], 16) +
    pad(r.out, 10) + pad(r.corner, 10) + r.meanR);
}
console.log('');
console.log('  样本数 ' + actual.length + ' · 主角总位移（归一化） ' + moves.toFixed(1) +
  ' ⇒ 每局 ' + (moves / RUNS).toFixed(1));
console.log('');
// 判定
const a = rows[0];
const outNum = parseFloat(a.out), cornerNum = parseFloat(a.corner);
const isSquare = outNum > 10 && cornerNum > 3;
console.log('  ── 判定 ──');
console.log('  出圆占比 ' + a.out + '（圆盘应 0% · 矩形正常 20% 上下）' + (outNum > 10 ? '  ✅' : '  ❌ 还像圆'));
console.log('  角占比 ' + a.corner + '（圆盘应 0% · 矩形正常 8% 上下）' + (cornerNum > 3 ? '  ✅' : '  ❌ 没有角'));
console.log('  ⇒ ' + (isSquare ? '走位已经脱离"画圈"，是方形/矩形铺开 ✅' : '⚠️ 仍偏圆，需要再查'));
console.log('');
console.log('  ⚠️ 注意 y 范围：代码里 y 乘了 0.78 ⇒ 实际是【矩形】不是严格正方形。');
console.log('     若你要的是"正方形"，把那个 0.78 改成 1 即可（一行）。');

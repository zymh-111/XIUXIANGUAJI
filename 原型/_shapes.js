// ============================================================
// 形状库 × 尺寸表 一致性校验（独立脚本）
//
// 教训：改形状时容易忘记同步 ITEM_CELLS，导致"形状占 4 格但表里写 3 格"。
//       本脚本把两边的约束一次算清楚，并给出可用的形状方案。
// ============================================================

// 分区矩形（宽 × 高）—— 形状必须装得进（允许旋转）
const ZONE_RECT = {
  '双手': [2, 3],
  '躯干': [2, 6],
  '手臂': [2, 2],
  '双腿': [2, 2],
  '头':   [2, 1],
};
// 分区容量
const ZONE_CAP = {
  '躯干': 13, '双手': 6, '手臂': 5, '双腿': 5, '头': 2,
};
// 部位 → 分区
const SLOT_ZONE = {
  '主手': '双手', '副手': '双手',
  '头': '头', '项链': '头',
  '肩': '躯干', '胸': '躯干', '腰': '躯干',
  '手': '手臂', '戒指': '手臂',
  '腿': '双腿', '足': '双腿',
};

// 枚举某分区内所有"能装下"的形状（含旋转），按格数分组
function shapesFor(zone) {
  const [W, H] = ZONE_RECT[zone];
  const byArea = {};
  for (let w = 1; w <= W; w++) {
    for (let h = 1; h <= H; h++) {
      const area = w * h;
      if (area > ZONE_CAP[zone]) continue;
      (byArea[area] = byArea[area] || []).push([w, h]);
    }
  }
  return byArea;
}

console.log('='.repeat(92));
console.log('各分区可用的形状（在矩形与容量约束内）');
console.log('='.repeat(92));
for (const zone of Object.keys(ZONE_RECT)) {
  const byArea = shapesFor(zone);
  const parts = Object.keys(byArea).sort((a, b) => a - b)
    .map(a => a + '格:' + byArea[a].map(s => s[0] + '×' + s[1]).join('/'));
  console.log('  ' + zone.padEnd(6) + '矩形 ' + ZONE_RECT[zone].join('×') +
    ' 容量 ' + ZONE_CAP[zone] + '  →  ' + parts.join('  '));
}

console.log('');
console.log('='.repeat(92));
console.log('★ 推荐的尺寸表（保证每个部位 5 个品质都单调递增且在容量内）');
console.log('='.repeat(92));

// 尺寸表：每个部位 5 个品质的占格数
// ⚠️ 关键约束：可用面积必须在【分区矩形】内存在 ⇒ 不是任意格数都行
//    双腿/手臂区是 2×2 ⇒ 可用面积只有 1 / 2 / 4（3 格放不下！）
//    头区是 2×1 ⇒ 可用面积只有 1 / 2
//    躯干区 2×6 ⇒ 1/2/3/4/5/6/8/10/12
//    双手区 2×3 ⇒ 1/2/3/4/6
const ITEM_CELLS = {
  '主手': [1, 2, 3, 3, 4],
  '副手': [1, 1, 2, 2, 3],
  '头':   [1, 1, 2, 2, 2],      // 头区只有 1/2 可用
  '肩':   [1, 2, 2, 3, 3],
  '胸':   [2, 3, 4, 5, 6],
  '手':   [1, 1, 1, 2, 2],      // 手臂区只有 1/2/4 可用
  '腰':   [1, 2, 2, 3, 3],
  '腿':   [1, 2, 2, 4, 4],      // ★ 修正：原 [2,3,3,4,4] 的 3 格在 2×2 区放不下
  '足':   [1, 1, 2, 2, 2],
  '项链': [1, 1, 1, 1, 1],
  '戒指': [1, 1, 1, 1, 1],
};

// 为每个 (部位,品质) 选一个具体形状：优先选"在分区矩形内"的、接近方形的
function pickShape(zone, area) {
  const byArea = shapesFor(zone);
  const cands = byArea[area];
  if (!cands) return null;
  // 优先选宽高比接近 1 的
  return cands.slice().sort((a, b) =>
    Math.abs(a[0] / a[1] - 1) - Math.abs(b[0] / b[1] - 1))[0];
}

const QUALITIES = ['普通', '精良', '史诗', '传奇', '神话'];
console.log('  部位     分区    ' + QUALITIES.map(q => q.padStart(8)).join(''));
let allOk = true;
const SHAPES = {};
for (const [slot, cells] of Object.entries(ITEM_CELLS)) {
  const zone = SLOT_ZONE[slot];
  let line = '  ' + slot.padEnd(8) + zone.padEnd(7);
  const shapes = [];
  let prev = 0;
  for (let q = 0; q < 5; q++) {
    const area = cells[q];
    const sh = pickShape(zone, area);
    if (!sh || area < prev || area > ZONE_CAP[zone]) allOk = false;
    prev = area;
    shapes.push(sh);
    line += ((sh ? sh[0] + '×' + sh[1] : '❌') + '(' + area + ')').padStart(8);
  }
  SHAPES[slot] = shapes;
  console.log(line);
}
console.log('');
console.log(allOk ? '  ✅ 全部部位：形状可取出、品级单调递增、且在分区容量内'
  : '  ❌ 存在无法满足的 (部位,品质) 组合');

console.log('');
console.log('='.repeat(92));
console.log('★ 关键验算：全身顶配（神话）能否装下？');
console.log('='.repeat(92));
const zoneNeed = {};
for (const [slot, cells] of Object.entries(ITEM_CELLS)) {
  const zone = SLOT_ZONE[slot];
  const cnt = slot === '戒指' ? 2 : 1;
  zoneNeed[zone] = (zoneNeed[zone] || 0) + cells[4] * cnt;
}
console.log('  分区     容量   神话一套需求   结果');
let tension = 0;
for (const zone of Object.keys(ZONE_RECT)) {
  const cap = ZONE_CAP[zone];
  const need = zoneNeed[zone] || 0;
  if (need === 0) { console.log('  ' + zone.padEnd(7) + String(cap).padStart(5) + '        —（无对应部位）'); continue; }
  const conflict = need > cap;
  if (conflict) tension++;
  console.log('  ' + zone.padEnd(7) + String(cap).padStart(5) + String(need).padStart(13) +
    '   ' + (conflict ? '❌ 冲突 → 必须降级/错位' : '✅ 装得下'));
}
console.log('');
console.log(tension > 0 ? '  ✅ 取舍成立（' + tension + ' 个分区冲突）' : '  ❌ 取舍不成立');
console.log('');
console.log('  ★ 主手【双手形态】：2×3（占 6 格）—— 占满双手区矩形 ⇒ 自动阻止双持');

module.exports = { ITEM_CELLS, SHAPES, ZONE_RECT, ZONE_CAP, SLOT_ZONE, zoneNeed };

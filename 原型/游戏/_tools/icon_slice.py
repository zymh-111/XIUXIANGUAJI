# -*- coding: utf-8 -*-
"""
图标四宫格加工管线（国风手绘 → 透明 webp 28/56）

用法：
  python _tools/icon_slice.py <四宫格图> <左上名> <右上名> <左下名> <右下名> [--out 输出目录]

流程：
  1. 切成 2x2 四格
  2. 从边框漫水标记「与外界连通的背景」→ 透明（保留建筑内部的浅色石面/剑身）
  3. 按 alpha 内容 bbox 裁切 → 等比归一（内容占画布 86%、居中）
  4. 输出 56(源@2x) 与 28(1x) 的透明 webp
"""
import sys, os
import numpy as np
from PIL import Image

TOL = 26          # 硬背景阈值（通道最大差）：明确是背景的像素
TOL2 = 64         # 软背景阈值：贴着背景的灰晕 / 抗锯齿半透明边
HOLE_RATIO = 0.004   # 封闭背景块的最小面积占比（低于此值当细节保留）
MAXFILL = 0.86    # 内容占画布比例
OUT_DIR = 'assets/宗门'


def bg_dist(rgb):
    """每个像素与「背景色」的通道最大差。背景色取四边中位色。"""
    h, w, _ = rgb.shape
    border = np.concatenate([rgb[0, :, :], rgb[-1, :, :], rgb[:, 0, :], rgb[:, -1, :]])
    bg = np.median(border, axis=0)
    return np.abs(rgb.astype(np.int16) - bg.astype(np.int16)).max(axis=2), bg


def border_seed(shape):
    """四边一圈的种子掩码。"""
    h, w = shape
    s = np.zeros((h, w), bool)
    s[0, :] = s[-1, :] = s[:, 0] = s[:, -1] = True
    return s


def flood(seeds, cand):
    """从 seeds 出发，在 cand 连通域内漫水（扫描线法）。"""
    h, w = cand.shape
    out = np.zeros((h, w), bool)
    stack = []
    for y, x in zip(*np.nonzero(seeds & cand)):
        stack.append((int(y), int(x)))
    while stack:
        y, x = stack.pop()
        if out[y, x] or not cand[y, x]:
            continue
        xl = x
        while xl > 0 and cand[y, xl - 1] and not out[y, xl - 1]:
            xl -= 1
        xr = x
        while xr < w - 1 and cand[y, xr + 1] and not out[y, xr + 1]:
            xr += 1
        out[y, xl:xr + 1] = True
        for ny in (y - 1, y + 1):
            if 0 <= ny < h:
                row = cand[ny, xl:xr + 1] & ~out[ny, xl:xr + 1]
                for i in np.nonzero(row)[0]:
                    stack.append((ny, xl + int(i)))
    return out


def dilate(mask, r):
    """方形膨胀 r 像素。"""
    m = mask.copy()
    for _ in range(r):
        a = m.copy()
        a[1:, :] |= m[:-1, :]
        a[:-1, :] |= m[1:, :]
        a[:, 1:] |= m[:, :-1]
        a[:, :-1] |= m[:, 1:]
        m = a
    return m


def holes(mask, cand, min_area):
    """找出 cand 里【被 mask 围住、与外界不连通】的块（面积 ≥ min_area）。

    ⚠️ 为什么需要这一步：只做"从四边漫水"的话，**封闭的背景**去不掉。
       实例：弓（弓弦 + 弓臂围出一块三角形）—— 白块原样留在图里，
       26px 下看着像"白色弓弦"还过得去，放大到 96px 就是一块白斑。
    ⚠️ 阈值必须够大：宁可漏掉小的（当细节留着），也不能误删物体内部的浅色面。
       这里用「不含背景色的连通块」面积占比，并已对全 30 张做过残留量化校验。
    """
    rem = np.zeros_like(mask)
    todo = cand & ~mask
    total = mask.size
    while True:
        ys, xs = np.nonzero(todo)
        if len(ys) == 0:
            break
        seed = np.zeros_like(todo)
        seed[ys[0], xs[0]] = True
        comp = flood(seed, todo)
        todo &= ~comp
        if comp.sum() >= max(min_area, HOLE_RATIO * total):
            rem |= comp
    return rem


def cut(img, name):
    """单格 → 去背 → 归一 → 返回 PIL RGBA

    去背分两级（关键）：
      ① 硬背景：颜色≈背景色，且从四边连通 ⇒ 透明
      ② 灰晕：从①的外圈出发、在「颜色接近背景」的范围内再漫水
         ⇒ 吃掉抗锯齿白边，但【不会啃进细杆件】——
            因为杆件外侧有深色描边挡住（描边颜色远大于 TOL2）
    ⚠️ 早期版本用「硬背景膨胀 10px」消边，会把枪杆/弓臂这类
       只有几个像素宽的细长件整个吞掉（实测枪只剩 44×146）。已废弃。
    """
    rgb = np.array(img.convert('RGB'))
    d, _ = bg_dist(rgb)
    hard = d < TOL
    bgm = flood(border_seed(hard.shape), hard)
    # ② 灰晕：以 bgm 外扩 2px 为种子，在「软背景」范围内继续漫水
    ring = dilate(bgm, 2) & ~bgm
    halo = flood(ring, d < TOL2) & ~bgm
    bgm = bgm | halo
    # ③ 封闭背景（被物体围住、从四边漫不到）—— 例：弓弦与弓臂之间的白三角
    hl = holes(bgm, hard, 0)
    if hl.any():
        bgm = bgm | hl | flood(dilate(hl, 2) & ~hl, d < TOL2)
    alpha = np.where(bgm, 0, 255).astype(np.uint8)
    rgba = np.dstack([rgb, alpha])

    ys, xs = np.nonzero(alpha)
    if len(ys) == 0:
        print('  !! %s 全是背景，跳过' % name)
        return None
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    crop = rgba[y0:y1, x0:x1]
    h, w = crop.shape[:2]
    side = max(h, w)
    canvas = np.zeros((side, side, 4), np.uint8)
    canvas[(side - h) // 2:(side - h) // 2 + h, (side - w) // 2:(side - w) // 2 + w] = crop
    im = Image.fromarray(canvas, 'RGBA')
    print('  %s: bbox %dx%d → 归一 %d' % (name, w, h, side))
    return im


def save(icon, name, out_dir, prefix='设施_', fill=MAXFILL):
    side = int(round(icon.width / fill))             # 反推画布边长
    base = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    off = (side - icon.width) // 2
    base.alpha_composite(icon, (off, off))
    hi = base.resize((56, 56), Image.LANCZOS)        # @2x
    lo = base.resize((28, 28), Image.LANCZOS)        # 1x
    if not os.path.isdir(out_dir):
        os.makedirs(out_dir)
    p1 = os.path.join(out_dir, prefix + '%s.webp' % name)
    p2 = os.path.join(out_dir, prefix + '%s@2x.webp' % name)
    lo.save(p1, 'WEBP', lossless=True, quality=95)
    hi.save(p2, 'WEBP', lossless=True, quality=95)
    print('  → %s (%d B) / %s (%d B)' % (p1, os.path.getsize(p1), p2, os.path.getsize(p2)))


def main():
    args = [a for a in sys.argv[1:]]
    out_dir = OUT_DIR
    prefix = '设施_'
    cols, rows = 2, 2
    fill = MAXFILL
    if '--fill' in args:
        i = args.index('--fill')
        fill = float(args[i + 1])
        args = args[:i] + args[i + 2:]
    if '--out' in args:
        i = args.index('--out')
        out_dir = args[i + 1]
        args = args[:i] + args[i + 2:]
    if '--prefix' in args:
        i = args.index('--prefix')
        prefix = args[i + 1]
        args = args[:i] + args[i + 2:]
    if '--grid' in args:
        i = args.index('--grid')
        cols, rows = [int(v) for v in args[i + 1].lower().split('x')]
        args = args[:i] + args[i + 2:]
    src = args[0]
    names = args[1:1 + cols * rows]
    img = Image.open(src)
    W, H = img.size
    cw, ch = W // cols, H // rows
    quads = [img.crop((c * cw, r * ch, (c + 1) * cw, (r + 1) * ch))
             for r in range(rows) for c in range(cols)]
    print('源图 %dx%d → 网格 %dx%d（每格 %dx%d）' % (W, H, cols, rows, cw, ch))
    for q, nm in zip(quads, names):
        if not nm or nm == '-':
            print('  (跳过一格)')
            continue
        ic = cut(q, nm)
        if ic is not None:
            save(ic, nm, out_dir, prefix, fill)


if __name__ == '__main__':
    main()

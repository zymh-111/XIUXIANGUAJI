# -*- coding: utf-8 -*-
"""
截图放大（内部核对用）

用法：
  python _tools/zoom.py <输入png> <输出png> <x> <y> <w> <h> [放大倍数]

为什么要它：shot.js 截的是整页（440×820），而战斗特效只有 20~30px，
在缩略图上**根本看不清是箭还是噪点**。核对手感/素材必须放大局部看。

⚠️ 这些图只作内部校验，不要提交进仓库。
"""
import sys

from PIL import Image


def main():
    if len(sys.argv) < 7:
        print(__doc__)
        return 1
    src, dst = sys.argv[1], sys.argv[2]
    x, y, w, h = (int(v) for v in sys.argv[3:7])
    k = float(sys.argv[7]) if len(sys.argv) > 7 else 3.0

    im = Image.open(src).convert('RGBA')
    box = (max(0, x), max(0, y), min(im.width, x + w), min(im.height, y + h))
    crop = im.crop(box)
    # NEAREST：放大后要看的是"像素级形状"（箭镞在哪、光带宽几像素），
    # 用 LANCZOS 会把细节糊掉，等于白放大
    out = crop.resize((int(crop.width * k), int(crop.height * k)), Image.NEAREST)
    out.save(dst)
    print('saved %s  %dx%d -> %dx%d  (crop %s  x%.1f)' % (
        dst, crop.width, crop.height, out.width, out.height, box, k))
    return 0


if __name__ == '__main__':
    sys.exit(main())

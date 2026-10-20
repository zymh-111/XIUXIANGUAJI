#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
================================================================================
字体裁剪 —— 把 24~27 MB 的霞鹜文楷裁成只含游戏用字的 WOFF2
--------------------------------------------------------------------------------
为什么需要：
  1. 原字体 3 个共约 78 MB（LXGWWenKai-Regular 24.4 MB / Medium 24.2 MB /
     得意黑 2.5 MB），PWA 上手机根本不该下这么大的字。
  2. 更要命：`@font-face` 原来指向 `../../美术资源/02_字体/...`
     —— **游戏目录外面**。所以 `原型/发布/秘境录/` 里根本没有字体，
     双击发布包看到的一直是系统兜底字体（这个 bug 之前没人发现）。

做法：
  扫描 `index.html` + `_game.js`，取出所有出现过的字符（加上 ASCII 可打印区、
  常用标点、以及运行时可能拼出来的数字/单位），只裁这些字形。
  ⚠️ 如果以后在代码里**新增了字**（比如新的功法名/地名），必须重跑本脚本，
     否则新字会掉回兜底字体（表现为"某个字突然变宋体"）。

用法：
  python _tools/subset_fonts.py
输出：
  assets/字体/<名字>.woff2
================================================================================
"""
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
GAME = os.path.dirname(HERE)
FONT_SRC = os.path.abspath(os.path.join(GAME, '..', '..', '美术资源', '02_字体'))
OUT_DIR = os.path.join(GAME, 'assets', '字体')

# (源文件, 输出名)
FONTS = [
    ('LXGWWenKai-Regular.ttf', 'WenKai-Regular.woff2'),
    ('LXGWWenKai-Medium.ttf',  'WenKai-Medium.woff2'),
    (os.path.join('SmileySans_得意黑', 'SmileySans-Oblique.ttf'),
     'SmileySans-Oblique.woff2'),
]

# 额外保底字符：ASCII 可打印 + 常用中文标点 + 数字单位
BASE = (
    ''.join(chr(c) for c in range(0x20, 0x7F)) +
    '　、。〈〉《》「」『』【】〔〕・…‥—–－～·×÷±°′″％‰¥$€£℃'
    '０１２３４５６７８９'
    '↔→←↑↓▲△▼▽■□●○◆◇★☆✓✔✕✖'
    '息年层件位名点级档代岁届榜甲乙丙丁戊己庚辛壬癸'
    '壹贰叁肆伍陆柒捌玖拾佰仟万亿'
)

# 游戏里用 console/log 拼出来的东西也扫一遍（_game.js 已经全含了，这里只是保险）
EXTRA_FILES = ['index.html', '_game.js', '_init_test.js']


def collect_chars():
    """把游戏源码里出现过的所有字符收集起来"""
    chars = set(BASE)
    for name in EXTRA_FILES:
        p = os.path.join(GAME, name)
        if not os.path.exists(p):
            continue
        with open(p, 'r', encoding='utf-8', errors='ignore') as f:
            txt = f.read()
        chars |= set(txt)
    # 去掉控制字符
    chars = {c for c in chars if ord(c) >= 0x20 and c not in '\u2028\u2029'}
    return chars


def main():
    if not os.path.isdir(FONT_SRC):
        print('  [X] 找不到字体源目录: %s' % FONT_SRC)
        return 1

    os.makedirs(OUT_DIR, exist_ok=True)

    chars = collect_chars()
    text = ''.join(sorted(chars))
    # 写成临时文本文件给 pyftsubset 用（避免命令行长度限制）
    tmp = os.path.join(OUT_DIR, '_chars.txt')
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(text)
    print('  用字统计: %d 个不同字符' % len(chars))

    sub = os.path.join(os.path.dirname(sys.executable), 'Scripts', 'pyftsubset.exe')
    use_exe = os.path.exists(sub)

    total_in = total_out = 0
    for src_name, out_name in FONTS:
        src = os.path.join(FONT_SRC, src_name)
        if not os.path.exists(src):
            print('  [!] 缺字体，跳过: %s' % src_name)
            continue
        dst = os.path.join(OUT_DIR, out_name)
        args = [
            '--text-file=' + tmp,
            '--flavor=woff2',
            '--layout-features=kern,liga',
            '--no-hinting',
            '--desubroutinize',
            '--drop-tables+=DSIG',
            '--output-file=' + dst,
            src,
        ]
        if use_exe:
            cmd = [sub] + args
        else:
            cmd = [sys.executable, '-m', 'fontTools.subset'] + args

        r = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='ignore')
        if r.returncode != 0 or not os.path.exists(dst):
            print('  [X] 裁剪失败: %s' % src_name)
            print('      ' + (r.stderr or '')[-400:])
            continue

        a = os.path.getsize(src) / 1024 / 1024
        b = os.path.getsize(dst) / 1024
        total_in += a
        total_out += b
        print('  %-26s %6.1f MB -> %6.0f KB  (%s)' % (src_name, a, b, out_name))

    try:
        os.remove(tmp)
    except OSError:
        pass

    if total_out:
        print('  ----')
        print('  合计 %.1f MB -> %.0f KB（压缩到 %.2f%%）'
              % (total_in, total_out, total_out / (total_in * 1024) * 100))
    return 0


if __name__ == '__main__':
    sys.exit(main())

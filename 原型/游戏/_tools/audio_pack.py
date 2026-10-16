# -*- coding: utf-8 -*-
"""
音效打包管线：美术资源/05_音效/  →  原型/游戏/assets/音效/

为什么要转：源文件是 112 个 **立体声 44.1/48k 未压缩 WAV**，合计 **16.1 MB**，
而整个发布包才 2.4 MB —— 直接塞进去体积要涨 7 倍，而音效只是短促的一次性音。

做法：混单声道 + 保持原始采样率（**不重采样**，避免 aliasing）+ 编码 MP3。
选 MP3 而不是 OGG/Vorbis：两者体积几乎一样（实测 3.25s 文件都是 ~28.8KB），
但 MP3 是所有浏览器（含 Safari）都吃的保底格式。体积上已经是源的 ~1/30。

用法：
  python _tools/audio_pack.py                # 全量转（跳过已有）
  python _tools/audio_pack.py --force        # 强制重转
  python _tools/audio_pack.py --list         # 只列出将要输出什么
"""
import os
import re
import sys
import numpy as np
import soundfile as sf

SRC = 'D:/游戏资料库/美术资源/05_音效'
DST = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets', '音效')

# ---- 源子目录 → 输出名前缀 ------------------------------------------------
#  名字冲突只可能跨目录发生，所以只有容易撞的组才加前缀。
#  留空 = 直接用文件名（该组名字在本库内唯一）。
PREFIX = {
    'melee_sounds': 'melee-',          # "melee sound" / "sword sound" 里有空格
    'rpg_sound_pack/RPG Sound Pack/battle': '',
    'rpg_sound_pack/RPG Sound Pack/interface': '',
    'rpg_sound_pack/RPG Sound Pack/inventory': '',
    'rpg_sound_pack/RPG Sound Pack/misc': '',
    'rpg_sound_pack/RPG Sound Pack/world': '',
    'rpg_sound_pack/RPG Sound Pack/NPC/beetle': '',
    'rpg_sound_pack/RPG Sound Pack/NPC/giant': '',
    'rpg_sound_pack/RPG Sound Pack/NPC/gutteral beast': '',
    'rpg_sound_pack/RPG Sound Pack/NPC/misc': '',
    'rpg_sound_pack/RPG Sound Pack/NPC/ogre': '',
    'rpg_sound_pack/RPG Sound Pack/NPC/shade': '',
    'rpg_sound_pack/RPG Sound Pack/NPC/slime': '',
    'swishes': '',
}
# 顶层独立文件（不在 rpg 包里）
EXTRA = ['wind_woosh_loop.ogg']   # liyan.mp3 是 1.1MB 的长音频（音乐），不是音效 ⇒ 不收

# 只收这些扩展名
OK_EXT = ('.wav', '.ogg', '.mp3')


def out_name(src_path, rel_dir):
    base = os.path.splitext(os.path.basename(src_path))[0].lower()
    base = re.sub(r'[^a-z0-9\-]+', '-', base).strip('-')     # 空格/大写 → 连字符
    return (PREFIX.get(rel_dir, '') + base) + '.mp3'


def collect():
    """→ [(源绝对路径, 输出名), ...]（跳过 __MACOSX / DS_Store）"""
    items, seen = [], {}
    for root, dirs, files in os.walk(SRC):
        dirs[:] = [d for d in dirs if d != '__MACOSX']
        rel = os.path.relpath(root, SRC).replace('\\', '/')
        if rel == '.':
            continue                                    # 顶层单独处理
        for f in sorted(files):
            if f.startswith('._') or not f.lower().endswith(OK_EXT):
                continue
            name = out_name(f, rel)
            if name in seen:                            # 撞名 ⇒ 报错而不是悄悄覆盖
                raise SystemExit('输出名冲突: %s ← %s 与 %s' % (name, f, seen[name]))
            seen[name] = f
            items.append((os.path.join(root, f), name))
    for f in EXTRA:
        p = os.path.join(SRC, f)
        if os.path.exists(p):
            items.append((p, out_name(f, '.')))
    return sorted(items, key=lambda x: x[1])


def convert(src, name, force):
    dst = os.path.join(DST, name)
    if os.path.exists(dst) and not force:
        return 'skip', os.path.getsize(dst)
    d, sr = sf.read(src, always_2d=True)
    mono = d.mean(axis=1).astype('float32')             # 立体声 → 单声道
    peak = float(np.max(np.abs(mono))) if mono.size else 0.0
    if peak > 1e-6:
        mono = (mono / peak * 0.89).astype('float32')   # 统一峰值，避免忽大忽小
    sf.write(dst, mono, sr, format='MP3', subtype='MPEG_LAYER_III')
    return 'ok', os.path.getsize(dst)


def main():
    force = '--force' in sys.argv
    only_list = '--list' in sys.argv
    items = collect()
    if only_list:
        for s, n in items:
            print('%-28s ← %s' % (n, os.path.relpath(s, SRC)))
        print('\n共 %d 个' % len(items))
        return
    os.makedirs(DST, exist_ok=True)
    src_total = dst_total = 0
    ok = skip = 0
    for s, n in items:
        st, size = convert(s, n, force)
        src_total += os.path.getsize(s)
        dst_total += size
        ok += (st == 'ok')
        skip += (st == 'skip')
    print('源 %d 个 / %.1f MB' % (len(items), src_total / 1048576))
    print('出 %d 个（新转 %d · 跳过 %d）/ %.2f MB' % (len(items), ok, skip, dst_total / 1048576))
    print('压缩比 %.1f×' % (src_total / max(1, dst_total)))
    print('输出目录: %s' % DST)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把秘境录从域名根路径挪到 /game/，同时把根路径让给门户页。
只改 doublemoon.com.cn 的 443 server 块，绝不碰 /fate/。
"""
import os
import re
import shutil
import subprocess
import sys
import time

CONF = '/etc/nginx/sites-available/mijinglu'
BACKUP = CONF + '.bak-' + time.strftime('%Y%m%d-%H%M%S')

GAME_LOCATIONS = """
    # ---- 秘境录：/game/（同源 => 存档不会因换域名丢失）----
    location = /game/index.html {
        root /var/www;
        add_header Cache-Control "no-cache, must-revalidate";
    }
    location = /game/sw.js {
        root /var/www;
        add_header Cache-Control "no-cache, must-revalidate";
        add_header Service-Worker-Allowed "/game/";
    }
    location = /game/_precache.json {
        root /var/www;
        add_header Cache-Control "no-cache, must-revalidate";
    }
    location = /game/manifest.json {
        root /var/www;
        add_header Cache-Control "no-cache, must-revalidate";
    }
    location /game/assets/ {
        root /var/www;
        expires 30d;
        add_header Cache-Control "public, max-age=2592000";
        access_log off;
    }
    location /game/ {
        root /var/www;
        index index.html;
        try_files $uri $uri/ /game/index.html;
    }
"""


def split_server_blocks(src):
    """返回 [(start, end)] ，end 指向闭合 } 之后"""
    blocks = []
    i = 0
    n = len(src)
    while True:
        m = re.search(r'^server\s*\{', src[i:], re.M)
        if not m:
            break
        start = i + m.start()
        depth = 0
        j = i + m.end() - 1  # 指向 '{'
        while j < n:
            if src[j] == '{':
                depth += 1
            elif src[j] == '}':
                depth -= 1
                if depth == 0:
                    blocks.append((start, j + 1))
                    i = j + 1
                    break
            j += 1
        else:
            break
    return blocks


def main():
    src = open(CONF, encoding='utf-8').read()
    blocks = split_server_blocks(src)
    print('  找到 %d 个 server 块' % len(blocks))

    target = None
    for (s, e) in blocks:
        chunk = src[s:e]
        if 'listen 443' in chunk and 'server_name doublemoon.com.cn' in chunk:
            target = (s, e)
            break

    if not target:
        print('  [X] 找不到 doublemoon 的 443 块，放弃')
        return 1

    s, e = target
    chunk = src[s:e]
    print('  doublemoon 443 块: 字符 %d..%d (%d 字节)' % (s, e, len(chunk)))

    changed = []

    # ① 根路径：游戏 -> 门户
    if 'root /var/www/mijinglu;' in chunk:
        chunk = chunk.replace('root /var/www/mijinglu;', 'root /var/www/portal;', 1)
        changed.append('root -> /var/www/portal')
    else:
        print('  [!] 块里没有 root /var/www/mijinglu;（可能已被改过）')

    # ② 插入 /game/ 的 location（放在最后一个 location / { 之前）
    if '/game/' not in chunk:
        marker = re.search(r'\n    location / \{', chunk)
        if marker:
            chunk = chunk[:marker.start()] + '\n' + GAME_LOCATIONS + chunk[marker.start():]
            changed.append('插入 /game/ locations')
        else:
            # 没有 location / ，就插在块尾 } 之前
            last = chunk.rstrip().rfind('}')
            chunk = chunk[:last] + GAME_LOCATIONS + '\n' + chunk[last:]
            changed.append('插入 /game/ locations（块尾）')
    else:
        print('  [!] 已有 /game/，跳过插入')

    if not changed:
        print('  没有需要改的')
        return 0

    new = src[:s] + chunk + src[e:]
    shutil.copy2(CONF, BACKUP)
    open(CONF, 'w', encoding='utf-8').write(new)
    print('  已备份: %s' % BACKUP)
    print('  改动: %s' % ', '.join(changed))

    # 校验
    r = subprocess.run(['nginx', '-t'], capture_output=True, text=True)
    print('  nginx -t: %s' % ('OK' if r.returncode == 0 else 'FAILED'))
    if r.returncode != 0:
        print((r.stderr or '')[-600:])
        shutil.copy2(BACKUP, CONF)
        print('  已回滚')
        return 1
    print(r.stderr.strip()[-200:] if r.stderr else '')
    return 0


if __name__ == '__main__':
    sys.exit(main())

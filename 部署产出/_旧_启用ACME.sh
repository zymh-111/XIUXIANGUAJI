#!/bin/bash
export DEBIAN_FRONTEND=noninteractive

echo "--- 1. wait for dpkg lock (max 240s) ---"
for i in $(seq 1 48); do
  if ! fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; then
    echo "  lock free after ${i}0s"
    break
  fi
  sleep 5
done

echo ""
echo "--- 2. install certbot ---"
apt-get install -y -qq certbot 2>&1 | tail -4
if command -v certbot >/dev/null 2>&1; then
  certbot --version 2>&1
else
  echo "  certbot STILL missing"
fi

echo ""
echo "--- 3. add ACME allow rule ---"
CONF=/etc/nginx/sites-available/mijinglu
python3 - "$CONF" <<'PY'
import sys
p = sys.argv[1]
try:
    s = open(p, encoding='utf-8').read()
except Exception as e:
    print("  read fail:", e); raise SystemExit(0)
if 'acme-challenge' in s:
    print("  already present")
else:
    marker = "    # Never expose deployment notes"
    block = (
        "    # ACME (Let's Encrypt) challenge MUST stay reachable\n"
        "    location ^~ /.well-known/acme-challenge/ {\n"
        "        root /var/www/mijinglu;\n"
        "        default_type text/plain;\n"
        "        allow all;\n"
        "    }\n\n"
    )
    if marker in s:
        s = s.replace(marker, block + marker, 1)
        open(p, 'w', encoding='utf-8').write(s)
        print("  inserted")
    else:
        print("  MARKER NOT FOUND")
PY

echo ""
echo "--- 4. nginx test + reload ---"
nginx -t 2>&1
systemctl reload nginx && echo "  reloaded"

echo ""
echo "--- 5. ACME path test ---"
mkdir -p /var/www/mijinglu/.well-known/acme-challenge
echo "acme-test-ok" > /var/www/mijinglu/.well-known/acme-challenge/ping
echo "  local: status=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/.well-known/acme-challenge/ping) body=$(curl -s http://127.0.0.1/.well-known/acme-challenge/ping)"

echo "--- DONE ---"

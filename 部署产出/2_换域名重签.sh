#!/bin/bash
# Switch domain from sslip.io (SNI-blocked) to nip.io
NEWDOM="8-137-167-162.nip.io"
OLDDOM="8-137-167-162.sslip.io"
LOG=/root/switch_domain.log
: > "$LOG"
log() { echo "[$(date +%H:%M:%S)] $*" >> "$LOG"; }
log "==== START switch to $NEWDOM ===="

echo "--- 1. issue cert for $NEWDOM ---"
certbot certonly --webroot -w /var/www/mijinglu \
  -d "$NEWDOM" \
  --register-unsafely-without-email --agree-tos --non-interactive \
  --deploy-hook "systemctl reload nginx" >>"$LOG" 2>&1
if [ ! -d "/etc/letsencrypt/live/$NEWDOM" ]; then
  log "FATAL cert not issued"
  log "==== END (FAILED) ===="
  exit 1
fi
log "  cert ok"

echo "--- 2. patch nginx config: domain + cert paths ---"
CONF=/etc/nginx/sites-available/mijinglu
python3 - "$CONF" "$OLDDOM" "$NEWDOM" <<'PY'
import sys
p, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p, encoding='utf-8').read()
s = s.replace(old, new)          # server_name + cert paths both contain the domain
open(p, 'w', encoding='utf-8').write(s)
print("  patched: %d -> %d occurrences of domain" % (s.count(new), s.count(new)))
PY
log "  config patched"

echo "--- 3. test + reload ---"
nginx -t >>"$LOG" 2>&1 && systemctl reload nginx && log "  reloaded" || { log "FATAL nginx test failed"; exit 1; }

echo "--- 4. verify ---"
sleep 1
c=$(curl -sS -o /dev/null -w '%{http_code}' --resolve "$NEWDOM:443:127.0.0.1" "https://$NEWDOM/manifest.json")
log "  local https -> $c (expect 200)"
c2=$(curl -sS -o /dev/null -w '%{http_code}' --resolve "$OLDDOM:443:127.0.0.1" "https://$NEWDOM/index.html")
log "  index.html  -> $c2 (expect 200)"
log "  cert: $(openssl x509 -subject -noout -in /etc/letsencrypt/live/$NEWDOM/cert.pem 2>/dev/null)"
log "  expires: $(openssl x509 -enddate -noout -in /etc/letsencrypt/live/$NEWDOM/cert.pem 2>/dev/null | cut -d= -f2)"
log "==== END (OK) ===="

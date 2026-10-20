#!/bin/bash
# Runs detached on the server. Logs to /root/setup_cert.log
DOMAIN="8-137-167-162.sslip.io"
LOG=/root/setup_cert.log
: > "$LOG"
log() { echo "[$(date +%H:%M:%S)] $*" >> "$LOG"; }

log "==== START ===="

# ---------- 1. wait for dpkg lock (unattended-upgrades is doing a big upgrade) ----------
log "STEP1 waiting for dpkg lock"
for i in $(seq 1 120); do
  if ! lsof /var/lib/dpkg/lock-frontend >/dev/null 2>&1; then
    log "  lock free after $((i*10))s"
    break
  fi
  if [ $((i % 6)) -eq 0 ]; then
    log "  still locked (${i}0s) - $(ps -o etime= -p $(lsof -t /var/lib/dpkg/lock-frontend 2>/dev/null | head -1) 2>/dev/null | tr -d ' ')"
  fi
  sleep 10
done

# ---------- 2. install certbot ----------
log "STEP2 installing certbot"
export DEBIAN_FRONTEND=noninteractive
for i in $(seq 1 20); do
  if command -v certbot >/dev/null 2>&1; then log "  already installed"; break; fi
  apt-get install -y -qq certbot >>"$LOG" 2>&1
  if command -v certbot >/dev/null 2>&1; then log "  installed (attempt $i)"; break; fi
  log "  attempt $i failed, sleep 15"
  sleep 15
done
command -v certbot >/dev/null 2>&1 || { log "FATAL certbot missing - ABORT"; exit 1; }
log "  version: $(certbot --version 2>&1)"

# ---------- 3. make sure ACME path is served ----------
log "STEP3 ensuring ACME path"
mkdir -p /var/www/mijinglu/.well-known/acme-challenge
echo ok > /var/www/mijinglu/.well-known/acme-challenge/ping
nginx -t >>"$LOG" 2>&1 && systemctl reload nginx
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $DOMAIN" http://127.0.0.1/.well-known/acme-challenge/ping)
log "  local acme http code=$code"

# ---------- 4. issue certificate ----------
log "STEP4 requesting certificate for $DOMAIN"
certbot certonly --webroot -w /var/www/mijinglu \
  -d "$DOMAIN" \
  --register-unsafely-without-email \
  --agree-tos --non-interactive \
  --deploy-hook "systemctl reload nginx" >>"$LOG" 2>&1
if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  log "FATAL certificate NOT issued - see above"
  log "==== END (FAILED) ===="
  exit 1
fi
log "  CERT OK: $(ls /etc/letsencrypt/live/$DOMAIN/ | tr '\n' ' ')"

# ---------- 5. switch nginx to HTTPS ----------
log "STEP5 applying HTTPS config"
cp /root/mijinglu-https.conf /etc/nginx/sites-available/mijinglu
nginx -t >>"$LOG" 2>&1
if [ $? -ne 0 ]; then
  log "FATAL nginx config test failed - keeping old config"
  log "==== END (FAILED) ===="
  exit 1
fi
systemctl reload nginx
log "  nginx reloaded"

# ---------- 6. verify ----------
log "STEP6 verify"
sleep 1
c80=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $DOMAIN" http://127.0.0.1/)
c443=$(curl -sk -o /dev/null -w '%{http_code}' -H "Host: $DOMAIN" https://127.0.0.1/)
log "  http  -> $c80 (expect 301)"
log "  https -> $c443 (expect 200)"
cert_end=$(openssl x509 -enddate -noout -in "/etc/letsencrypt/live/$DOMAIN/cert.pem" 2>/dev/null | cut -d= -f2)
log "  cert expires: $cert_end"
log "  renew timer: $(systemctl list-timers 'certbot*' --no-pager 2>/dev/null | grep -c certbot) entry"
log "==== END (OK) ===="

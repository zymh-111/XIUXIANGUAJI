#!/bin/bash
DOM="8-137-167-162.sslip.io"
echo "=== A. loopback HTTPS via domain (SNI + cert verify) ==="
for i in 1 2 3; do
  printf '  try%d: ' "$i"
  curl -sS -o /dev/null -w '%{http_code} %{size_download}B %{time_total}s\n' \
    --resolve "$DOM:443:127.0.0.1" "https://$DOM/manifest.json" 2>&1
done

echo ""
echo "=== B. loopback HTTPS to 127.0.0.1 (no SNI match, skip verify) ==="
for i in 1 2 3; do
  printf '  try%d: ' "$i"
  curl -sk -o /dev/null -w '%{http_code} %{size_download}B\n' "https://127.0.0.1/manifest.json" 2>&1
done

echo ""
echo "=== C. curl to own public IP over HTTPS (goes out and back) ==="
for i in 1 2; do
  printf '  try%d: ' "$i"
  curl -sk -o /dev/null -w '%{http_code} %{size_download}B %{time_total}s\n' "https://8.137.167.162/manifest.json" 2>&1
done

echo ""
echo "=== D. nginx logs ==="
echo "  error.log tail:"
tail -6 /var/log/nginx/error.log 2>/dev/null | sed 's/^/    /'
echo "  access.log tail:"
tail -6 /var/log/nginx/access.log 2>/dev/null | sed 's/^/    /'

echo ""
echo "=== E. 系统资源 / 连接 ==="
echo "  memory:"; free -m | head -2 | sed 's/^/    /'
echo "  conntrack:"; (cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null || echo "  n/a")
echo "  nf_conntrack_max:"; (cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null || echo "  n/a")
echo "  socket summary:"; ss -s 2>/dev/null | head -4 | sed 's/^/    /'
echo "  nginx workers:"; ps aux | grep -c '[n]ginx'

echo ""
echo "=== F. dmesg 可疑项 ==="
dmesg 2>/dev/null | tail -8 | sed 's/^/    /'

echo ""
echo "=== G. ufw / iptables 有没有限流 ==="
ufw status 2>/dev/null | head -3 | sed 's/^/    /'
iptables -L -n 2>/dev/null | grep -c DROP | sed 's/^/    DROP rules: /'
echo "--- DONE ---"

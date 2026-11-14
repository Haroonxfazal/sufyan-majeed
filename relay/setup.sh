#!/usr/bin/env bash
# One-command setup for the ZKTeco relay on a fresh Ubuntu/Debian VM.
#   curl -fsSL https://raw.githubusercontent.com/Haroonxfazal/sufyan-majeed/main/relay/setup.sh | sudo bash
# or copy this file and nginx-iclock.conf to the VM and run: sudo bash setup.sh
set -euo pipefail

CONF_URL="https://raw.githubusercontent.com/Haroonxfazal/sufyan-majeed/main/relay/nginx-iclock.conf"

apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y nginx curl

# Use the config next to this script if present, otherwise download it.
if [ -f "$(dirname "$0")/nginx-iclock.conf" ]; then
  cp "$(dirname "$0")/nginx-iclock.conf" /etc/nginx/conf.d/iclock.conf
else
  curl -fsSL "$CONF_URL" -o /etc/nginx/conf.d/iclock.conf
fi
rm -f /etc/nginx/sites-enabled/default

# Oracle Ubuntu images ship with iptables rules that block port 80.
if command -v iptables >/dev/null 2>&1; then
  iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT
  command -v netfilter-persistent >/dev/null 2>&1 && netfilter-persistent save || true
fi

nginx -t
systemctl enable nginx
systemctl restart nginx

echo
echo "Relay is running. Test it (should print 403 'Unknown device'):"
echo "  curl -i 'http://127.0.0.1/iclock/getrequest?SN=TEST'"
echo "Public IP of this server:"
curl -fsS https://api.ipify.org || true
echo

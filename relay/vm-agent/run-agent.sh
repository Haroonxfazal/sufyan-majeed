#!/usr/bin/env bash
# Starts the attendance agent against the academy's CURRENT public IP.
# The machine's relay heartbeat reveals that IP, so a changing home IP is handled.
set -euo pipefail
IP=$(grep "SN=AF6P210960179" /var/log/nginx/iclock_body.log | tail -1 | awk '{print $2}')
[ -n "$IP" ] || { echo "academy IP unknown yet"; exit 1; }
echo "$IP" > /opt/zk-agent/current_ip
export ZKTECO_IP="$IP" TZ=Asia/Karachi
exec /opt/zk-agent/venv/bin/python -u /opt/zk-agent/agent.py

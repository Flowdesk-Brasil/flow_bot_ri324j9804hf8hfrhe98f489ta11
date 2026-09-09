#!/bin/bash
export PATH=/www/server/nodejs/v26.5.1/bin:/usr/bin:/bin:$PATH
if ! curl -fsS -m 4 http://127.0.0.1:15001/health >/dev/null; then
  echo "$(date -Is) flowdesk-vps-daemon unhealthy, restarting" >> /var/log/flowdesk-daemon-watchdog.log
  pm2 restart flowdesk-vps-daemon --update-env >/dev/null
fi

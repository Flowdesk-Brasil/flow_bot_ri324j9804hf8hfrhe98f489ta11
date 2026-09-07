#!/bin/sh
echo "FlowDesk: liberando saida HTTPS 443. MySQL permanece local."
if command -v ufw >/dev/null 2>&1; then
  ufw allow out 443/tcp || true
fi
echo "Pronto."

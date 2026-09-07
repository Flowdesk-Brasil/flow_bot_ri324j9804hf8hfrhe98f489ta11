#!/bin/sh
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  npm install --omit=dev
fi
echo "FlowDesk Whitelist Agent em http://127.0.0.1:8733"
node index.js

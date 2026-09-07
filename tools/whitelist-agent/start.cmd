@echo off
cd /d "%~dp0"
title FlowDesk Whitelist Agent
if not exist node_modules (
  echo Instalando dependencias do Agent...
  call npm install --omit=dev
)
echo Abrindo o launcher em http://127.0.0.1:8733
node index.js
pause

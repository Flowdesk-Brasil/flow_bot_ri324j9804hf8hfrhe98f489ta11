@echo off
echo FlowDesk: liberando saida HTTPS (443). A porta 3306 NAO sera aberta na internet.
netsh advfirewall firewall add rule name="FlowDesk Whitelist Agent HTTPS" dir=out action=allow protocol=TCP remoteport=443 enable=yes
echo Pronto. No modo Agent o MySQL fica em 127.0.0.1.
pause

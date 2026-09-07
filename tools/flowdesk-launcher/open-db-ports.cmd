@echo off
setlocal
title Flowdesk - Liberar portas do banco
net session >nul 2>&1
if not %errorLevel%==0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo.
echo  Flowdesk
echo  Liberando MySQL nesta VPS...
echo.

netsh advfirewall firewall delete rule name="Flowdesk City MySQL" >nul 2>&1
netsh advfirewall firewall add rule name="Flowdesk City MySQL" dir=in action=allow protocol=TCP localport=3306 enable=yes profile=any
netsh advfirewall firewall delete rule name="Flowdesk City MariaDB" >nul 2>&1
netsh advfirewall firewall add rule name="Flowdesk City MariaDB" dir=in action=allow protocol=TCP localport=3307 enable=yes profile=any
netsh advfirewall firewall delete rule name="Flowdesk City Postgres" >nul 2>&1
netsh advfirewall firewall add rule name="Flowdesk City Postgres" dir=in action=allow protocol=TCP localport=5432 enable=yes profile=any
netsh advfirewall firewall delete rule name="Flowdesk Launcher HTTPS" >nul 2>&1
netsh advfirewall firewall add rule name="Flowdesk Launcher HTTPS" dir=out action=allow protocol=TCP remoteport=443 enable=yes profile=any

for %%S in (MySQL MySQL80 MySQL57 MariaDB MariaDB103 MariaDB104 XAMPP MySQL "MySQL80" "MariaDB") do (
  sc query %%S >nul 2>&1 && sc start %%S >nul 2>&1
)

echo  Portas 3306 / 3307 / 5432 liberadas no firewall.
echo  Servicos MySQL/MariaDB tentados.
echo.
timeout /t 4 >nul
exit /b 0

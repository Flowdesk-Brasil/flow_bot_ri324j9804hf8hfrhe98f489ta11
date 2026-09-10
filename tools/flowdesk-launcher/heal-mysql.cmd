@echo off
setlocal EnableExtensions
title Flowdesk - Corrigir MySQL
net session >nul 2>&1
if not %errorLevel%==0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs -WindowStyle Hidden"
  exit /b
)

netsh advfirewall firewall delete rule name="Flowdesk City MySQL" >nul 2>&1
netsh advfirewall firewall add rule name="Flowdesk City MySQL" dir=in action=allow protocol=TCP localport=3306 enable=yes profile=any >nul
netsh advfirewall firewall delete rule name="Flowdesk City MariaDB" >nul 2>&1
netsh advfirewall firewall add rule name="Flowdesk City MariaDB" dir=in action=allow protocol=TCP localport=3307 enable=yes profile=any >nul
netsh advfirewall firewall delete rule name="Flowdesk City Postgres" >nul 2>&1
netsh advfirewall firewall add rule name="Flowdesk City Postgres" dir=in action=allow protocol=TCP localport=5432 enable=yes profile=any >nul
netsh advfirewall firewall delete rule name="Flowdesk Launcher HTTPS" >nul 2>&1
netsh advfirewall firewall add rule name="Flowdesk Launcher HTTPS" dir=out action=allow protocol=TCP remoteport=443 enable=yes profile=any >nul

for %%S in (MySQL MySQL80 MySQL84 MySQL57 MySQL56 MariaDB MariaDB103 MariaDB104 MariaDB106 MariaDB1011 XAMPP) do (
  sc query "%%S" >nul 2>&1 && (
    sc config "%%S" start= auto >nul 2>&1
    sc start "%%S" >nul 2>&1
  )
)

set "XAMPP="
for %%D in (C D E F) do (
  if exist "%%D:\xampp\mysql\bin\mysqld.exe" set "XAMPP=%%D:\xampp"
  if exist "%%D:\XAMPP\mysql\bin\mysqld.exe" set "XAMPP=%%D:\XAMPP"
)

if defined XAMPP (
  powershell -NoProfile -Command ^
    "$files=@('%XAMPP%\mysql\bin\my.ini','%XAMPP%\mysql\my.ini'); foreach($f in $files){ if(Test-Path $f){ $c=Get-Content $f -Raw; $n=$c -replace '(?m)^\s*bind-address\s*=\s*127\.0\.0\.1','bind-address=0.0.0.0' -replace '(?m)^\s*skip-networking\s*=\s*1','skip-networking=0'; if($n -ne $c){ Copy-Item $f ($f+'.flowdesk.bak') -Force; Set-Content -Path $f -Value $n -Encoding ASCII } } }"

  if exist "%XAMPP%\mysql\bin\mysqld.exe" if exist "%XAMPP%\mysql\bin\my.ini" (
    start "" /b "%XAMPP%\mysql\bin\mysqld.exe" --defaults-file="%XAMPP%\mysql\bin\my.ini"
  )
  if exist "%XAMPP%\mysql_start.bat" start "" /b cmd /c "%XAMPP%\mysql_start.bat"
)

exit /b 0

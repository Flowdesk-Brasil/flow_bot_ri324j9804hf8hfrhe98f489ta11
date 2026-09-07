-- MariaDB / HeidiSQL. Aba CONSULTA, logado como root.
-- Nao use o Gerenciador de usuarios. Nao use IDENTIFIED WITH ... BY (isso e MySQL 8).

GRANT ALL PRIVILEGES ON *.* TO 'usuariodeteste'@'localhost' IDENTIFIED BY '12345' WITH GRANT OPTION;
GRANT ALL PRIVILEGES ON *.* TO 'usuariodeteste'@'127.0.0.1' IDENTIFIED BY '12345' WITH GRANT OPTION;
GRANT ALL PRIVILEGES ON *.* TO 'usuariodeteste'@'%' IDENTIFIED BY '12345' WITH GRANT OPTION;
FLUSH PRIVILEGES;

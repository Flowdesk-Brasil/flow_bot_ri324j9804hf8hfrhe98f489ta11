# Guia Definitivo de Migração da Infraestrutura Flowdesk (VPS)

Este documento descreve detalhadamente como recriar o ambiente da VPS do Flowdesk do zero em um novo servidor Ubuntu, restaurando todas as configurações do **Supabase** (banco de dados, storage e auth) e reativando os serviços **Node.js/PM2**, como o Daemon da VPS e a API principal.

> [!IMPORTANT]
> **Pré-requisitos do Novo Servidor:**
> - Sistema Operacional recomendado: **Ubuntu 22.04 LTS** ou superior.
> - Acesso Root.
> - Memória RAM: Recomendado 4GB ou mais devido à stack completa do Supabase via Docker.

---

## 1. Instalação das Dependências Essenciais

Ao acessar a nova VPS via SSH (`ssh root@ip_do_novo_servidor`), execute os comandos abaixo para instalar Node.js, PM2, Docker e outras ferramentas:

```bash
# Atualiza repositórios básicos
apt update && apt upgrade -y
apt install -y curl wget git jq unzip tar gcc make

# Instalação do Node.js (v20) e PM2
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
npm install -g pm2 yarn pnpm

# Instalação do Docker e Docker Compose
curl -fsSL https://get.docker.com | bash
usermod -aG docker root
```

---

## 2. Transferência dos Backups para o Novo Servidor

Do seu computador local (onde a pasta `vps-backup` está salva), envie os 4 arquivos essenciais para o diretório `/root` do novo servidor usando SCP:

```bash
scp -r ./vps-backup/* root@IP_DA_NOVA_VPS:/root/
```

Você deverá ter na raiz `/root/` do novo servidor os seguintes arquivos:
- `supabase-stack.tar.gz` (Configurações e containers do Supabase)
- `postgres-backup.sql.gz` (Dump do banco de dados)
- `storage-backup.tar.gz` (Arquivos do Storage do Supabase)
- `flowdesk-projects.tar.gz` (As aplicações PM2 e API Flowdesk)
- `flowdesk-daemon.js` (O agente orquestrador do Flowdesk)

---

## 3. Restauração do Supabase (Banco de Dados e Infraestrutura)

O Supabase gerencia o Banco Postgres, Realtime, Edge Functions e autenticação, tudo em uma stack Docker.

### 3.1 Descompactando a Stack
```bash
mkdir -p /opt/flowdesk-supabase
tar -xzf /root/supabase-stack.tar.gz -C /opt/flowdesk-supabase
```

### 3.2 Iniciando os Containers (Banco Vazio)
```bash
cd /opt/flowdesk-supabase/stack
docker compose pull
docker compose up -d
```
> [!TIP]
> Espere cerca de 1 a 2 minutos para que o contêiner `supabase-db` (PostgreSQL) esteja totalmente pronto para aceitar a carga do dump.

### 3.3 Restaurando o Banco de Dados
O dump foi gerado com o comando `--clean`, o que significa que ele destruirá as tabelas vazias e recriará sua estrutura completa.

```bash
# Descompacta o banco
gunzip -c /root/postgres-backup.sql.gz > /root/postgres-backup.sql

# Injeta os dados no banco do container
docker compose exec -T db psql -U postgres < /root/postgres-backup.sql
```

### 3.4 Restaurando o Storage (Uploads)
O Supabase salva seus buckets fisicamente na pasta de volumes.

```bash
# O arquivo foi compactado a partir de "volumes/storage", então extraia direto na stack
tar -xzf /root/storage-backup.tar.gz -C /opt/flowdesk-supabase/stack/volumes/
```

> Após a importação, faça um restart seguro na stack para que o Auth e as APIs apliquem os novos dados perfeitamente:
```bash
docker compose restart
```

---

## 4. Restauração das Aplicações (Flowdesk API e VPS Daemon)

O Flowdesk depende de processos rodando via PM2.

### 4.1 Descompactando os Projetos
```bash
tar -xzf /root/flowdesk-projects.tar.gz -C /root/
```

### 4.2 Reativando o Daemon da VPS
O `flowdesk-daemon.js` precisa das bibliotecas básicas instaladas globalmente ou em uma pasta `node_modules` no `/root`.

```bash
cd /root
npm init -y
npm install express cors

# Iniciar o daemon
pm2 start /root/flowdesk-daemon.js --name "vps-daemon"
```

### 4.3 Reativando a API do Flowdesk e outros processos
Navegue pela pasta de projetos (onde fica o `flowdesk-api` e outros sistemas) e reative-os:

```bash
cd /root/flowdesk-projects/flowdesk-api
# Certifique-se de que as dependências existem ou rode npm install
pm2 start npm --name "flowdesk-api" -- start
```
> [!NOTE]
> Se havia outros UUIDs ou processos rodando no PM2 antigo, verifique em `/root/flowdesk-projects/` se há outras pastas e repita o processo de inicialização com o respectivo comando configurado no diretório.

### 4.4 Salvando a configuração do PM2
Para garantir que as aplicações reiniciem automaticamente caso o servidor reinicie:

```bash
pm2 save
pm2 startup
# Siga a instrução que o comando pm2 startup irá gerar no terminal.
```

---

## 5. Validação da Migração

1. Acesse o IP do novo servidor pela porta onde a API está configurada para confirmar a resposta (ex. Porta 3000 ou 5001 para o Daemon).
2. Verifique o uso de recursos da máquina (`htop`).
3. Altere o registro de DNS (no painel da Cloudflare do Flowdesk) para apontar para o novo IP onde os serviços `api.` ou `db.` estão conectados.
4. Lembre-se de atualizar qualquer arquivo `.env` do Front-end (painel local) com o novo IP do Daemon caso ele seja requisitado de forma direta, embora seja fortemente recomendado usar proxies Cloudflare ou subdomínios.

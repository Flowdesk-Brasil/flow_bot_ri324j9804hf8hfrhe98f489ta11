# Flowdesk VPS self-hosted database migration

Data: 2026-06-12

## Resultado

- Banco principal do bot em producao na VPS: Supabase self-hosted em `/opt/flowdesk-supabase`.
- Endpoint usado pelo bot na VPS: `http://127.0.0.1:8000`.
- PostgreSQL, PostgREST, Storage, Studio, Auth, Kong, Meta e Pooler rodam via Docker Compose.
- Portas sensiveis ficam restritas a `127.0.0.1` na VPS.
- PM2 do bot foi reiniciado com `SUPABASE_URL=http://127.0.0.1:8000`.
- Realtime ficou desativado no bot por `SUPABASE_REALTIME_ENABLED=false`, porque a stack self-hosted respondeu health mas CDC ainda ficou `replication_connected=false`.

## Acesso ao painel

No PC, abra um tunel SSH:

```powershell
ssh -i .\id_ed25519_flowdesk -L 8000:127.0.0.1:8000 root@2.25.183.234
```

Depois acesse:

```text
http://127.0.0.1:8000/project/default
```

Usuario do Studio: `flowdesk_admin`.

A senha do Studio e as chaves ficam somente na VPS:

```bash
grep -E '^(DASHBOARD_USERNAME|DASHBOARD_PASSWORD|ANON_KEY|SERVICE_ROLE_KEY|POSTGRES_PASSWORD)=' /opt/flowdesk-supabase/stack/.env
```

## Backups

Backup manual:

```bash
ssh -i .\id_ed25519_flowdesk root@2.25.183.234 "bash /opt/flowdesk-supabase/bin/backup.sh"
```

Backup automatico:

- Timer: `flowdesk-supabase-backup.timer`
- Horario: diariamente as 03:20, com delay aleatorio de ate 10 min
- Retencao: 14 dias
- Pasta: `/opt/flowdesk-supabase/backups`

Checar timer:

```bash
ssh -i .\id_ed25519_flowdesk root@2.25.183.234 "systemctl list-timers --all | grep flowdesk-supabase-backup"
```

## Rollback

O `.env` cloud anterior do bot foi salvo em:

```text
/root/flowdesk-projects/1ade66a8-258f-4873-bc4a-1185c12ea68f/.env.cloud-backup-20260612-115225
```

Para voltar o bot para Supabase Cloud:

```bash
cp /root/flowdesk-projects/1ade66a8-258f-4873-bc4a-1185c12ea68f/.env.cloud-backup-20260612-115225 \
  /root/flowdesk-projects/1ade66a8-258f-4873-bc4a-1185c12ea68f/.env
pm2 restart 1ade66a8-258f-4873-bc4a-1185c12ea68f --update-env
pm2 save
```

Para restaurar backup SQL no banco self-hosted, usar um backup de `/opt/flowdesk-supabase/backups` e executar com a stack parada ou em janela de manutencao:

```bash
cd /opt/flowdesk-supabase/stack
gunzip -c /opt/flowdesk-supabase/backups/flowdesk-postgres-YYYYMMDD-HHMMSS.sql.gz \
  | docker compose exec -T db psql -U postgres -d postgres
```

## Migracao executada

- Migrations raiz aplicadas ate `135_guild_security_log_queue.sql`.
- Migrations `site/sql/admin` aplicadas.
- Dados exportados do Supabase Cloud via REST service role e importados no Postgres self-hosted.
- Storage verificado: bucket `account-avatars` existia e nao tinha objetos.
- Tabela pulada: `system_status_monitor_snapshots`, por timeout do Supabase Cloud. Ela e snapshot operacional derivado, nao dado transacional.

Validacao observada:

- 151 tabelas publicas.
- 600 indices publicos.
- 200 foreign keys.
- 53 funcoes publicas.
- 141 tabelas publicas com RLS.
- REST local respondeu `200` para `auth_users`, `payment_orders`, `tickets`, `auth_sessions`, `hosting_projects` e `guild_security_log_queue`.
- Bot iniciou com `supabase-check` em `127` e sincronizou paineis/tickets.

## Arquivos locais alterados

- `src/services/securityLogsService.js`
- `src/services/supabaseService.js`
- `src/events/messageCreate.js`
- `src/events/messageUpdate.js`
- `src/events/ready.js`
- `sql/106_dashboard_performance_indexes.sql`
- `sql/133_domain_multi_provider_platform.sql`
- `sql/135_guild_security_log_queue.sql`

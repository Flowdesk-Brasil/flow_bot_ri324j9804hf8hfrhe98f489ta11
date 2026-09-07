-- Whitelist FiveM: configuracao por guild, solicitacoes, auditoria e agent/bridge.

create table if not exists public.guild_whitelist_settings (
  id bigint generated always as identity primary key,
  guild_id text not null unique,
  enabled boolean not null default false,
  panel_channel_id text null,
  review_channel_id text null,
  logs_channel_id text null,
  panel_layout jsonb not null default '[]'::jsonb,
  panel_title text not null default '',
  panel_description text not null default '',
  panel_button_label text not null default '',
  panel_message_id text null,
  approved_role_ids text[] not null default '{}'::text[],
  denied_role_ids text[] not null default '{}'::text[],
  review_role_ids text[] not null default '{}'::text[],
  identifier_kind text not null default 'discord_id',
  identifier_label text not null default 'ID / License',
  identifier_placeholder text not null default 'Ex: 1 ou license:xxxx',
  approval_mode text not null default 'manual',
  connection_mode text not null default 'direct',
  db_engine text not null default 'mysql',
  db_host text null,
  db_port integer not null default 3306,
  db_name text null,
  db_user text null,
  db_ssl boolean not null default false,
  db_password_cipher text null,
  mapping jsonb not null default '{}'::jsonb,
  mapping_status text not null default 'draft',
  schema_fingerprint text null,
  last_health_at timestamptz null,
  last_health_ok boolean not null default false,
  last_health_error text null,
  last_health_latency_ms integer null,
  agent_public_id text null,
  agent_token_hash text null,
  configured_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_whitelist_identifier_kind_check
    check (identifier_kind in (
      'discord_id', 'license', 'license2', 'steam', 'rockstar',
      'character_id', 'internal_id', 'custom'
    )),
  constraint guild_whitelist_approval_mode_check
    check (approval_mode in ('manual', 'automatic')),
  constraint guild_whitelist_connection_mode_check
    check (connection_mode in ('direct', 'agent')),
  constraint guild_whitelist_db_engine_check
    check (db_engine in ('mysql', 'mariadb', 'postgres')),
  constraint guild_whitelist_mapping_status_check
    check (mapping_status in ('draft', 'validated', 'invalid')),
  constraint guild_whitelist_db_port_check
    check (db_port >= 1 and db_port <= 65535)
);

create table if not exists public.guild_whitelist_requests (
  id bigint generated always as identity primary key,
  guild_id text not null,
  user_id text not null,
  identifier_kind text not null,
  identifier_value text not null,
  status text not null default 'pending',
  review_message_id text null,
  review_channel_id text null,
  player_key text null,
  previous_whitelist_value text null,
  next_whitelist_value text null,
  apply_error text null,
  correlation_id text not null default '',
  reviewed_by_user_id text null,
  reviewed_at timestamptz null,
  applied_at timestamptz null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_whitelist_requests_status_check
    check (status in (
      'pending', 'approved', 'denied', 'apply_failed', 'cancelled'
    ))
);

create index if not exists idx_guild_whitelist_requests_guild_status
  on public.guild_whitelist_requests (guild_id, status, created_at desc);

create unique index if not exists idx_guild_whitelist_requests_open_member
  on public.guild_whitelist_requests (guild_id, user_id)
  where status in ('pending', 'apply_failed');

create table if not exists public.guild_whitelist_audit (
  id bigint generated always as identity primary key,
  guild_id text not null,
  request_id bigint null references public.guild_whitelist_requests(id) on delete set null,
  user_id text null,
  actor_user_id text null,
  operation text not null,
  identifier_kind text null,
  identifier_value text null,
  player_key text null,
  previous_value text null,
  next_value text null,
  success boolean not null default false,
  error_code text null,
  error_message text null,
  correlation_id text not null default '',
  mapping_fingerprint text null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint guild_whitelist_audit_operation_check
    check (operation in (
      'TEST_CONNECTION', 'INSPECT_SCHEMA', 'TEST_MAPPING',
      'GET_PLAYER', 'CHECK_WHITELIST', 'APPROVE_WHITELIST',
      'REMOVE_WHITELIST', 'RETRY_APPLY', 'HEALTH_CHECK'
    ))
);

create index if not exists idx_guild_whitelist_audit_guild_created
  on public.guild_whitelist_audit (guild_id, created_at desc);

create table if not exists public.guild_whitelist_agent_jobs (
  id bigint generated always as identity primary key,
  guild_id text not null,
  request_id bigint null,
  operation text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued',
  result jsonb null,
  error_message text null,
  correlation_id text not null default '',
  claimed_at timestamptz null,
  completed_at timestamptz null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_whitelist_agent_jobs_status_check
    check (status in ('queued', 'claimed', 'done', 'failed'))
);

create index if not exists idx_guild_whitelist_agent_jobs_claim
  on public.guild_whitelist_agent_jobs (guild_id, status, created_at);

drop trigger if exists tr_guild_whitelist_settings_updated_at on public.guild_whitelist_settings;
create trigger tr_guild_whitelist_settings_updated_at
before update on public.guild_whitelist_settings
for each row
execute function public.set_updated_at();

drop trigger if exists tr_guild_whitelist_requests_updated_at on public.guild_whitelist_requests;
create trigger tr_guild_whitelist_requests_updated_at
before update on public.guild_whitelist_requests
for each row
execute function public.set_updated_at();

drop trigger if exists tr_guild_whitelist_agent_jobs_updated_at on public.guild_whitelist_agent_jobs;
create trigger tr_guild_whitelist_agent_jobs_updated_at
before update on public.guild_whitelist_agent_jobs
for each row
execute function public.set_updated_at();

alter table public.guild_whitelist_settings enable row level security;
alter table public.guild_whitelist_requests enable row level security;
alter table public.guild_whitelist_audit enable row level security;
alter table public.guild_whitelist_agent_jobs enable row level security;

drop policy if exists "service_role_all_guild_whitelist_settings" on public.guild_whitelist_settings;
create policy "service_role_all_guild_whitelist_settings"
on public.guild_whitelist_settings for all to service_role using (true) with check (true);

drop policy if exists "service_role_all_guild_whitelist_requests" on public.guild_whitelist_requests;
create policy "service_role_all_guild_whitelist_requests"
on public.guild_whitelist_requests for all to service_role using (true) with check (true);

drop policy if exists "service_role_all_guild_whitelist_audit" on public.guild_whitelist_audit;
create policy "service_role_all_guild_whitelist_audit"
on public.guild_whitelist_audit for all to service_role using (true) with check (true);

drop policy if exists "service_role_all_guild_whitelist_agent_jobs" on public.guild_whitelist_agent_jobs;
create policy "service_role_all_guild_whitelist_agent_jobs"
on public.guild_whitelist_agent_jobs for all to service_role using (true) with check (true);

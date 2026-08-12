-- Flowdesk Supabase bootstrap completo
-- Gerado a partir dos migrations sql/001 ate sql/139, com reparo final de auth/avatar no fim.
-- Uso: rode este arquivo inteiro em um projeto Supabase novo.
-- Excluidos de proposito por serem scripts destrutivos/de manutencao, nao bootstrap:
-- - 052_system_wipe.sql
-- - 085_reset_user_1_plan_and_payments.sql
-- - 130_dev_reset_payment_plan_state.sql
-- Nao rode sql/999_wipe_user_data.sql junto.
-- Gerado em: 2026-08-12 10:57:12 -03:00


-- ============================================================================
-- MIGRATION: 001_tickets.sql
-- ============================================================================

do $$
begin
  if not exists (
    select 1
    from pg_type type_def
    join pg_namespace namespace_def
      on namespace_def.oid = type_def.typnamespace
    where type_def.typname = 'ticket_status'
      and namespace_def.nspname = 'public'
  ) then
    create type public.ticket_status as enum ('open', 'closed');
  end if;
end
$$;

create table if not exists public.tickets (
  id bigint generated always as identity primary key,
  protocol text not null unique,
  guild_id text not null,
  channel_id text not null unique,
  user_id text not null,
  status public.ticket_status not null default 'open',
  claimed_by text,
  claimed_at timestamptz,
  closed_by text,
  closed_at timestamptz,
  intro_message_id text,
  transcript_file text,
  opened_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists tr_tickets_updated_at on public.tickets;
create trigger tr_tickets_updated_at
before update on public.tickets
for each row
execute function public.set_updated_at();

create index if not exists idx_tickets_guild_user_status
on public.tickets (guild_id, user_id, status);

create index if not exists idx_tickets_channel_status
on public.tickets (channel_id, status);

create index if not exists idx_tickets_opened_at
on public.tickets (opened_at desc);


-- ============================================================================
-- MIGRATION: 002_ticket_events.sql
-- ============================================================================

create type public.ticket_event_type as enum ('created', 'claimed', 'closed');

create table if not exists public.ticket_events (
  id bigint generated always as identity primary key,
  ticket_id bigint not null references public.tickets(id) on delete cascade,
  protocol text not null,
  guild_id text not null,
  channel_id text not null,
  actor_id text not null,
  event_type public.ticket_event_type not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_ticket_events_ticket_id
on public.ticket_events (ticket_id);

create index if not exists idx_ticket_events_protocol
on public.ticket_events (protocol);

create index if not exists idx_ticket_events_created_at
on public.ticket_events (created_at desc);


-- ============================================================================
-- MIGRATION: 003_rls.sql
-- ============================================================================

alter table public.tickets enable row level security;
alter table public.ticket_events enable row level security;

drop policy if exists "service_role_all_tickets" on public.tickets;
create policy "service_role_all_tickets"
on public.tickets
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_ticket_events" on public.ticket_events;
create policy "service_role_all_ticket_events"
on public.ticket_events
for all
to service_role
using (true)
with check (true);


-- ============================================================================
-- MIGRATION: 004_auth_tables.sql
-- ============================================================================

create extension if not exists pgcrypto;

create table if not exists public.auth_users (
  id bigint generated always as identity primary key,
  discord_user_id text not null unique,
  username text not null,
  global_name text,
  display_name text not null,
  avatar text,
  email text,
  locale text,
  raw_user jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists tr_auth_users_updated_at on public.auth_users;
create trigger tr_auth_users_updated_at
before update on public.auth_users
for each row
execute function public.set_updated_at();

create table if not exists public.auth_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.auth_users(id) on delete cascade,
  session_token_hash text not null unique,
  ip_address text,
  user_agent text,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_auth_sessions_user_id
on public.auth_sessions (user_id);

create index if not exists idx_auth_sessions_expires_at
on public.auth_sessions (expires_at);

create index if not exists idx_auth_sessions_revoked_at
on public.auth_sessions (revoked_at);


-- ============================================================================
-- MIGRATION: 005_auth_rls.sql
-- ============================================================================

alter table public.auth_users enable row level security;
alter table public.auth_sessions enable row level security;

drop policy if exists "service_role_all_auth_users" on public.auth_users;
create policy "service_role_all_auth_users"
on public.auth_users
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_auth_sessions" on public.auth_sessions;
create policy "service_role_all_auth_sessions"
on public.auth_sessions
for all
to service_role
using (true)
with check (true);


-- ============================================================================
-- MIGRATION: 006_auth_session_oauth_tokens.sql
-- ============================================================================

alter table public.auth_sessions
add column if not exists discord_access_token text,
add column if not exists discord_refresh_token text,
add column if not exists discord_token_expires_at timestamptz;

create index if not exists idx_auth_sessions_discord_token_expires_at
on public.auth_sessions (discord_token_expires_at);


-- ============================================================================
-- MIGRATION: 007_auth_user_favorite_guilds.sql
-- ============================================================================

create table if not exists public.auth_user_favorite_guilds (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  guild_id text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, guild_id)
);

create index if not exists idx_auth_user_favorite_guilds_user_sort
on public.auth_user_favorite_guilds (user_id, sort_order);

drop trigger if exists tr_auth_user_favorite_guilds_updated_at on public.auth_user_favorite_guilds;
create trigger tr_auth_user_favorite_guilds_updated_at
before update on public.auth_user_favorite_guilds
for each row
execute function public.set_updated_at();


-- ============================================================================
-- MIGRATION: 008_auth_user_favorite_guilds_rls.sql
-- ============================================================================

alter table public.auth_user_favorite_guilds enable row level security;

drop policy if exists "service_role_all_auth_user_favorite_guilds" on public.auth_user_favorite_guilds;
create policy "service_role_all_auth_user_favorite_guilds"
on public.auth_user_favorite_guilds
for all
to service_role
using (true)
with check (true);


-- ============================================================================
-- MIGRATION: 009_guild_ticket_settings.sql
-- ============================================================================

create table if not exists public.guild_ticket_settings (
  id bigint generated always as identity primary key,
  guild_id text not null unique,
  menu_channel_id text not null,
  tickets_category_id text not null,
  logs_created_channel_id text not null,
  logs_closed_channel_id text not null,
  configured_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists tr_guild_ticket_settings_updated_at on public.guild_ticket_settings;
create trigger tr_guild_ticket_settings_updated_at
before update on public.guild_ticket_settings
for each row
execute function public.set_updated_at();


-- ============================================================================
-- MIGRATION: 010_guild_ticket_settings_rls.sql
-- ============================================================================

alter table public.guild_ticket_settings enable row level security;

drop policy if exists "service_role_all_guild_ticket_settings" on public.guild_ticket_settings;
create policy "service_role_all_guild_ticket_settings"
on public.guild_ticket_settings
for all
to service_role
using (true)
with check (true);


-- ============================================================================
-- MIGRATION: 011_auth_session_config_context_cache.sql
-- ============================================================================

alter table public.auth_sessions
add column if not exists active_guild_id text,
add column if not exists discord_guilds_cache jsonb,
add column if not exists discord_guilds_cached_at timestamptz;

create index if not exists idx_auth_sessions_active_guild_id
on public.auth_sessions (active_guild_id);

create index if not exists idx_auth_sessions_discord_guilds_cached_at
on public.auth_sessions (discord_guilds_cached_at);


-- ============================================================================
-- MIGRATION: 012_guild_ticket_staff_settings.sql
-- ============================================================================

create table if not exists public.guild_ticket_staff_settings (
  id bigint generated always as identity primary key,
  guild_id text not null unique,
  admin_role_id text not null,
  claim_role_ids jsonb not null default '[]'::jsonb,
  close_role_ids jsonb not null default '[]'::jsonb,
  notify_role_ids jsonb not null default '[]'::jsonb,
  configured_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists tr_guild_ticket_staff_settings_updated_at on public.guild_ticket_staff_settings;
create trigger tr_guild_ticket_staff_settings_updated_at
before update on public.guild_ticket_staff_settings
for each row
execute function public.set_updated_at();


-- ============================================================================
-- MIGRATION: 013_guild_ticket_staff_settings_rls.sql
-- ============================================================================

alter table public.guild_ticket_staff_settings enable row level security;

drop policy if exists "service_role_all_guild_ticket_staff_settings" on public.guild_ticket_staff_settings;
create policy "service_role_all_guild_ticket_staff_settings"
on public.guild_ticket_staff_settings
for all
to service_role
using (true)
with check (true);


-- ============================================================================
-- MIGRATION: 014_auth_session_config_progress.sql
-- ============================================================================

alter table public.auth_sessions
add column if not exists config_current_step smallint not null default 1,
add column if not exists config_draft jsonb not null default '{}'::jsonb,
add column if not exists config_context_updated_at timestamptz not null default timezone('utc', now());

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'auth_sessions_config_current_step_check'
      and conrelid = 'public.auth_sessions'::regclass
  ) then
    alter table public.auth_sessions
    add constraint auth_sessions_config_current_step_check
    check (config_current_step between 1 and 4);
  end if;
end $$;

create index if not exists idx_auth_sessions_config_current_step
on public.auth_sessions (config_current_step);

create index if not exists idx_auth_sessions_config_context_updated_at
on public.auth_sessions (config_context_updated_at);


-- ============================================================================
-- MIGRATION: 015_payment_orders.sql
-- ============================================================================

create table if not exists public.payment_orders (
  id bigint generated always as identity primary key,
  order_number bigint generated always as identity (start with 90000 increment by 1) unique,
  user_id bigint not null references public.auth_users(id) on delete restrict,
  guild_id text not null,
  payment_method text not null check (payment_method in ('pix', 'card')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled', 'expired', 'failed')),
  amount numeric(10,2) not null check (amount > 0),
  currency text not null default 'BRL',
  payer_name text,
  payer_document text,
  payer_document_type text check (payer_document_type in ('CPF', 'CNPJ')),
  provider text not null default 'mercado_pago',
  provider_payment_id text,
  provider_external_reference text,
  provider_qr_code text,
  provider_qr_base64 text,
  provider_ticket_url text,
  provider_status text,
  provider_status_detail text,
  provider_payload jsonb not null default '{}'::jsonb,
  paid_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_payment_orders_user_created_at
on public.payment_orders (user_id, created_at desc);

create index if not exists idx_payment_orders_guild_status
on public.payment_orders (guild_id, status);

create index if not exists idx_payment_orders_status_created_at
on public.payment_orders (status, created_at desc);

create unique index if not exists idx_payment_orders_provider_payment_id_unique
on public.payment_orders (provider_payment_id)
where provider_payment_id is not null;

create unique index if not exists idx_payment_orders_provider_external_reference_unique
on public.payment_orders (provider_external_reference)
where provider_external_reference is not null;

drop trigger if exists tr_payment_orders_updated_at on public.payment_orders;
create trigger tr_payment_orders_updated_at
before update on public.payment_orders
for each row
execute function public.set_updated_at();

create table if not exists public.payment_order_events (
  id bigint generated always as identity primary key,
  payment_order_id bigint not null references public.payment_orders(id) on delete cascade,
  event_type text not null,
  event_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_payment_order_events_order_created_at
on public.payment_order_events (payment_order_id, created_at desc);


-- ============================================================================
-- MIGRATION: 016_payment_orders_rls.sql
-- ============================================================================

alter table public.payment_orders enable row level security;
alter table public.payment_order_events enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'drop policy if exists "service_role_all_payment_orders" on public.payment_orders';
    execute 'create policy "service_role_all_payment_orders" on public.payment_orders for all to service_role using (true) with check (true)';
    execute 'drop policy if exists "service_role_all_payment_order_events" on public.payment_order_events';
    execute 'create policy "service_role_all_payment_order_events" on public.payment_order_events for all to service_role using (true) with check (true)';
  end if;
end
$$;


-- ============================================================================
-- MIGRATION: 017_payment_orders_license_guard_indexes.sql
-- ============================================================================

create index if not exists idx_payment_orders_guild_status_paid_at
on public.payment_orders (guild_id, status, paid_at desc);

create index if not exists idx_payment_orders_guild_status_created_at
on public.payment_orders (guild_id, status, created_at desc);


-- ============================================================================
-- MIGRATION: 018_guild_plan_settings.sql
-- ============================================================================

create table if not exists public.guild_plan_settings (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  guild_id text not null,
  plan_code text not null default 'pro',
  monthly_amount numeric(10,2) not null default 9.99 check (monthly_amount > 0),
  currency text not null default 'BRL',
  recurring_enabled boolean not null default false,
  recurring_method_id text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_plan_settings_plan_code_check check (plan_code in ('pro')),
  constraint guild_plan_settings_unique_user_guild unique (user_id, guild_id)
);

create index if not exists idx_guild_plan_settings_user_guild
on public.guild_plan_settings (user_id, guild_id);

create index if not exists idx_guild_plan_settings_recurring_enabled
on public.guild_plan_settings (recurring_enabled);

drop trigger if exists tr_guild_plan_settings_updated_at on public.guild_plan_settings;
create trigger tr_guild_plan_settings_updated_at
before update on public.guild_plan_settings
for each row
execute function public.set_updated_at();


-- ============================================================================
-- MIGRATION: 019_guild_plan_settings_rls.sql
-- ============================================================================

alter table public.guild_plan_settings enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'drop policy if exists "service_role_all_guild_plan_settings" on public.guild_plan_settings';
    execute 'create policy "service_role_all_guild_plan_settings" on public.guild_plan_settings for all to service_role using (true) with check (true)';
  end if;
end
$$;


-- ============================================================================
-- MIGRATION: 020_auth_user_hidden_payment_methods.sql
-- ============================================================================

create table if not exists public.auth_user_hidden_payment_methods (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  method_id text not null,
  deleted_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_user_hidden_payment_methods_unique unique (user_id, method_id)
);

create index if not exists idx_auth_user_hidden_payment_methods_user_id
on public.auth_user_hidden_payment_methods (user_id);

create index if not exists idx_auth_user_hidden_payment_methods_method_id
on public.auth_user_hidden_payment_methods (method_id);

drop trigger if exists tr_auth_user_hidden_payment_methods_updated_at on public.auth_user_hidden_payment_methods;
create trigger tr_auth_user_hidden_payment_methods_updated_at
before update on public.auth_user_hidden_payment_methods
for each row
execute function public.set_updated_at();


-- ============================================================================
-- MIGRATION: 021_auth_user_hidden_payment_methods_rls.sql
-- ============================================================================

alter table public.auth_user_hidden_payment_methods enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'drop policy if exists "service_role_all_auth_user_hidden_payment_methods" on public.auth_user_hidden_payment_methods';
    execute 'create policy "service_role_all_auth_user_hidden_payment_methods" on public.auth_user_hidden_payment_methods for all to service_role using (true) with check (true)';
  end if;
end
$$;


-- ============================================================================
-- MIGRATION: 022_auth_user_payment_methods.sql
-- ============================================================================

create table if not exists public.auth_user_payment_methods (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  method_id text not null,
  nickname text,
  brand text,
  first_six text not null,
  last_four text not null,
  exp_month smallint,
  exp_year smallint,
  provider text not null default 'mercado_pago',
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_user_payment_methods_unique unique (user_id, method_id),
  constraint auth_user_payment_methods_first_six_check check (first_six ~ '^[0-9]{6}$'),
  constraint auth_user_payment_methods_last_four_check check (last_four ~ '^[0-9]{4}$'),
  constraint auth_user_payment_methods_exp_month_check check (exp_month is null or exp_month between 1 and 12),
  constraint auth_user_payment_methods_exp_year_check check (exp_year is null or exp_year between 0 and 9999)
);

create index if not exists idx_auth_user_payment_methods_user_id
on public.auth_user_payment_methods (user_id);

create index if not exists idx_auth_user_payment_methods_is_active
on public.auth_user_payment_methods (is_active);

create index if not exists idx_auth_user_payment_methods_user_active
on public.auth_user_payment_methods (user_id, is_active);

create index if not exists idx_auth_user_payment_methods_method_id
on public.auth_user_payment_methods (method_id);

drop trigger if exists tr_auth_user_payment_methods_updated_at on public.auth_user_payment_methods;
create trigger tr_auth_user_payment_methods_updated_at
before update on public.auth_user_payment_methods
for each row
execute function public.set_updated_at();


-- ============================================================================
-- MIGRATION: 023_auth_user_payment_methods_rls.sql
-- ============================================================================

alter table public.auth_user_payment_methods enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'drop policy if exists "service_role_all_auth_user_payment_methods" on public.auth_user_payment_methods';
    execute 'create policy "service_role_all_auth_user_payment_methods" on public.auth_user_payment_methods for all to service_role using (true) with check (true)';
  end if;
end
$$;


-- ============================================================================
-- MIGRATION: 024_auth_user_payment_methods_verification.sql
-- ============================================================================

alter table public.auth_user_payment_methods
add column if not exists verification_status text not null default 'verified',
add column if not exists verification_status_detail text,
add column if not exists verification_amount numeric(10,2),
add column if not exists verification_provider_payment_id text,
add column if not exists verified_at timestamptz,
add column if not exists last_context_guild_id text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'auth_user_payment_methods_verification_status_check'
      and conrelid = 'public.auth_user_payment_methods'::regclass
  ) then
    alter table public.auth_user_payment_methods
    add constraint auth_user_payment_methods_verification_status_check
    check (verification_status in ('verified', 'pending', 'failed', 'cancelled'));
  end if;
end $$;

update public.auth_user_payment_methods
set verified_at = coalesce(verified_at, created_at)
where verification_status = 'verified'
  and verified_at is null;

create index if not exists idx_auth_user_payment_methods_user_verification_status
on public.auth_user_payment_methods (user_id, verification_status);

create index if not exists idx_auth_user_payment_methods_last_context_guild_id
on public.auth_user_payment_methods (last_context_guild_id);

create unique index if not exists idx_auth_user_payment_methods_verification_provider_payment_id
on public.auth_user_payment_methods (verification_provider_payment_id)
where verification_provider_payment_id is not null;


-- ============================================================================
-- MIGRATION: 025_auth_user_payment_method_verifications.sql
-- ============================================================================

create table if not exists public.auth_user_payment_method_verifications (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  guild_id text not null,
  method_id text not null,
  amount numeric(10,2) not null check (amount > 0),
  currency text not null default 'BRL',
  provider text not null default 'mercado_pago',
  status text not null default 'pending'
    check (status in ('pending', 'verified', 'failed', 'cancelled')),
  payer_name text,
  payer_document text,
  payer_document_type text check (payer_document_type in ('CPF', 'CNPJ')),
  provider_payment_id text,
  provider_external_reference text,
  provider_status text,
  provider_status_detail text,
  provider_payload jsonb not null default '{}'::jsonb,
  verified_at timestamptz,
  refunded_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_auth_user_payment_method_verifications_user_created_at
on public.auth_user_payment_method_verifications (user_id, created_at desc);

create index if not exists idx_auth_user_payment_method_verifications_guild_status
on public.auth_user_payment_method_verifications (guild_id, status);

create index if not exists idx_auth_user_payment_method_verifications_method_id
on public.auth_user_payment_method_verifications (method_id);

create unique index if not exists idx_auth_user_payment_method_verifications_provider_payment_id
on public.auth_user_payment_method_verifications (provider_payment_id)
where provider_payment_id is not null;

create unique index if not exists idx_auth_user_payment_method_verifications_provider_external_reference
on public.auth_user_payment_method_verifications (provider_external_reference)
where provider_external_reference is not null;

drop trigger if exists tr_auth_user_payment_method_verifications_updated_at on public.auth_user_payment_method_verifications;
create trigger tr_auth_user_payment_method_verifications_updated_at
before update on public.auth_user_payment_method_verifications
for each row
execute function public.set_updated_at();


-- ============================================================================
-- MIGRATION: 026_auth_user_payment_method_verifications_rls.sql
-- ============================================================================

alter table public.auth_user_payment_method_verifications enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'drop policy if exists "service_role_all_auth_user_payment_method_verifications" on public.auth_user_payment_method_verifications';
    execute 'create policy "service_role_all_auth_user_payment_method_verifications" on public.auth_user_payment_method_verifications for all to service_role using (true) with check (true)';
  end if;
end
$$;


-- ============================================================================
-- MIGRATION: 027_auth_security_events.sql
-- ============================================================================

create table if not exists public.auth_security_events (
  id bigint generated always as identity primary key,
  request_id text not null,
  session_id uuid references public.auth_sessions(id) on delete set null,
  user_id bigint references public.auth_users(id) on delete set null,
  guild_id text,
  action text not null,
  outcome text not null
    check (outcome in ('started', 'succeeded', 'failed', 'blocked')),
  request_method text not null,
  request_path text not null,
  ip_fingerprint text,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_auth_security_events_request_id
on public.auth_security_events (request_id);

create index if not exists idx_auth_security_events_action_created_at
on public.auth_security_events (action, created_at desc);

create index if not exists idx_auth_security_events_session_action_created_at
on public.auth_security_events (session_id, action, created_at desc);

create index if not exists idx_auth_security_events_user_action_created_at
on public.auth_security_events (user_id, action, created_at desc);

create index if not exists idx_auth_security_events_ip_action_created_at
on public.auth_security_events (ip_fingerprint, action, created_at desc);


-- ============================================================================
-- MIGRATION: 028_auth_security_events_rls.sql
-- ============================================================================

alter table public.auth_security_events enable row level security;

drop policy if exists "service_role_all_auth_security_events" on public.auth_security_events;
create policy "service_role_all_auth_security_events"
on public.auth_security_events
for all
to service_role
using (true)
with check (true);


-- ============================================================================
-- MIGRATION: 029_payment_orders_reconciliation_indexes.sql
-- ============================================================================

create index if not exists idx_payment_orders_provider_payment_id
on public.payment_orders (provider_payment_id)
where provider_payment_id is not null;

create index if not exists idx_payment_orders_reconcile_status_updated_at
on public.payment_orders (status, updated_at desc)
where provider_payment_id is not null
  and status in ('pending', 'failed', 'expired', 'rejected');


-- ============================================================================
-- MIGRATION: 030_auth_user_payment_methods_provider_vault.sql
-- ============================================================================

alter table public.auth_user_payment_methods
add column if not exists provider_customer_id text,
add column if not exists provider_card_id text;

create index if not exists idx_auth_user_payment_methods_provider_customer_id
on public.auth_user_payment_methods (provider_customer_id)
where provider_customer_id is not null;

create unique index if not exists idx_auth_user_payment_methods_provider_card_id
on public.auth_user_payment_methods (provider_card_id)
where provider_card_id is not null;


-- ============================================================================
-- MIGRATION: 031_payment_orders_checkout_link_security.sql
-- ============================================================================

alter table public.payment_orders
add column if not exists checkout_link_nonce text,
add column if not exists checkout_link_expires_at timestamptz,
add column if not exists checkout_link_invalidated_at timestamptz;

create index if not exists idx_payment_orders_checkout_link_expires_at
on public.payment_orders (checkout_link_expires_at)
where checkout_link_expires_at is not null;

create index if not exists idx_payment_orders_checkout_link_invalidated_at
on public.payment_orders (checkout_link_invalidated_at)
where checkout_link_invalidated_at is not null;

create index if not exists idx_payment_orders_user_guild_checkout_link
on public.payment_orders (user_id, guild_id, updated_at desc);


-- ============================================================================
-- MIGRATION: 032_payment_orders_unpaid_setup_cleanup_indexes.sql
-- ============================================================================

create index if not exists idx_payment_orders_unpaid_setup_user_status_created_at
on public.payment_orders (user_id, status, created_at desc)
where status in ('pending', 'failed', 'rejected', 'cancelled', 'expired');

create index if not exists idx_payment_orders_unpaid_setup_guild_status_created_at
on public.payment_orders (guild_id, status, created_at desc)
where status in ('pending', 'failed', 'rejected', 'cancelled', 'expired');


-- ============================================================================
-- MIGRATION: 033_auth_user_discord_links.sql
-- ============================================================================

create table if not exists public.auth_user_discord_links (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  discord_user_id text not null,
  guild_id text not null,
  channel_id text,
  role_id text not null,
  status text not null default 'pending',
  linked_at timestamptz,
  role_granted_at timestamptz,
  last_role_sync_at timestamptz,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_user_discord_links_user_guild_unique unique (user_id, guild_id),
  constraint auth_user_discord_links_discord_guild_unique unique (discord_user_id, guild_id),
  constraint auth_user_discord_links_status_check check (
    status in ('pending', 'pending_member', 'linked', 'failed')
  )
);

create index if not exists idx_auth_user_discord_links_user_id
on public.auth_user_discord_links (user_id);

create index if not exists idx_auth_user_discord_links_guild_id
on public.auth_user_discord_links (guild_id);

create index if not exists idx_auth_user_discord_links_status
on public.auth_user_discord_links (status);

create index if not exists idx_auth_user_discord_links_discord_user_id
on public.auth_user_discord_links (discord_user_id);

drop trigger if exists tr_auth_user_discord_links_updated_at on public.auth_user_discord_links;
create trigger tr_auth_user_discord_links_updated_at
before update on public.auth_user_discord_links
for each row
execute function public.set_updated_at();


-- ============================================================================
-- MIGRATION: 034_auth_user_discord_links_rls.sql
-- ============================================================================

alter table public.auth_user_discord_links enable row level security;

drop policy if exists "service_role_all_auth_user_discord_links" on public.auth_user_discord_links;
create policy "service_role_all_auth_user_discord_links"
on public.auth_user_discord_links
for all
to service_role
using (true)
with check (true);


-- ============================================================================
-- MIGRATION: 034_auth_user_teams.sql
-- ============================================================================

create table if not exists public.auth_user_teams (
  id bigint generated always as identity primary key,
  owner_user_id bigint not null references public.auth_users(id) on delete cascade,
  name text not null,
  icon_key text not null default 'aurora',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_auth_user_teams_owner_user_id
on public.auth_user_teams (owner_user_id);

drop trigger if exists tr_auth_user_teams_updated_at on public.auth_user_teams;
create trigger tr_auth_user_teams_updated_at
before update on public.auth_user_teams
for each row
execute function public.set_updated_at();

create table if not exists public.auth_user_team_servers (
  id bigint generated always as identity primary key,
  team_id bigint not null references public.auth_user_teams(id) on delete cascade,
  guild_id text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (team_id, guild_id)
);

create index if not exists idx_auth_user_team_servers_team_id
on public.auth_user_team_servers (team_id);

create index if not exists idx_auth_user_team_servers_guild_id
on public.auth_user_team_servers (guild_id);

drop trigger if exists tr_auth_user_team_servers_updated_at on public.auth_user_team_servers;
create trigger tr_auth_user_team_servers_updated_at
before update on public.auth_user_team_servers
for each row
execute function public.set_updated_at();

create table if not exists public.auth_user_team_members (
  id bigint generated always as identity primary key,
  team_id bigint not null references public.auth_user_teams(id) on delete cascade,
  invited_discord_user_id text not null,
  invited_auth_user_id bigint references public.auth_users(id) on delete set null,
  invited_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  accepted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (team_id, invited_discord_user_id)
);

create index if not exists idx_auth_user_team_members_team_id
on public.auth_user_team_members (team_id);

create index if not exists idx_auth_user_team_members_invited_discord_user_id
on public.auth_user_team_members (invited_discord_user_id);

create index if not exists idx_auth_user_team_members_invited_auth_user_id
on public.auth_user_team_members (invited_auth_user_id);

create index if not exists idx_auth_user_team_members_status
on public.auth_user_team_members (status);

drop trigger if exists tr_auth_user_team_members_updated_at on public.auth_user_team_members;
create trigger tr_auth_user_team_members_updated_at
before update on public.auth_user_team_members
for each row
execute function public.set_updated_at();


-- ============================================================================
-- MIGRATION: 035_auth_user_teams_rls.sql
-- ============================================================================

alter table public.auth_user_teams enable row level security;
alter table public.auth_user_team_servers enable row level security;
alter table public.auth_user_team_members enable row level security;

drop policy if exists "service_role_all_auth_user_teams" on public.auth_user_teams;
create policy "service_role_all_auth_user_teams"
on public.auth_user_teams
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_auth_user_team_servers" on public.auth_user_team_servers;
create policy "service_role_all_auth_user_team_servers"
on public.auth_user_team_servers
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_auth_user_team_members" on public.auth_user_team_members;
create policy "service_role_all_auth_user_team_members"
on public.auth_user_team_members
for all
to service_role
using (true)
with check (true);


-- ============================================================================
-- MIGRATION: 036_auth_user_teams_icon_key.sql
-- ============================================================================

alter table public.auth_user_teams
add column if not exists icon_key text not null default 'aurora';


-- ============================================================================
-- MIGRATION: 037_auth_user_team_servers_unique_guild.sql
-- ============================================================================

do $$
begin
  if exists (
    select 1
    from public.auth_user_team_servers
    group by guild_id
    having count(*) > 1
  ) then
    raise exception 'Existem servidores vinculados a mais de uma equipe. Limpe os duplicados antes de aplicar a restricao unica por guild.';
  end if;
end $$;

create unique index if not exists idx_auth_user_team_servers_guild_id_unique
on public.auth_user_team_servers (guild_id);


-- ============================================================================
-- MIGRATION: 038_guild_ticket_settings_panel_message.sql
-- ============================================================================

alter table public.guild_ticket_settings
add column if not exists panel_title text not null default 'Abrir atendimento',
add column if not exists panel_description text not null default 'Escolha uma opcao abaixo para falar com a equipe responsavel.',
add column if not exists panel_button_label text not null default 'Abrir ticket';


-- ============================================================================
-- MIGRATION: 039_guild_ticket_settings_panel_layout.sql
-- ============================================================================

alter table public.guild_ticket_settings
add column if not exists panel_layout jsonb not null default '[]'::jsonb;


-- ============================================================================
-- MIGRATION: 040_guild_ticket_settings_panel_message_id.sql
-- ============================================================================

alter table public.guild_ticket_settings
add column if not exists panel_message_id text null;


-- ============================================================================
-- MIGRATION: 041_tickets_opened_reason.sql
-- ============================================================================

alter table public.tickets
add column if not exists opened_reason text not null default '';


-- ============================================================================
-- MIGRATION: 042_ticket_transcripts.sql
-- ============================================================================

create table if not exists public.ticket_transcripts (
  id bigint generated always as identity primary key,
  ticket_id bigint not null references public.tickets(id) on delete cascade,
  protocol text not null unique,
  guild_id text not null,
  channel_id text not null,
  user_id text not null,
  closed_by text not null,
  transcript_html text not null,
  access_code_hash text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists idx_ticket_transcripts_ticket_id_unique
on public.ticket_transcripts (ticket_id);

create index if not exists idx_ticket_transcripts_protocol
on public.ticket_transcripts (protocol);

create index if not exists idx_ticket_transcripts_user_id
on public.ticket_transcripts (user_id);

drop trigger if exists tr_ticket_transcripts_updated_at on public.ticket_transcripts;
create trigger tr_ticket_transcripts_updated_at
before update on public.ticket_transcripts
for each row
execute function public.set_updated_at();


-- ============================================================================
-- MIGRATION: 043_ticket_dm_queue.sql
-- ============================================================================

create table if not exists public.ticket_dm_queue (
  id bigint generated always as identity primary key,
  notification_key text not null unique,
  kind text not null,
  ticket_id bigint null references public.tickets(id) on delete cascade,
  protocol text not null,
  guild_id text not null,
  user_id text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  max_attempts integer not null default 12,
  next_attempt_at timestamptz not null default timezone('utc', now()),
  last_error text null,
  dm_channel_id text null,
  delivered_message_id text null,
  sent_at timestamptz null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_ticket_dm_queue_status_next_attempt
on public.ticket_dm_queue (status, next_attempt_at);

create index if not exists idx_ticket_dm_queue_user_id
on public.ticket_dm_queue (user_id);

create index if not exists idx_ticket_dm_queue_ticket_id
on public.ticket_dm_queue (ticket_id);

drop trigger if exists tr_ticket_dm_queue_updated_at on public.ticket_dm_queue;
create trigger tr_ticket_dm_queue_updated_at
before update on public.ticket_dm_queue
for each row
execute function public.set_updated_at();


-- ============================================================================
-- MIGRATION: 044_payment_discounts.sql
-- ============================================================================

create table if not exists public.payment_coupons (
  id bigint generated always as identity primary key,
  code text not null unique,
  label text not null,
  description text,
  status text not null default 'active' check (status in ('draft', 'active', 'inactive', 'expired')),
  discount_type text not null check (discount_type in ('fixed', 'percent')),
  discount_value numeric(10,2) not null check (discount_value > 0),
  max_redemptions integer check (max_redemptions is null or max_redemptions > 0),
  starts_at timestamptz,
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_payment_coupons_code
on public.payment_coupons (code);

create index if not exists idx_payment_coupons_status
on public.payment_coupons (status, expires_at);

drop trigger if exists tr_payment_coupons_updated_at on public.payment_coupons;
create trigger tr_payment_coupons_updated_at
before update on public.payment_coupons
for each row
execute function public.set_updated_at();

create table if not exists public.payment_coupon_redemptions (
  id bigint generated always as identity primary key,
  coupon_id bigint not null references public.payment_coupons(id) on delete cascade,
  payment_order_id bigint references public.payment_orders(id) on delete set null,
  guild_id text,
  user_id bigint references public.auth_users(id) on delete set null,
  discount_amount numeric(10,2) not null default 0 check (discount_amount >= 0),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_payment_coupon_redemptions_coupon
on public.payment_coupon_redemptions (coupon_id, created_at desc);

create table if not exists public.payment_gift_cards (
  id bigint generated always as identity primary key,
  code text not null unique,
  label text not null,
  description text,
  status text not null default 'active' check (status in ('draft', 'active', 'inactive', 'exhausted', 'expired')),
  initial_amount numeric(10,2) not null check (initial_amount >= 0),
  remaining_amount numeric(10,2) not null check (remaining_amount >= 0),
  currency text not null default 'BRL',
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_payment_gift_cards_code
on public.payment_gift_cards (code);

create index if not exists idx_payment_gift_cards_status
on public.payment_gift_cards (status, expires_at);

drop trigger if exists tr_payment_gift_cards_updated_at on public.payment_gift_cards;
create trigger tr_payment_gift_cards_updated_at
before update on public.payment_gift_cards
for each row
execute function public.set_updated_at();

create table if not exists public.payment_gift_card_redemptions (
  id bigint generated always as identity primary key,
  gift_card_id bigint not null references public.payment_gift_cards(id) on delete cascade,
  payment_order_id bigint references public.payment_orders(id) on delete set null,
  guild_id text,
  user_id bigint references public.auth_users(id) on delete set null,
  redeemed_amount numeric(10,2) not null default 0 check (redeemed_amount >= 0),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_payment_gift_card_redemptions_card
on public.payment_gift_card_redemptions (gift_card_id, created_at desc);

alter table public.payment_coupons enable row level security;
alter table public.payment_coupon_redemptions enable row level security;
alter table public.payment_gift_cards enable row level security;
alter table public.payment_gift_card_redemptions enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'drop policy if exists "service_role_all_payment_coupons" on public.payment_coupons';
    execute 'create policy "service_role_all_payment_coupons" on public.payment_coupons for all to service_role using (true) with check (true)';
    execute 'drop policy if exists "service_role_all_payment_coupon_redemptions" on public.payment_coupon_redemptions';
    execute 'create policy "service_role_all_payment_coupon_redemptions" on public.payment_coupon_redemptions for all to service_role using (true) with check (true)';
    execute 'drop policy if exists "service_role_all_payment_gift_cards" on public.payment_gift_cards';
    execute 'create policy "service_role_all_payment_gift_cards" on public.payment_gift_cards for all to service_role using (true) with check (true)';
    execute 'drop policy if exists "service_role_all_payment_gift_card_redemptions" on public.payment_gift_card_redemptions';
    execute 'create policy "service_role_all_payment_gift_card_redemptions" on public.payment_gift_card_redemptions for all to service_role using (true) with check (true)';
  end if;
end
$$;


-- ============================================================================
-- MIGRATION: 045_plan_system.sql
-- ============================================================================

alter table public.guild_plan_settings
drop constraint if exists guild_plan_settings_plan_code_check;

alter table public.guild_plan_settings
drop constraint if exists guild_plan_settings_monthly_amount_check;

alter table public.guild_plan_settings
add constraint guild_plan_settings_plan_code_check
check (plan_code in ('basic', 'pro', 'ultra', 'master'));

alter table public.guild_plan_settings
add constraint guild_plan_settings_monthly_amount_check
check (monthly_amount >= 0);

alter table public.payment_orders
drop constraint if exists payment_orders_payment_method_check;

alter table public.payment_orders
drop constraint if exists payment_orders_amount_check;

alter table public.payment_orders
add constraint payment_orders_payment_method_check
check (payment_method in ('pix', 'card', 'trial'));

alter table public.payment_orders
add constraint payment_orders_amount_check
check (amount >= 0);

alter table public.payment_orders
add column if not exists plan_code text not null default 'pro';

alter table public.payment_orders
add column if not exists plan_name text not null default 'Flow Pro';

alter table public.payment_orders
add column if not exists plan_billing_cycle_days integer not null default 30;

alter table public.payment_orders
add column if not exists plan_max_licensed_servers integer not null default 1;

alter table public.payment_orders
add column if not exists plan_max_active_tickets integer not null default 50;

alter table public.payment_orders
add column if not exists plan_max_automations integer not null default 2;

alter table public.payment_orders
add column if not exists plan_max_monthly_actions integer not null default 1000;

update public.payment_orders
set
  plan_code = coalesce(nullif(plan_code, ''), 'pro'),
  plan_name = coalesce(nullif(plan_name, ''), 'Flow Pro'),
  plan_billing_cycle_days = greatest(coalesce(plan_billing_cycle_days, 30), 1),
  plan_max_licensed_servers = greatest(coalesce(plan_max_licensed_servers, 1), 1),
  plan_max_active_tickets = greatest(coalesce(plan_max_active_tickets, 50), 0),
  plan_max_automations = greatest(coalesce(plan_max_automations, 2), 0),
  plan_max_monthly_actions = greatest(coalesce(plan_max_monthly_actions, 1000), 0);

create table if not exists public.auth_user_plan_state (
  user_id bigint primary key references public.auth_users(id) on delete cascade,
  plan_code text not null default 'pro',
  plan_name text not null default 'Flow Pro',
  status text not null default 'inactive' check (status in ('inactive', 'trial', 'active', 'expired')),
  amount numeric(10,2) not null default 0 check (amount >= 0),
  compare_amount numeric(10,2) not null default 0 check (compare_amount >= 0),
  currency text not null default 'BRL',
  billing_cycle_days integer not null default 30 check (billing_cycle_days > 0),
  max_licensed_servers integer not null default 1 check (max_licensed_servers > 0),
  max_active_tickets integer not null default 0 check (max_active_tickets >= 0),
  max_automations integer not null default 0 check (max_automations >= 0),
  max_monthly_actions integer not null default 0 check (max_monthly_actions >= 0),
  last_payment_order_id bigint references public.payment_orders(id) on delete set null,
  last_payment_guild_id text,
  activated_at timestamptz,
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_user_plan_state_plan_code_check check (plan_code in ('basic', 'pro', 'ultra', 'master'))
);

create index if not exists idx_auth_user_plan_state_status
on public.auth_user_plan_state (status, expires_at);

drop trigger if exists tr_auth_user_plan_state_updated_at on public.auth_user_plan_state;
create trigger tr_auth_user_plan_state_updated_at
before update on public.auth_user_plan_state
for each row
execute function public.set_updated_at();

alter table public.auth_user_plan_state enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'drop policy if exists "service_role_all_auth_user_plan_state" on public.auth_user_plan_state';
    execute 'create policy "service_role_all_auth_user_plan_state" on public.auth_user_plan_state for all to service_role using (true) with check (true)';
  end if;
end
$$;


-- ============================================================================
-- MIGRATION: 046_guild_welcome_settings.sql
-- ============================================================================

create table if not exists public.guild_welcome_settings (
  id bigint generated always as identity primary key,
  guild_id text not null unique,
  enabled boolean not null default false,
  entry_public_channel_id text null,
  entry_log_channel_id text null,
  exit_public_channel_id text null,
  exit_log_channel_id text null,
  entry_layout jsonb not null default '[]'::jsonb,
  exit_layout jsonb not null default '[]'::jsonb,
  entry_thumbnail_mode text not null default 'custom',
  exit_thumbnail_mode text not null default 'custom',
  configured_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists tr_guild_welcome_settings_updated_at on public.guild_welcome_settings;
create trigger tr_guild_welcome_settings_updated_at
before update on public.guild_welcome_settings
for each row
execute function public.set_updated_at();


-- ============================================================================
-- MIGRATION: 047_guild_welcome_settings_rls.sql
-- ============================================================================

alter table public.guild_welcome_settings enable row level security;

drop policy if exists "service_role_all_guild_welcome_settings" on public.guild_welcome_settings;
create policy "service_role_all_guild_welcome_settings"
on public.guild_welcome_settings
for all
to service_role
using (true)
with check (true);


-- ============================================================================
-- MIGRATION: 048_ticket_ai_support.sql
-- ============================================================================

create table if not exists public.ticket_ai_sessions (
  ticket_id bigint primary key references public.tickets(id) on delete cascade,
  protocol text not null,
  guild_id text not null,
  channel_id text not null,
  user_id text not null,
  status text not null default 'active',
  handoff_reason text null,
  handed_off_by text null,
  handed_off_at timestamptz null,
  last_ai_reply_at timestamptz null,
  last_user_message_at timestamptz null,
  last_staff_message_at timestamptz null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint ticket_ai_sessions_status_check
    check (status in ('active', 'handoff', 'closed'))
);

drop trigger if exists tr_ticket_ai_sessions_updated_at on public.ticket_ai_sessions;
create trigger tr_ticket_ai_sessions_updated_at
before update on public.ticket_ai_sessions
for each row
execute function public.set_updated_at();

create index if not exists idx_ticket_ai_sessions_status
on public.ticket_ai_sessions (status, updated_at desc);

create table if not exists public.ticket_ai_messages (
  id bigint generated always as identity primary key,
  ticket_id bigint not null references public.tickets(id) on delete cascade,
  protocol text not null,
  guild_id text not null,
  channel_id text not null,
  author_id text null,
  author_type text not null,
  source text not null default 'ticket_ai',
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  constraint ticket_ai_messages_author_type_check
    check (author_type in ('user', 'assistant', 'staff', 'system'))
);

create index if not exists idx_ticket_ai_messages_ticket_id
on public.ticket_ai_messages (ticket_id, created_at desc);

create index if not exists idx_ticket_ai_messages_protocol
on public.ticket_ai_messages (protocol, created_at desc);


-- ============================================================================
-- MIGRATION: 049_ticket_ai_support_rls.sql
-- ============================================================================

alter table public.ticket_ai_sessions enable row level security;
alter table public.ticket_ai_messages enable row level security;

drop policy if exists "service_role_all_ticket_ai_sessions" on public.ticket_ai_sessions;
create policy "service_role_all_ticket_ai_sessions"
on public.ticket_ai_sessions
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_ticket_ai_messages" on public.ticket_ai_messages;
create policy "service_role_all_ticket_ai_messages"
on public.ticket_ai_messages
for all
to service_role
using (true)
with check (true);


-- ============================================================================
-- MIGRATION: 050_user_plan_guilds.sql
-- ============================================================================

create table if not exists public.auth_user_plan_guilds (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  guild_id text not null,
  activated_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_user_plan_guilds_unique_user_guild unique (user_id, guild_id),
  constraint auth_user_plan_guilds_unique_guild unique (guild_id)
);

create index if not exists idx_auth_user_plan_guilds_user_activated
on public.auth_user_plan_guilds (user_id, activated_at desc);

create index if not exists idx_auth_user_plan_guilds_guild
on public.auth_user_plan_guilds (guild_id);

drop trigger if exists tr_auth_user_plan_guilds_updated_at on public.auth_user_plan_guilds;
create trigger tr_auth_user_plan_guilds_updated_at
before update on public.auth_user_plan_guilds
for each row
execute function public.set_updated_at();

alter table public.auth_user_plan_guilds enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'drop policy if exists "service_role_all_auth_user_plan_guilds" on public.auth_user_plan_guilds';
    execute 'create policy "service_role_all_auth_user_plan_guilds" on public.auth_user_plan_guilds for all to service_role using (true) with check (true)';
  end if;
end
$$;


-- ============================================================================
-- MIGRATION: 051_plan_cycle_duration_fix.sql
-- ============================================================================

begin;

alter table public.payment_orders
  alter column plan_billing_cycle_days drop default;

alter table public.auth_user_plan_state
  alter column billing_cycle_days drop default;

with resolved_cycles as (
  select
    po.id,
    greatest(
      coalesce(
        case
          when coalesce(po.provider_payload -> 'plan' ->> 'billingCycleDays', '') ~ '^\d+$'
            then (po.provider_payload -> 'plan' ->> 'billingCycleDays')::integer
          else null
        end,
        case
          when lower(coalesce(po.plan_code, '')) = 'basic' then 7
          else null
        end,
        nullif(po.plan_billing_cycle_days, 0),
        case lower(coalesce(po.plan_code, ''))
          when 'pro' then 30
          when 'ultra' then 30
          when 'master' then 30
          else 30
        end
      ),
      1
    ) as resolved_billing_cycle_days
  from public.payment_orders po
)
update public.payment_orders as po
set plan_billing_cycle_days = rc.resolved_billing_cycle_days
from resolved_cycles rc
where po.id = rc.id
  and po.plan_billing_cycle_days is distinct from rc.resolved_billing_cycle_days;

with approved_orders as (
  select
    po.id,
    coalesce(po.paid_at, po.created_at) as base_timestamp,
    greatest(coalesce(po.plan_billing_cycle_days, 1), 1) as billing_cycle_days
  from public.payment_orders po
  where po.status = 'approved'
),
resolved_expiration as (
  select
    ao.id,
    case
      when ao.billing_cycle_days = 30 then ao.base_timestamp + interval '1 month'
      when ao.billing_cycle_days = 90 then ao.base_timestamp + interval '3 months'
      when ao.billing_cycle_days = 180 then ao.base_timestamp + interval '6 months'
      when ao.billing_cycle_days = 365 then ao.base_timestamp + interval '1 year'
      else ao.base_timestamp + make_interval(days => ao.billing_cycle_days)
    end as resolved_expires_at
  from approved_orders ao
)
update public.payment_orders as po
set expires_at = re.resolved_expires_at
from resolved_expiration re
where po.id = re.id
  and po.expires_at is distinct from re.resolved_expires_at;

with ranked_orders as (
  select
    po.user_id,
    po.plan_code,
    greatest(coalesce(po.plan_billing_cycle_days, 1), 1) as billing_cycle_days,
    coalesce(po.paid_at, po.created_at) as activated_at,
    po.expires_at,
    row_number() over (
      partition by po.user_id
      order by coalesce(po.paid_at, po.created_at) desc, po.created_at desc, po.id desc
    ) as row_number
  from public.payment_orders po
  where po.status = 'approved'
),
latest_orders as (
  select
    ro.user_id,
    ro.plan_code,
    ro.billing_cycle_days,
    ro.activated_at,
    ro.expires_at
  from ranked_orders ro
  where ro.row_number = 1
)
update public.auth_user_plan_state as ups
set billing_cycle_days = lo.billing_cycle_days,
    activated_at = lo.activated_at,
    expires_at = lo.expires_at,
    status = case
      when lo.expires_at is not null and lo.expires_at < now() then 'expired'
      when lower(coalesce(lo.plan_code, '')) = 'basic' then 'trial'
      else 'active'
    end,
    metadata = jsonb_set(
      coalesce(ups.metadata, '{}'::jsonb),
      '{plan,billingCycleDays}',
      to_jsonb(lo.billing_cycle_days),
      true
    )
from latest_orders lo
where ups.user_id = lo.user_id
  and (
    ups.billing_cycle_days is distinct from lo.billing_cycle_days or
    ups.activated_at is distinct from lo.activated_at or
    ups.expires_at is distinct from lo.expires_at or
    ups.status is distinct from case
      when lo.expires_at is not null and lo.expires_at < now() then 'expired'
      when lower(coalesce(lo.plan_code, '')) = 'basic' then 'trial'
      else 'active'
    end
  );

commit;


-- ============================================================================
-- MIGRATION: 053_beta_coupon.sql
-- ============================================================================

begin;

alter table public.payment_coupons
  drop constraint if exists payment_coupons_discount_value_check;

alter table public.payment_coupons
  add constraint payment_coupons_discount_value_check
  check (discount_value >= 0);

insert into public.payment_coupons (
  code,
  label,
  description,
  status,
  discount_type,
  discount_value,
  metadata
)
values (
  'BETA',
  'Programa Beta',
  'Ativa o status beta da conta sem alterar o valor do checkout. Mantem o Flow PRO mensal em R$ 9,99 para a conta beta.',
  'active',
  'fixed',
  0.00,
  jsonb_build_object(
    'betaProgram', true,
    'onePerUser', true,
    'allowedPlanCodes', jsonb_build_array('pro'),
    'allowedBillingPeriodCodes', jsonb_build_array('monthly'),
    'pinnedMonthlyAmount', 9.99
  )
)
on conflict (code) do update
set
  label = excluded.label,
  description = excluded.description,
  status = excluded.status,
  discount_type = excluded.discount_type,
  discount_value = excluded.discount_value,
  metadata = excluded.metadata,
  updated_at = timezone('utc', now());

commit;


-- ============================================================================
-- MIGRATION: 053_guild_antilink_settings.sql
-- ============================================================================

create table if not exists public.guild_antilink_settings (
  id bigint generated always as identity primary key,
  guild_id text not null unique,
  enabled boolean not null default false,
  log_channel_id text null,
  enforcement_action text not null default 'delete_only',
  timeout_minutes integer not null default 10,
  ignored_role_ids text[] not null default '{}'::text[],
  block_external_links boolean not null default true,
  block_discord_invites boolean not null default true,
  block_obfuscated_links boolean not null default true,
  configured_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_antilink_settings_action_check
    check (enforcement_action in ('delete_only', 'timeout', 'kick', 'ban')),
  constraint guild_antilink_settings_timeout_check
    check (timeout_minutes between 1 and 10080)
);

drop trigger if exists tr_guild_antilink_settings_updated_at on public.guild_antilink_settings;
create trigger tr_guild_antilink_settings_updated_at
before update on public.guild_antilink_settings
for each row
execute function public.set_updated_at();


-- ============================================================================
-- MIGRATION: 054_guild_antilink_settings_rls.sql
-- ============================================================================

alter table public.guild_antilink_settings enable row level security;

drop policy if exists "service_role_all_guild_antilink_settings" on public.guild_antilink_settings;
create policy "service_role_all_guild_antilink_settings"
on public.guild_antilink_settings
for all
to service_role
using (true)
with check (true);


-- ============================================================================
-- MIGRATION: 055_guild_security_logs_settings.sql
-- ============================================================================

create table if not exists public.guild_security_logs_settings (
  id bigint generated always as identity primary key,
  guild_id text not null unique,
  nickname_change_enabled boolean not null default false,
  nickname_change_channel_id text null,
  avatar_change_enabled boolean not null default false,
  avatar_change_channel_id text null,
  voice_join_enabled boolean not null default false,
  voice_join_channel_id text null,
  voice_leave_enabled boolean not null default false,
  voice_leave_channel_id text null,
  message_delete_enabled boolean not null default false,
  message_delete_channel_id text null,
  message_edit_enabled boolean not null default false,
  message_edit_channel_id text null,
  member_ban_enabled boolean not null default false,
  member_ban_channel_id text null,
  member_unban_enabled boolean not null default false,
  member_unban_channel_id text null,
  member_kick_enabled boolean not null default false,
  member_kick_channel_id text null,
  member_timeout_enabled boolean not null default false,
  member_timeout_channel_id text null,
  voice_move_enabled boolean not null default false,
  voice_move_channel_id text null,
  voice_mute_enabled boolean not null default false,
  voice_mute_channel_id text null,
  configured_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists tr_guild_security_logs_settings_updated_at on public.guild_security_logs_settings;
create trigger tr_guild_security_logs_settings_updated_at
before update on public.guild_security_logs_settings
for each row
execute function public.set_updated_at();


-- ============================================================================
-- MIGRATION: 056_guild_security_logs_settings_rls.sql
-- ============================================================================

alter table public.guild_security_logs_settings enable row level security;

drop policy if exists "service_role_all_guild_security_logs_settings" on public.guild_security_logs_settings;
create policy "service_role_all_guild_security_logs_settings"
on public.guild_security_logs_settings
for all
to service_role
using (true)
with check (true);


-- ============================================================================
-- MIGRATION: 057_guild_ticket_settings_enabled.sql
-- ============================================================================

alter table public.guild_ticket_settings
add column if not exists enabled boolean not null default false;


-- ============================================================================
-- MIGRATION: 058_guild_security_logs_module_defaults.sql
-- ============================================================================

alter table public.guild_security_logs_settings
add column if not exists enabled boolean not null default false,
add column if not exists use_default_channel boolean not null default false,
add column if not exists default_channel_id text null;

update public.guild_security_logs_settings
set enabled = true
where
  enabled = false
  and (
    nickname_change_enabled = true
    or avatar_change_enabled = true
    or voice_join_enabled = true
    or voice_leave_enabled = true
    or message_delete_enabled = true
    or message_edit_enabled = true
    or member_ban_enabled = true
    or member_unban_enabled = true
    or member_kick_enabled = true
    or member_timeout_enabled = true
    or voice_move_enabled = true
  );


-- ============================================================================
-- MIGRATION: 059_plan_transitions_flow_points.sql
-- ============================================================================

create table if not exists public.auth_user_plan_flow_points (
  user_id bigint primary key references public.auth_users(id) on delete cascade,
  currency text not null default 'BRL',
  balance_amount numeric(12,2) not null default 0 check (balance_amount >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists tr_auth_user_plan_flow_points_updated_at on public.auth_user_plan_flow_points;
create trigger tr_auth_user_plan_flow_points_updated_at
before update on public.auth_user_plan_flow_points
for each row
execute function public.set_updated_at();

alter table public.auth_user_plan_flow_points enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'drop policy if exists "service_role_all_auth_user_plan_flow_points" on public.auth_user_plan_flow_points';
    execute 'create policy "service_role_all_auth_user_plan_flow_points" on public.auth_user_plan_flow_points for all to service_role using (true) with check (true)';
  end if;
end
$$;

create table if not exists public.auth_user_plan_flow_point_events (
  id bigserial primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  payment_order_id bigint references public.payment_orders(id) on delete set null,
  event_type text not null,
  amount numeric(12,2) not null,
  currency text not null default 'BRL',
  balance_after numeric(12,2) not null check (balance_after >= 0),
  reference_key text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists idx_auth_user_plan_flow_point_events_reference_key
on public.auth_user_plan_flow_point_events (reference_key)
where reference_key is not null;

create index if not exists idx_auth_user_plan_flow_point_events_user_created_at
on public.auth_user_plan_flow_point_events (user_id, created_at desc);

create index if not exists idx_auth_user_plan_flow_point_events_payment_order_id
on public.auth_user_plan_flow_point_events (payment_order_id)
where payment_order_id is not null;

alter table public.auth_user_plan_flow_point_events enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'drop policy if exists "service_role_all_auth_user_plan_flow_point_events" on public.auth_user_plan_flow_point_events';
    execute 'create policy "service_role_all_auth_user_plan_flow_point_events" on public.auth_user_plan_flow_point_events for all to service_role using (true) with check (true)';
  end if;
end
$$;

create table if not exists public.auth_user_plan_scheduled_changes (
  id bigserial primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  guild_id text,
  current_plan_code text not null check (current_plan_code in ('basic', 'pro', 'ultra', 'master')),
  current_billing_cycle_days integer not null check (current_billing_cycle_days > 0),
  target_plan_code text not null check (target_plan_code in ('basic', 'pro', 'ultra', 'master')),
  target_billing_period_code text not null check (target_billing_period_code in ('monthly', 'quarterly', 'semiannual', 'annual')),
  target_billing_cycle_days integer not null check (target_billing_cycle_days > 0),
  status text not null default 'scheduled' check (status in ('scheduled', 'applied', 'cancelled')),
  effective_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists idx_auth_user_plan_scheduled_changes_active_user
on public.auth_user_plan_scheduled_changes (user_id)
where status = 'scheduled';

create index if not exists idx_auth_user_plan_scheduled_changes_user_status_effective_at
on public.auth_user_plan_scheduled_changes (user_id, status, effective_at);

drop trigger if exists tr_auth_user_plan_scheduled_changes_updated_at on public.auth_user_plan_scheduled_changes;
create trigger tr_auth_user_plan_scheduled_changes_updated_at
before update on public.auth_user_plan_scheduled_changes
for each row
execute function public.set_updated_at();

alter table public.auth_user_plan_scheduled_changes enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'drop policy if exists "service_role_all_auth_user_plan_scheduled_changes" on public.auth_user_plan_scheduled_changes';
    execute 'create policy "service_role_all_auth_user_plan_scheduled_changes" on public.auth_user_plan_scheduled_changes for all to service_role using (true) with check (true)';
  end if;
end
$$;

create or replace function public.apply_user_plan_flow_points_event(
  p_user_id bigint,
  p_event_type text,
  p_amount numeric,
  p_currency text default 'BRL',
  p_reference_key text default null,
  p_payment_order_id bigint default null,
  p_metadata jsonb default '{}'::jsonb
)
returns table(balance_amount numeric, applied_amount numeric, applied boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_currency text;
  v_current_balance numeric(12,2);
  v_next_balance numeric(12,2);
  v_applied_amount numeric(12,2);
  v_existing_balance numeric(12,2);
begin
  v_currency := coalesce(nullif(trim(coalesce(p_currency, '')), ''), 'BRL');

  if p_reference_key is not null then
    select e.balance_after
      into v_existing_balance
      from public.auth_user_plan_flow_point_events e
     where e.reference_key = p_reference_key
     limit 1;

    if found then
      balance_amount := coalesce(v_existing_balance, 0);
      applied_amount := 0;
      applied := false;
      return next;
      return;
    end if;
  end if;

  insert into public.auth_user_plan_flow_points (
    user_id,
    currency,
    balance_amount
  )
  values (
    p_user_id,
    v_currency,
    0
  )
  on conflict (user_id) do nothing;

  select fp.balance_amount
    into v_current_balance
    from public.auth_user_plan_flow_points fp
   where fp.user_id = p_user_id
   for update;

  v_current_balance := coalesce(v_current_balance, 0);
  v_next_balance := round(greatest(0, v_current_balance + coalesce(p_amount, 0))::numeric, 2);
  v_applied_amount := round((v_next_balance - v_current_balance)::numeric, 2);

  update public.auth_user_plan_flow_points
     set currency = v_currency,
         balance_amount = v_next_balance
   where user_id = p_user_id;

  insert into public.auth_user_plan_flow_point_events (
    user_id,
    payment_order_id,
    event_type,
    amount,
    currency,
    balance_after,
    reference_key,
    metadata
  )
  values (
    p_user_id,
    p_payment_order_id,
    coalesce(nullif(trim(coalesce(p_event_type, '')), ''), 'flow_points_adjustment'),
    v_applied_amount,
    v_currency,
    v_next_balance,
    p_reference_key,
    coalesce(p_metadata, '{}'::jsonb)
  );

  balance_amount := v_next_balance;
  applied_amount := v_applied_amount;
  applied := true;
  return next;
end;
$$;


-- ============================================================================
-- MIGRATION: 060_guild_security_logs_voice_mute.sql
-- ============================================================================

alter table public.guild_security_logs_settings
add column if not exists voice_mute_enabled boolean not null default false,
add column if not exists voice_mute_channel_id text null;

update public.guild_security_logs_settings
set
  voice_mute_enabled = true,
  voice_mute_channel_id = case
    when use_default_channel = true then voice_mute_channel_id
    else coalesce(voice_mute_channel_id, member_timeout_channel_id)
  end
where
  voice_mute_enabled = false
  and member_timeout_enabled = true;


-- ============================================================================
-- MIGRATION: 061_tickets_intro_message_id.sql
-- ============================================================================

alter table public.tickets
add column if not exists intro_message_id text null;


-- ============================================================================
-- MIGRATION: 062_plan_downgrade_server_enforcement.sql
-- ============================================================================

alter table public.auth_user_plan_guilds
add column if not exists is_active boolean not null default true,
add column if not exists deactivated_reason text null,
add column if not exists deactivated_at timestamptz null,
add column if not exists reactivated_at timestamptz null;

create index if not exists idx_auth_user_plan_guilds_user_active
on public.auth_user_plan_guilds (user_id, is_active, activated_at desc);

create table if not exists public.auth_user_plan_downgrade_enforcements (
  id bigserial primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  scheduled_change_id bigint references public.auth_user_plan_scheduled_changes(id) on delete set null,
  target_plan_code text not null check (target_plan_code in ('basic', 'pro', 'ultra', 'master')),
  target_billing_period_code text not null check (target_billing_period_code in ('monthly', 'quarterly', 'semiannual', 'annual')),
  target_billing_cycle_days integer not null check (target_billing_cycle_days > 0),
  target_max_licensed_servers integer not null check (target_max_licensed_servers > 0),
  status text not null default 'selection_required' check (status in ('selection_required', 'awaiting_payment', 'resolved', 'cancelled')),
  effective_at timestamptz not null,
  selected_guild_ids jsonb not null default '[]'::jsonb,
  resolved_payment_order_id bigint references public.payment_orders(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_user_plan_downgrade_enforcements_selected_guild_ids_array
    check (jsonb_typeof(selected_guild_ids) = 'array')
);

create unique index if not exists idx_auth_user_plan_downgrade_enforcements_active_user
on public.auth_user_plan_downgrade_enforcements (user_id)
where status in ('selection_required', 'awaiting_payment');

create index if not exists idx_auth_user_plan_downgrade_enforcements_user_status
on public.auth_user_plan_downgrade_enforcements (user_id, status, effective_at desc);

drop trigger if exists tr_auth_user_plan_downgrade_enforcements_updated_at on public.auth_user_plan_downgrade_enforcements;
create trigger tr_auth_user_plan_downgrade_enforcements_updated_at
before update on public.auth_user_plan_downgrade_enforcements
for each row
execute function public.set_updated_at();

alter table public.auth_user_plan_downgrade_enforcements enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'drop policy if exists "service_role_all_auth_user_plan_downgrade_enforcements" on public.auth_user_plan_downgrade_enforcements';
    execute 'create policy "service_role_all_auth_user_plan_downgrade_enforcements" on public.auth_user_plan_downgrade_enforcements for all to service_role using (true) with check (true)';
  end if;
end
$$;


-- ============================================================================
-- MIGRATION: 063_guild_autorole_settings.sql
-- ============================================================================

create table if not exists public.guild_autorole_settings (
  id bigint generated always as identity primary key,
  guild_id text not null unique,
  enabled boolean not null default false,
  role_ids jsonb not null default '[]'::jsonb,
  assignment_delay_minutes integer not null default 0,
  existing_members_sync_requested_at timestamptz null,
  existing_members_sync_started_at timestamptz null,
  existing_members_sync_completed_at timestamptz null,
  existing_members_sync_status text not null default 'idle',
  existing_members_sync_error text null,
  configured_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_autorole_settings_role_ids_array_check
    check (jsonb_typeof(role_ids) = 'array'),
  constraint guild_autorole_settings_assignment_delay_check
    check (assignment_delay_minutes in (0, 10, 20, 30)),
  constraint guild_autorole_settings_existing_members_sync_status_check
    check (existing_members_sync_status in ('idle', 'pending', 'processing', 'completed', 'failed'))
);

drop trigger if exists tr_guild_autorole_settings_updated_at on public.guild_autorole_settings;
create trigger tr_guild_autorole_settings_updated_at
before update on public.guild_autorole_settings
for each row
execute function public.set_updated_at();

create table if not exists public.guild_autorole_queue (
  id bigint generated always as identity primary key,
  guild_id text not null,
  member_id text not null,
  due_at timestamptz not null,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  requested_source text not null default 'member_join',
  last_error text null,
  processed_at timestamptz null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_autorole_queue_status_check
    check (status in ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  constraint guild_autorole_queue_attempt_count_check
    check (attempt_count >= 0),
  constraint guild_autorole_queue_requested_source_check
    check (requested_source in ('member_join', 'existing_members_sync'))
);

create index if not exists idx_guild_autorole_queue_status_due_at
on public.guild_autorole_queue (status, due_at asc, created_at asc);

create index if not exists idx_guild_autorole_queue_guild_member
on public.guild_autorole_queue (guild_id, member_id, created_at desc);

drop trigger if exists tr_guild_autorole_queue_updated_at on public.guild_autorole_queue;
create trigger tr_guild_autorole_queue_updated_at
before update on public.guild_autorole_queue
for each row
execute function public.set_updated_at();

alter table public.guild_autorole_settings enable row level security;
alter table public.guild_autorole_queue enable row level security;

drop policy if exists "service_role_all_guild_autorole_settings" on public.guild_autorole_settings;
create policy "service_role_all_guild_autorole_settings"
on public.guild_autorole_settings
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_guild_autorole_queue" on public.guild_autorole_queue;
create policy "service_role_all_guild_autorole_queue"
on public.guild_autorole_queue
for all
to service_role
using (true)
with check (true);


-- ============================================================================
-- MIGRATION: 064_system_status.sql
-- ============================================================================

-- System Status Tables (Idempotent Script)

-- Create Types if they don't exist
DO $$ BEGIN
    CREATE TYPE system_status_type AS ENUM ('operational', 'degraded_performance', 'partial_outage', 'major_outage');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE incident_impact_type AS ENUM ('critical', 'warning', 'info');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE incident_status_type AS ENUM ('investigating', 'identified', 'monitoring', 'resolved');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE subscription_type AS ENUM ('email', 'discord_dm', 'webhook', 'discord_channel');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create Tables IF NOT EXISTS
CREATE TABLE IF NOT EXISTS system_components (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    status system_status_type NOT NULL DEFAULT 'operational',
    display_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ensure UNIQUE constraint exists for ON CONFLICT to work
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'system_components_name_key'
    ) THEN
        ALTER TABLE system_components ADD CONSTRAINT system_components_name_key UNIQUE (name);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS system_status_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    component_id UUID REFERENCES system_components(id) ON DELETE CASCADE,
    status system_status_type NOT NULL,
    recorded_at DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(component_id, recorded_at)
);

CREATE TABLE IF NOT EXISTS system_incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    impact incident_impact_type NOT NULL DEFAULT 'info',
    status incident_status_type NOT NULL DEFAULT 'investigating',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS system_incident_updates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id UUID REFERENCES system_incidents(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    status incident_status_type NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS system_status_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type subscription_type NOT NULL,
    target TEXT NOT NULL, -- email, discord user id, webhook url, or channel id
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS Enablement
ALTER TABLE system_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_incident_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_status_subscriptions ENABLE ROW LEVEL SECURITY;

-- Policies (using DO blocks to avoid "already exists" errors)
DO $$ BEGIN
    CREATE POLICY "Public can view system components" ON system_components FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE POLICY "Public can view system status history" ON system_status_history FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE POLICY "Public can view system incidents" ON system_incidents FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE POLICY "Public can view system incident updates" ON system_incident_updates FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Insert initial components (ON CONFLICT DO NOTHING requires the UNIQUE constraint added above)
INSERT INTO system_components (name, description, display_order) VALUES
('Flow AI', 'Status do sistema de IA tanto do sistema quanto do ETC', 1),
('API', 'API principal do sistemas', 2),
('Tarefas agendadas', 'Tarefas agendadas pelos clientes como pagamentos, Datas, MudanÃ§as de plano, Downgrades etc.', 3),
('DISCORD BOT', 'Sistema do DISCORD BOT', 4),
('NotificaÃ§Ãµes', 'NotificaÃ§Ãµes de SeguranÃ§a, NotificaÃ§Ãµes de AtualizaÃ§Ãµes, Logs ETC.', 5),
('Painel de controle', 'Dashboard fdesk.flwdesk.com e areas internas vinculadas ao painel principal', 6),
('DNS', 'DNS do sistema', 7),
('CDN', 'CDN, imagens do sistema, carregamento ETC', 8),
('Registro de domÃ­nio', 'Registro de domÃ­nios, clientes, subdomÃ­nios dos transcripts dos clientes, nossos domÃ­nios e subdomÃ­nios oficiais tbm', 9),
('Rede', 'Redes, OtimizaÃ§Ãµes, Ethernet do sistema, Velocidade de carregamento, Velocidade do banco de dados', 10),
('Firewall DNS', 'Firewall, seguranÃ§a etc.', 11),
('GeolocalizaÃ§Ã£o de IP', 'GeolocalizaÃ§Ã£o, Puxar IP, LocalizaÃ§Ã£o de tudo etc', 12),
('OtimizaÃ§Ã£o', 'OtimizaÃ§Ãµes do sistema, OtimizaÃ§Ãµes de rede, OtimizaÃ§Ãµes de imagem, OtimizaÃ§Ãµes do carregamento, OtimizaÃ§Ãµes de DB', 13),
('Registros de auditoria', 'Logs, HistÃ³ricos de pagamento, HistÃ³ricos da conta, HistÃ³rico de mensagens com IA, HistÃ³rico de transcripts, paginas de transcripts entre outros.', 14),
('Pagamentos e transaÃ§Ãµes', 'Pagamentos, CriaÃ§Ãµes de pagamentos, ValidaÃ§Ãµes, Recusados, Pendentes, Pagamentos dos sistemas dos clientes, RecorrÃªncias, PIX, CARTAO, *, *. Entre outros', 15),
('Cache', 'Cache do sistema de salvamento, Cache de imagens, Cache interno, Cache geral', 16),
('Velocidade do sistema', 'Velocidade de carregamento do sistema, Velocidade de resposta, Velocidade da IA, Velocidade de RenderizaÃ§Ã£o, Velocidade de abertura e fechamento, Velocidade de criaÃ§Ã£o de pagamentos, Logs, Registros e funcionamentos', 17),
('Certificado SSL', 'Certificado SSL do sistema Oficial, SubdomÃ­nios, Paginas de clientes e SubdomÃ­nios Clientes', 18),
('Armazenamento DB', 'Armazenamento de informaÃ§Ãµes, Armazenamento local, Armazenamento temporÃ¡rio, Armazenamento DB, Armazenamento de cache etc', 19),
('Analises da Web', 'Analise de comportamento, Analise de logs, velocidades, renderizaÃ§Ã£o, funÃ§Ãµes, padrÃµes, bots, ataques, etc', 20)
ON CONFLICT (name) DO NOTHING;

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_system_status_history_component_date ON system_status_history (component_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_system_status_history_recorded_at ON system_status_history (recorded_at);
CREATE INDEX IF NOT EXISTS idx_system_incidents_created_at ON system_incidents (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_incident_updates_incident_id ON system_incident_updates (incident_id);


-- ============================================================================
-- MIGRATION: 065_guild_antilink_settings_ignored_channels.sql
-- ============================================================================

ALTER TABLE guild_antilink_settings ADD COLUMN IF NOT EXISTS ignored_channel_ids TEXT[] DEFAULT '{}'::TEXT[];


-- ============================================================================
-- MIGRATION: 065_remove_comunidade.sql
-- ============================================================================

-- Remove Comunidade component from system_components table
DELETE FROM system_components WHERE name = 'Comunidade';

-- Also remove any related history records
DELETE FROM system_status_history WHERE component_id IN (
    SELECT id FROM system_components WHERE name = 'Comunidade'
);


-- ============================================================================
-- MIGRATION: 066_payment_orders_guild_id_nullable.sql
-- ============================================================================

-- Torna a coluna guild_id opcional na tabela payment_orders
-- Isso permite a criacao de ordens de pagamento antes da selecao de um servidor especifico.

alter table public.payment_orders alter column guild_id drop not null;

-- Remove o check constraint que impedia valores nulos se existir (normalmente o NOT NULL ja e o suficiente)
-- Adicionado apenas por seguranca caso o Supabase tenha inferido algo extra.


-- ============================================================================
-- MIGRATION: 066_scheduled_tasks_system.sql
-- ============================================================================

-- Scheduled Tasks and Plans System Tables

-- Create Types if they don't exist
DO $$ BEGIN
    CREATE TYPE task_status_type AS ENUM ('pending', 'processing', 'completed', 'failed', 'cancelled');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE task_type AS ENUM ('plan_downgrade', 'plan_upgrade', 'plan_expiry', 'payment_retry', 'account_cleanup', 'data_backup', 'notification_send');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE plan_status_type AS ENUM ('active', 'expired', 'cancelled', 'suspended');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE plan_type AS ENUM ('free', 'basic', 'premium', 'enterprise');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create Tables IF NOT EXISTS
CREATE TABLE IF NOT EXISTS user_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    plan_type plan_type NOT NULL DEFAULT 'free',
    status plan_status_type NOT NULL DEFAULT 'active',
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    suspended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_type task_type NOT NULL,
    status task_status_type NOT NULL DEFAULT 'pending',
    user_id UUID,
    plan_id UUID REFERENCES user_plans(id) ON DELETE CASCADE,
    scheduled_at TIMESTAMPTZ NOT NULL,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    error_message TEXT,
    retry_count INT NOT NULL DEFAULT 0,
    max_retries INT NOT NULL DEFAULT 3,
    priority INT NOT NULL DEFAULT 0,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS Enablement
ALTER TABLE user_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_tasks ENABLE ROW LEVEL SECURITY;

-- Policies
DO $$ BEGIN
    CREATE POLICY "Users can view their own plans" ON user_plans FOR SELECT USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE POLICY "Service role can manage all plans" ON user_plans FOR ALL USING (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE POLICY "Users can view their own tasks" ON scheduled_tasks FOR SELECT USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE POLICY "Service role can manage all tasks" ON scheduled_tasks FOR ALL USING (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_user_plans_user_id ON user_plans (user_id);
CREATE INDEX IF NOT EXISTS idx_user_plans_status ON user_plans (status);
CREATE INDEX IF NOT EXISTS idx_user_plans_expires_at ON user_plans (expires_at);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_status ON scheduled_tasks (status);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_scheduled_at ON scheduled_tasks (scheduled_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_user_id ON scheduled_tasks (user_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_type ON scheduled_tasks (task_type);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_priority ON scheduled_tasks (priority DESC);

-- Composite indexes for status + date queries (critical for health checks)
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_status_scheduled_at ON scheduled_tasks (status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_status_completed_at ON scheduled_tasks (status, completed_at);
CREATE INDEX IF NOT EXISTS idx_user_plans_status_expires_at ON user_plans (status, expires_at);

-- Function to automatically create expiry tasks for plans
CREATE OR REPLACE FUNCTION create_plan_expiry_task()
RETURNS TRIGGER AS $$
BEGIN
    -- Only create task if plan has an expiry date and is active
    IF NEW.expires_at IS NOT NULL AND NEW.status = 'active' THEN
        INSERT INTO public.scheduled_tasks (task_type, user_id, plan_id, scheduled_at, priority, metadata)
        VALUES ('plan_expiry', NEW.user_id, NEW.id, NEW.expires_at, 10,
                jsonb_build_object('plan_type', NEW.plan_type, 'expires_at', NEW.expires_at))
        ON CONFLICT DO NOTHING;
    END IF;

    -- Clean up old expiry tasks if expiry changed
    IF OLD.expires_at IS NOT NULL AND (OLD.expires_at != NEW.expires_at OR NEW.status != 'active') THEN
        DELETE FROM public.scheduled_tasks
        WHERE plan_id = NEW.id AND task_type = 'plan_expiry' AND status = 'pending';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;

-- Function to handle plan status changes
CREATE OR REPLACE FUNCTION handle_plan_status_change()
RETURNS TRIGGER AS $$
BEGIN
    -- If plan expired, create cleanup task
    IF NEW.status = 'expired' AND OLD.status = 'active' THEN
        INSERT INTO public.scheduled_tasks (task_type, user_id, plan_id, scheduled_at, priority, metadata)
        VALUES ('account_cleanup', NEW.user_id, NEW.id, now() + interval '30 days', 5,
                jsonb_build_object('reason', 'plan_expired', 'plan_type', NEW.plan_type))
        ON CONFLICT DO NOTHING;
    END IF;

    -- If plan was cancelled, cancel related tasks
    IF NEW.status = 'cancelled' AND OLD.status != 'cancelled' THEN
        UPDATE public.scheduled_tasks
        SET status = 'cancelled', updated_at = now()
        WHERE plan_id = NEW.id AND status IN ('pending', 'processing');
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;

-- Create triggers (drop first to avoid conflicts)
DROP TRIGGER IF EXISTS trigger_create_plan_expiry_task ON user_plans;
DROP TRIGGER IF EXISTS trigger_plan_status_change ON user_plans;

CREATE TRIGGER trigger_create_plan_expiry_task
    AFTER INSERT OR UPDATE ON user_plans
    FOR EACH ROW EXECUTE FUNCTION create_plan_expiry_task();

CREATE TRIGGER trigger_plan_status_change
    AFTER UPDATE ON user_plans
    FOR EACH ROW EXECUTE FUNCTION handle_plan_status_change();


-- ============================================================================
-- MIGRATION: 066a_scheduled_tasks_tables.sql
-- ============================================================================

-- Scheduled Tasks and Plans System - Core Tables
-- Execute this first

-- Create Types if they don't exist
DO $$ BEGIN
    CREATE TYPE task_status_type AS ENUM ('pending', 'processing', 'completed', 'failed', 'cancelled');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE task_type AS ENUM ('plan_downgrade', 'plan_upgrade', 'plan_expiry', 'payment_retry', 'account_cleanup', 'data_backup', 'notification_send');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE plan_status_type AS ENUM ('active', 'expired', 'cancelled', 'suspended');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE plan_type AS ENUM ('free', 'basic', 'premium', 'enterprise');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create Tables IF NOT EXISTS
CREATE TABLE IF NOT EXISTS user_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    plan_type plan_type NOT NULL DEFAULT 'free',
    status plan_status_type NOT NULL DEFAULT 'active',
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    suspended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_type task_type NOT NULL,
    status task_status_type NOT NULL DEFAULT 'pending',
    user_id UUID,
    plan_id UUID REFERENCES user_plans(id) ON DELETE CASCADE,
    scheduled_at TIMESTAMPTZ NOT NULL,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    error_message TEXT,
    retry_count INT NOT NULL DEFAULT 0,
    max_retries INT NOT NULL DEFAULT 3,
    priority INT NOT NULL DEFAULT 0,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================================
-- MIGRATION: 067_performance_indexes.sql
-- ============================================================================

-- Ãndices de Performance: Dashboard de Servidores (VersÃ£o Corrigida)

-- Otimizar busca de histÃ³rico de pagamentos por usuÃ¡rio (Fundamental para carregar licenÃ§as rapidamente)
-- Acelera a funÃ§Ã£o reconcileRecentPaymentOrders e getLockedGuildLicenseMapByUserId
create index if not exists idx_payment_orders_user_id_status_v2
on public.payment_orders (user_id, status);

create index if not exists idx_payment_orders_user_id_approved_guild_id_v2
on public.payment_orders (user_id, guild_id)
where status = 'approved' and guild_id is not null;

-- Otimizar busca de servidores vinculados ao plano do usuÃ¡rio
create index if not exists idx_auth_user_plan_guilds_user_id_v2
on public.auth_user_plan_guilds (user_id);

-- Otimizar validaÃ§Ã£o de sessÃ£o e expiraÃ§Ã£o (Acelera o login e reconhecimento do usuÃ¡rio)
create index if not exists idx_auth_sessions_user_id_expires_at_v2
on public.auth_sessions (user_id, expires_at desc);

-- Nota: O Ã­ndice para auth_user_teams (owner_user_id) jÃ¡ existe no sistema base (idx_auth_user_teams_owner_user_id),
-- por isso foi removido desta lista para evitar erros de redundÃ¢ncia.


-- ============================================================================
-- MIGRATION: 068_account_performance.sql
-- ============================================================================

-- Ãndices de Performance: SeÃ§Ã£o de Conta (Accounts)
-- OtimizaÃ§Ãµes para histÃ³rico, mÃ©todos de pagamento e resumo

-- Acelera o carregamento do histÃ³rico de pagamentos ordenado por data
create index if not exists idx_payment_orders_user_id_created_at_desc
on public.payment_orders (user_id, created_at desc);

-- Acelera a busca de eventos vinculados a ordens de pagamento (Timeline/Labels)
create index if not exists idx_payment_order_events_order_id
on public.payment_order_events (payment_order_id);

-- Acelera o carregamento de cartÃµes e mÃ©todos de pagamento salvos
create index if not exists idx_auth_user_payment_methods_user_id_active
on public.auth_user_payment_methods (user_id) where is_active = true;

-- Acelera a verificaÃ§Ã£o de mÃ©todos ocultos pelo usuÃ¡rio
create index if not exists idx_auth_user_hidden_methods_user_id
on public.auth_user_hidden_payment_methods (user_id);

-- Acelera a contagem de faturas e resumo da conta
create index if not exists idx_payment_orders_user_id_summary
on public.payment_orders (user_id);


-- ============================================================================
-- MIGRATION: 069_account_violations.sql
-- ============================================================================

-- Violation Definitions Table
create table if not exists public.violation_definitions (
  id text primary key, -- slug as ID for easier staff management
  name text not null,
  description text not null,
  rule_url text
);

-- Active Account Violations Table
-- Ensure the violations table exists
create table if not exists public.account_violations (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.auth_users(id) on delete cascade,
  type text not null,
  reason text,
  expires_at timestamptz,
  updated_at timestamptz not null default timezone('utc', now())
);

-- Realtime Support
alter publication supabase_realtime add table account_violations;
alter table public.account_violations replica identity full;

-- IMPORTANT: Add category_id if it doesn't exist (Fixes the "column does not exist" error)
alter table public.account_violations add column if not exists category_id text references public.violation_definitions(id) on delete set null;

create index if not exists idx_account_violations_user_id
on public.account_violations (user_id);

create index if not exists idx_account_violations_category_id
on public.account_violations (category_id);

drop trigger if exists tr_account_violations_updated_at on public.account_violations;
create trigger tr_account_violations_updated_at
before update on public.account_violations
for each row
execute function public.set_updated_at();

-- RLS
alter table public.violation_definitions enable row level security;
alter table public.account_violations enable row level security;

drop policy if exists "Anyone can view violation definitions" on public.violation_definitions;
create policy "Anyone can view violation definitions"
  on public.violation_definitions for select using (true);

drop policy if exists "Users can view their own violations" on public.account_violations;
create policy "Users can view their own violations"
  on public.account_violations
  for select
  using (
    user_id = (
      select id from public.auth_users
      where discord_user_id = (auth.jwt() ->> 'sub')
      limit 1
    )
  );

-- Initial Data for Violation Definitions
insert into public.violation_definitions (id, name, description, rule_url)
values 
  ('fraude_pagamento', 'Fraude em Pagamentos', 'Atividades suspeitas ou fraudulentas detectadas no processamento de transaÃ§Ãµes, incluindo o uso de mÃ©todos de pagamento nÃ£o autorizados.', 'https://www.flwdesk.com/privacy'),
  ('fraude_estorno', 'Fraude em Pagamentos', 'Atividades suspeitas ou fraudulentas detectadas no processamento de transaÃ§Ãµes, incluindo o uso de mÃ©todos de pagamento nÃ£o autorizados.', 'https://www.flwdesk.com/privacy'),
  ('contestacao_indevida', 'ContestaÃ§Ã£o Indevida de CobranÃ§a', 'Abertura de disputas junto a operadoras de cartÃ£o para serviÃ§os que foram devidamente prestados.', 'https://www.flwdesk.com/privacy'),
  ('lavagem_transacoes', 'Lavagem de TransaÃ§Ãµes', 'Uso da plataforma para movimentar fundos de origem duvidosa ou atravÃ©s de intermediÃ¡rios nÃ£o autorizados.', 'https://www.flwdesk.com/privacy'),
  ('uso_indevido_pagamento', 'Uso Indevido de MÃ©todos de Pagamento', 'UtilizaÃ§Ã£o de cartÃµes ou contas de terceiros sem autorizaÃ§Ã£o explÃ­cita ou em desacordo com as regras do emissor.', 'https://www.flwdesk.com/privacy'),
  ('manipulacao_saldo', 'ManipulaÃ§Ã£o de Saldo, CrÃ©dito ou BenefÃ­cio', 'Tentativa de alterar artificialmente valores em conta, crÃ©ditos promocionais ou benefÃ­cios da plataforma.', 'https://www.flwdesk.com/privacy'),
  ('abuso_estorno_automatico', 'Abuso de Estorno AutomÃ¡tico', 'ExploraÃ§Ã£o repetitiva de mecanismos de proteÃ§Ã£o ao consumidor para fins de enriquecimento ilÃ­cito.', 'https://www.flwdesk.com/privacy'),
  ('fraude_identidade', 'Fraude de Identidade', 'Uso de informaÃ§Ãµes de identidade falsas ou roubadas para criar ou gerenciar contas.', 'https://www.flwdesk.com/privacy'),
  ('falsidade_ideologica', 'Falsidade IdeolÃ³gica ou Documental', 'ApresentaÃ§Ã£o de documentos forjados ou informaÃ§Ãµes falsas durante processos de verificaÃ§Ã£o.', 'https://www.flwdesk.com/privacy'),
  ('acesso_nao_autorizado', 'Acesso NÃ£o Autorizado', 'Tentativa de acessar contas ou dados de terceiros sem a devida permissÃ£o.', 'https://www.flwdesk.com/privacy'),
  ('compartilhamento_conta', 'Compartilhamento Indevido de Conta ou Credenciais', 'CessÃ£o de acesso a terceiros em planos que exigem uso pessoal ou transferÃªncia de propriedade nÃ£o autorizada.', 'https://www.flwdesk.com/privacy'),
  ('violacao_seguranca', 'ViolaÃ§Ã£o de SeguranÃ§a', 'AÃ§Ãµes que comprometem a integridade dos sistemas da Flowdesk ou de seus usuÃ¡rios.', 'https://www.flwdesk.com/privacy'),
  ('exploracao_bug', 'ExploraÃ§Ã£o de Falha, Bug ou Vulnerabilidade', 'Uso intencional de falhas tÃ©cnicas para obter vantagens competitivas ou financeiras em vez de reportÃ¡-las.', 'https://www.flwdesk.com/privacy'),
  ('uso_indevido_api', 'Uso Indevido de API, Bot ou IntegraÃ§Ã£o', 'Abuso de limites de requisiÃ§Ã£o ou uso de ferramentas nÃ£o autorizadas para interagir com a plataforma.', 'https://www.flwdesk.com/privacy'),
  ('automacao_abusiva', 'AutomaÃ§Ã£o Abusiva', 'Uso excessivo de scripts ou bots que prejudicam a performance dos servidores para outros usuÃ¡rios.', 'https://www.flwdesk.com/privacy'),
  ('spam_flood', 'Spam, Flood ou Abuso Operacional', 'Envio em massa de comunicaÃ§Ãµes nÃ£o solicitadas ou sobrecarga proposital de canais de suporte.', 'https://www.flwdesk.com/privacy'),
  ('burla_regras', 'Tentativa de Burla de Regras', 'Emprego de meios criativos para contornar restriÃ§Ãµes impostas por violaÃ§Ãµes anteriores ou limites do plano.', 'https://www.flwdesk.com/privacy'),
  ('uso_indevido_recursos', 'Uso Indevido de Recursos da Plataforma', 'UtilizaÃ§Ã£o de ferramentas da plataforma para fins diferentes daqueles estabelecidos em contrato.', 'https://www.flwdesk.com/privacy'),
  ('descumprimento_politicas', 'Descumprimento de PolÃ­ticas Internas', 'ViolaÃ§Ã£o sistemÃ¡tica de diretrizes operacionais e de conduta da Flowdesk.', 'https://www.flwdesk.com/privacy'),
  ('violacao_privacidade', 'ViolaÃ§Ã£o de Privacidade e Dados', 'Coleta, exposiÃ§Ã£o ou uso indevido de dados sensÃ­veis de outros usuÃ¡rios ou da prÃ³pria plataforma.', 'https://www.flwdesk.com/privacy'),
  ('fraude_usuarios', 'Fraude Contra UsuÃ¡rios ou Clientes', 'Enganar outros membros da comunidade ou clientes finais atravÃ©s das ferramentas do sistema.', 'https://www.flwdesk.com/privacy'),
  ('abuso_autoridade', 'Abuso de PermissÃµes ou Autoridade', 'Uso indevido de cargos de equipe ou permissÃµes administrativas em servidores gerenciados.', 'https://www.flwdesk.com/privacy'),
  ('ameaca_intimidacao', 'AmeaÃ§a ou IntimidaÃ§Ã£o', 'Comportamento hostil, ameaÃ§ador ou coercitivo contra membros da equipe ou comunidade.', 'https://www.flwdesk.com/privacy'),
  ('discriminacao_ofensiva', 'DiscriminaÃ§Ã£o ou Discurso Ofensivo', 'Uso de linguagem discriminatÃ³ria, preconceituosa ou discurso de Ã³ido em qualquer canal da plataforma.', 'https://www.flwdesk.com/privacy'),
  ('conduta_inadequada', 'Conduta Abusiva ou Inadequada', 'Comportamento geral que fere a Ã©tica e o convÃ­vio saudÃ¡vel esperado na Flowdesk.', 'https://www.flwdesk.com/privacy')
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  rule_url = excluded.rule_url;


-- ============================================================================
-- MIGRATION: 070_test_violation.sql
-- ============================================================================

-- Script para gerar uma violaÃ§Ã£o de teste de 3 meses para validaÃ§Ã£o da interface
-- Aplica-se ao primeiro usuÃ¡rio encontrado no banco de dados para fins de teste.

INSERT INTO public.account_violations (user_id, type, category_id, reason, expires_at)
SELECT 
  id, 
  'Uso indevido de API ou automaÃ§Ã£o', 
  'uso_indevido_api', 
  'DetecÃ§Ã£o de mÃºltiplas requisiÃ§Ãµes simultÃ¢neas em padrÃµes nÃ£o humanos atravÃ©s de integraÃ§Ã£o externa nÃ£o autorizada.', 
  timezone('utc', now() + interval '3 months')
FROM public.auth_users
LIMIT 1;


-- ============================================================================
-- MIGRATION: 071_ticket_transcripts_add_access_code.sql
-- ============================================================================

-- Add access_code column to ticket_transcripts table to allow auto-access from dashboard
alter table public.ticket_transcripts 
add column if not exists access_code text;

-- Add a comment for clarity
comment on column public.ticket_transcripts.access_code is 'Plain text access code for the transcript, used for auto-access from the dashboard.';


-- ============================================================================
-- MIGRATION: 072_add_ai_rules_to_settings.sql
-- ============================================================================

-- Migration to add ai_rules column to guild_ticket_settings
ALTER TABLE public.guild_ticket_settings 
ADD COLUMN IF NOT EXISTS ai_rules TEXT;

-- Update select permissions if necessary (usually handled by existing RLS or service role)
COMMENT ON COLUMN public.guild_ticket_settings.ai_rules IS 'Regras de atendimento para o sistema de sugestÃ£o por IA antes de abrir o ticket.';


-- ============================================================================
-- MIGRATION: 072_status_system_upgrade.sql
-- ============================================================================

-- Status System Upgrade
-- Execute after 064_system_status.sql

alter table public.system_components
  add column if not exists slug text,
  add column if not exists category text,
  add column if not exists status_source text,
  add column if not exists status_message text,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists last_checked_at timestamptz,
  add column if not exists last_incident_at timestamptz,
  add column if not exists is_public boolean not null default true,
  add column if not exists is_core boolean not null default false;

alter table public.system_incidents
  add column if not exists started_at timestamptz not null default timezone('utc', now()),
  add column if not exists resolved_at timestamptz,
  add column if not exists incident_day date,
  add column if not exists public_summary text,
  add column if not exists ai_summary text,
  add column if not exists component_summary text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create table if not exists public.system_incident_components (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.system_incidents(id) on delete cascade,
  component_id uuid not null references public.system_components(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  unique (incident_id, component_id)
);

create index if not exists idx_system_components_slug
on public.system_components (slug);

create unique index if not exists idx_system_components_slug_unique
on public.system_components (slug)
where slug is not null;

create index if not exists idx_system_components_category
on public.system_components (category);

create index if not exists idx_system_components_status_source
on public.system_components (status_source);

create index if not exists idx_system_incidents_incident_day
on public.system_incidents (incident_day desc);

create index if not exists idx_system_incidents_status_updated_at
on public.system_incidents (status, updated_at desc);

create index if not exists idx_system_incident_components_incident
on public.system_incident_components (incident_id);

create index if not exists idx_system_incident_components_component
on public.system_incident_components (component_id);

create unique index if not exists idx_system_status_subscriptions_type_target_unique
on public.system_status_subscriptions (type, target);

update public.system_incidents
set incident_day = timezone('utc', coalesce(created_at, started_at, timezone('utc', now())))::date
where incident_day is null;

create or replace function public.sync_system_incident_dates()
returns trigger
language plpgsql
as $$
begin
  if new.started_at is null then
    new.started_at := coalesce(new.created_at, timezone('utc', now()));
  end if;

  if new.incident_day is null then
    new.incident_day := timezone('utc', coalesce(new.created_at, new.started_at, timezone('utc', now())))::date;
  end if;

  if new.status = 'resolved' and new.resolved_at is null then
    new.resolved_at := timezone('utc', now());
  end if;

  if new.status <> 'resolved' then
    new.resolved_at := null;
  end if;

  new.updated_at := timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists tr_system_incidents_sync_dates on public.system_incidents;
create trigger tr_system_incidents_sync_dates
before insert or update on public.system_incidents
for each row
execute function public.sync_system_incident_dates();

create or replace function public.touch_system_component_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists tr_system_components_touch_updated_at on public.system_components;
create trigger tr_system_components_touch_updated_at
before update on public.system_components
for each row
execute function public.touch_system_component_updated_at();

alter table public.system_incident_components enable row level security;

do $$ begin
  create policy "Public can view system incident components"
  on public.system_incident_components
  for select
  using (true);
exception when duplicate_object then null; end $$;

update public.system_components
set
  slug = case name
    when 'Flow AI' then 'flow-ai'
    when 'API' then 'api'
    when 'Tarefas agendadas' then 'scheduled-tasks'
    when 'DISCORD BOT' then 'discord-bot'
    when 'NotificaÃ§Ãµes' then 'notifications'
    when 'Painel de controle' then 'control-panel'
    when 'DNS' then 'dns'
    when 'CDN' then 'cdn'
    when 'Registro de domÃ­nio' then 'domain-registry'
    when 'Rede' then 'network'
    when 'Firewall DNS' then 'dns-firewall'
    when 'GeolocalizaÃ§Ã£o de IP' then 'ip-geolocation'
    when 'OtimizaÃ§Ã£o' then 'optimization'
    when 'Registros de auditoria' then 'audit-logs'
    when 'Pagamentos e transaÃ§Ãµes' then 'payments'
    when 'Cache' then 'cache'
    when 'Velocidade do sistema' then 'performance'
    when 'Certificado SSL' then 'ssl'
    when 'Armazenamento DB' then 'database-storage'
    when 'Analises da Web' then 'web-analytics'
    else coalesce(slug, lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g')))
  end,
  category = case name
    when 'Flow AI' then 'ai'
    when 'API' then 'core'
    when 'Tarefas agendadas' then 'automation'
    when 'DISCORD BOT' then 'discord'
    when 'NotificaÃ§Ãµes' then 'communication'
    when 'Painel de controle' then 'core'
    when 'DNS' then 'domains'
    when 'CDN' then 'delivery'
    when 'Registro de domÃ­nio' then 'domains'
    when 'Rede' then 'infrastructure'
    when 'Firewall DNS' then 'security'
    when 'GeolocalizaÃ§Ã£o de IP' then 'security'
    when 'OtimizaÃ§Ã£o' then 'performance'
    when 'Registros de auditoria' then 'compliance'
    when 'Pagamentos e transaÃ§Ãµes' then 'billing'
    when 'Cache' then 'performance'
    when 'Velocidade do sistema' then 'performance'
    when 'Certificado SSL' then 'security'
    when 'Armazenamento DB' then 'database'
    when 'Analises da Web' then 'analytics'
    else coalesce(category, 'general')
  end,
  status_source = case name
    when 'Flow AI' then 'flowai'
    when 'API' then 'api'
    when 'Tarefas agendadas' then 'scheduled_tasks'
    when 'Registro de domÃ­nio' then 'domains'
    when 'DNS' then 'domains'
    when 'Certificado SSL' then 'domains'
    when 'Firewall DNS' then 'domains'
    when 'GeolocalizaÃ§Ã£o de IP' then 'domains'
    when 'Pagamentos e transaÃ§Ãµes' then 'payments'
    when 'DISCORD BOT' then 'discord'
    when 'NotificaÃ§Ãµes' then 'discord'
    when 'Registros de auditoria' then 'audit'
    when 'Analises da Web' then 'audit'
    else coalesce(status_source, 'api')
  end,
  is_core = case
    when name in ('Flow AI', 'API', 'Tarefas agendadas', 'Painel de controle', 'Pagamentos e transaÃ§Ãµes') then true
    else coalesce(is_core, false)
  end;

insert into public.system_components (
  name,
  description,
  display_order,
  slug,
  category,
  status_source,
  is_core,
  metadata
) values
  ('Flow AI', 'Monitoramento do motor principal de IA, prompts e respostas automatizadas.', 1, 'flow-ai', 'ai', 'flowai', true, '{"owner":"status-system"}'::jsonb),
  ('API', 'Disponibilidade da API principal, autenticaÃ§Ã£o, banco e regras centrais.', 2, 'api', 'core', 'api', true, '{"owner":"status-system"}'::jsonb),
  ('Tarefas agendadas', 'Fila de expiracao de planos, retries, backups e automacoes agendadas.', 3, 'scheduled-tasks', 'automation', 'scheduled_tasks', true, '{"owner":"status-system"}'::jsonb),
  ('DISCORD BOT', 'Integracao do bot, vinculos de contas e operacoes relacionadas ao Discord.', 4, 'discord-bot', 'discord', 'discord', false, '{"owner":"status-system"}'::jsonb),
  ('NotificaÃ§Ãµes', 'Entrega de alertas, avisos operacionais e eventos automatizados.', 5, 'notifications', 'communication', 'discord', false, '{"owner":"status-system"}'::jsonb),
  ('Painel de controle', 'Dashboard, area autenticada e operacoes do produto principal.', 6, 'control-panel', 'core', 'api', true, '{"owner":"status-system"}'::jsonb),
  ('DNS', 'Resolucao DNS, propagacao e disponibilidade dos registros.', 7, 'dns', 'domains', 'domains', false, '{"owner":"status-system"}'::jsonb),
  ('CDN', 'Entrega de imagens, assets estaticos e distribuicao de conteudo.', 8, 'cdn', 'delivery', 'api', false, '{"owner":"status-system"}'::jsonb),
  ('Registro de domÃ­nio', 'Registro, consulta e operacoes com dominios e subdominios.', 9, 'domain-registry', 'domains', 'domains', false, '{"owner":"status-system"}'::jsonb),
  ('Rede', 'Conectividade, latencia e estabilidade da infraestrutura.', 10, 'network', 'infrastructure', 'api', false, '{"owner":"status-system"}'::jsonb),
  ('Firewall DNS', 'Camada de protecao, filtragem e seguranca de rede.', 11, 'dns-firewall', 'security', 'domains', false, '{"owner":"status-system"}'::jsonb),
  ('GeolocalizaÃ§Ã£o de IP', 'Consultas de IP, localizacao e inteligencia de origem.', 12, 'ip-geolocation', 'security', 'domains', false, '{"owner":"status-system"}'::jsonb),
  ('OtimizaÃ§Ã£o', 'Rotinas e recursos de performance, cache e ajustes do sistema.', 13, 'optimization', 'performance', 'api', false, '{"owner":"status-system"}'::jsonb),
  ('Registros de auditoria', 'Logs, trilhas de auditoria, historicos e registros de seguranca.', 14, 'audit-logs', 'compliance', 'audit', false, '{"owner":"status-system"}'::jsonb),
  ('Pagamentos e transaÃ§Ãµes', 'Criacao, confirmacao, webhook e conciliacao de pagamentos.', 15, 'payments', 'billing', 'payments', true, '{"owner":"status-system"}'::jsonb),
  ('Cache', 'Camada de cache de aplicacao, assets e respostas internas.', 16, 'cache', 'performance', 'api', false, '{"owner":"status-system"}'::jsonb),
  ('Velocidade do sistema', 'Tempo de resposta geral, renderizacao e desempenho percebido.', 17, 'performance', 'performance', 'api', false, '{"owner":"status-system"}'::jsonb),
  ('Certificado SSL', 'Emissao e disponibilidade de certificados SSL e HTTPS.', 18, 'ssl', 'security', 'domains', false, '{"owner":"status-system"}'::jsonb),
  ('Armazenamento DB', 'Persistencia de dados, integridade e disponibilidade do banco.', 19, 'database-storage', 'database', 'api', false, '{"owner":"status-system"}'::jsonb),
  ('Analises da Web', 'Analiticos, telemetria e sinais de operacao do produto.', 20, 'web-analytics', 'analytics', 'audit', false, '{"owner":"status-system"}'::jsonb)
on conflict (name) do update
set
  description = excluded.description,
  display_order = excluded.display_order,
  slug = excluded.slug,
  category = excluded.category,
  status_source = excluded.status_source,
  is_core = excluded.is_core,
  metadata = coalesce(public.system_components.metadata, '{}'::jsonb) || excluded.metadata;

create or replace view public.system_incident_feed as
select
  si.id,
  si.title,
  si.impact,
  si.status,
  si.created_at,
  si.updated_at,
  si.started_at,
  si.resolved_at,
  si.incident_day,
  coalesce(
    si.public_summary,
    si.ai_summary,
    si.component_summary,
    last_update.message,
    'Ocorrencia registrada e monitorada pela equipe.'
  ) as summary,
  coalesce(component_names.names, array[]::text[]) as affected_components
from public.system_incidents si
left join lateral (
  select siu.message
  from public.system_incident_updates siu
  where siu.incident_id = si.id
  order by siu.created_at desc
  limit 1
) as last_update on true
left join lateral (
  select array_agg(sc.name order by sc.display_order, sc.name) as names
  from public.system_incident_components sic
  join public.system_components sc on sc.id = sic.component_id
  where sic.incident_id = si.id
) as component_names on true;


-- ============================================================================
-- MIGRATION: 073_add_ai_settings_columns.sql
-- ============================================================================

-- Migration to add dedicated AI settings columns to guild_ticket_settings with NOT NULL constraints
ALTER TABLE public.guild_ticket_settings 
ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS ai_company_name TEXT NOT NULL DEFAULT '',
ADD COLUMN IF NOT EXISTS ai_company_bio TEXT NOT NULL DEFAULT '',
ADD COLUMN IF NOT EXISTS ai_rules TEXT NOT NULL DEFAULT '',
ADD COLUMN IF NOT EXISTS ai_tone TEXT NOT NULL DEFAULT 'formal';

COMMENT ON COLUMN public.guild_ticket_settings.ai_enabled IS 'Indica se o modulo FlowAI esta ativo.';
COMMENT ON COLUMN public.guild_ticket_settings.ai_company_name IS 'Nome da empresa para identidade da IA.';
COMMENT ON COLUMN public.guild_ticket_settings.ai_company_bio IS 'Descricao do negocio para contexto da IA.';
COMMENT ON COLUMN public.guild_ticket_settings.ai_rules IS 'Diretrizes e regras personalizadas para sugestoes da IA.';
COMMENT ON COLUMN public.guild_ticket_settings.ai_tone IS 'Tom de voz da IA (formal, amigavel).';


-- ============================================================================
-- MIGRATION: 074_status_subscriptions_and_reliability.sql
-- ============================================================================

-- Status subscriptions and reliability upgrade
-- Execute after 072_status_system_upgrade.sql

alter table public.system_incidents
  add column if not exists team_note_title text,
  add column if not exists team_note_body text,
  add column if not exists team_note_source text,
  add column if not exists team_note_generated_at timestamptz,
  add column if not exists false_alarm_score numeric(5,2) not null default 0,
  add column if not exists signal_snapshot jsonb not null default '{}'::jsonb;

alter table public.system_status_subscriptions
  add column if not exists user_id bigint references public.auth_users(id) on delete set null,
  add column if not exists label text,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists is_active boolean not null default true,
  add column if not exists verified_at timestamptz,
  add column if not exists last_tested_at timestamptz,
  add column if not exists last_delivery_at timestamptz,
  add column if not exists last_delivery_status integer,
  add column if not exists last_delivery_error text,
  add column if not exists updated_at timestamptz not null default timezone('utc', now());

create table if not exists public.system_status_webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.system_status_subscriptions(id) on delete cascade,
  event_type text not null,
  request_url text not null,
  request_headers jsonb not null default '{}'::jsonb,
  request_body jsonb not null default '{}'::jsonb,
  response_status integer,
  response_body text,
  delivered boolean not null default false,
  latency_ms integer,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.system_status_monitor_snapshots (
  id uuid primary key default gen_random_uuid(),
  source_key text not null,
  component_slug text,
  status system_status_type not null,
  latency_ms integer,
  response_code integer,
  message text,
  metadata jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_system_status_subscriptions_user_type
on public.system_status_subscriptions (user_id, type)
where user_id is not null;

create index if not exists idx_system_status_subscriptions_active
on public.system_status_subscriptions (is_active, type, created_at desc);

create unique index if not exists idx_system_status_subscriptions_user_type_unique
on public.system_status_subscriptions (user_id, type)
where user_id is not null and type in ('email', 'discord_dm', 'webhook');

create index if not exists idx_system_status_webhook_deliveries_subscription
on public.system_status_webhook_deliveries (subscription_id, created_at desc);

create index if not exists idx_system_status_monitor_snapshots_source
on public.system_status_monitor_snapshots (source_key, observed_at desc);

create or replace function public.touch_system_status_subscription_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists tr_system_status_subscriptions_touch_updated_at on public.system_status_subscriptions;
create trigger tr_system_status_subscriptions_touch_updated_at
before update on public.system_status_subscriptions
for each row
execute function public.touch_system_status_subscription_updated_at();

alter table public.system_status_webhook_deliveries enable row level security;
alter table public.system_status_monitor_snapshots enable row level security;

do $$ begin
  create policy "Public can view status monitor snapshots"
  on public.system_status_monitor_snapshots
  for select
  using (true);
exception when duplicate_object then null; end $$;

update public.system_status_subscriptions
set
  label = case
    when type = 'email' then coalesce(label, 'Atualizacoes por email')
    when type = 'discord_dm' then coalesce(label, 'Alertas por Discord DM')
    when type = 'webhook' then coalesce(label, 'Webhook de status')
    when type = 'discord_channel' then coalesce(label, 'Canal oficial do Discord')
    else label
  end,
  verified_at = coalesce(verified_at, created_at),
  updated_at = timezone('utc', now())
where true;

create or replace view public.system_status_active_subscriptions as
select
  id,
  user_id,
  type,
  target,
  label,
  metadata,
  verified_at,
  last_tested_at,
  last_delivery_at,
  last_delivery_status,
  last_delivery_error,
  created_at,
  updated_at
from public.system_status_subscriptions
where is_active = true;


-- ============================================================================
-- MIGRATION: 075_status_page_ultra.sql
-- ============================================================================

-- 075_status_page_ultra.sql
-- StatusPage Enterprise Upgrade: Immutable Daily Severity + AI Incident Backfill Support

-- â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- 1. Add missing columns to system_components (idempotent via DO blocks)
-- â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
DO $$ BEGIN
    ALTER TABLE system_components ADD COLUMN is_core BOOLEAN NOT NULL DEFAULT false;
EXCEPTION WHEN duplicate_column THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE system_components ADD COLUMN latency_ms INT;
EXCEPTION WHEN duplicate_column THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE system_components ADD COLUMN source_key TEXT;
EXCEPTION WHEN duplicate_column THEN null; END $$;

-- Mark key components as core and ensure Square Cloud exists
INSERT INTO system_components (name, description, status, is_core, display_order)
VALUES ('Square Cloud', 'Infraestrutura de Hospedagem', 'operational', true, 99)
ON CONFLICT (name) DO UPDATE SET is_core = true;

UPDATE system_components SET is_core = true WHERE name IN ('API', 'Flow AI', 'DISCORD BOT', 'Armazenamento DB', 'Tarefas agendadas', 'Square Cloud');

-- â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- 2. Add missing columns to system_incidents (idempotent)
-- â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
DO $$ BEGIN
    ALTER TABLE system_incidents ADD COLUMN public_summary TEXT;
EXCEPTION WHEN duplicate_column THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE system_incidents ADD COLUMN ai_summary TEXT;
EXCEPTION WHEN duplicate_column THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE system_incidents ADD COLUMN component_summary TEXT;
EXCEPTION WHEN duplicate_column THEN null; END $$;

-- â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- 3. Create system_incident_components join table (idempotent)
-- â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
CREATE TABLE IF NOT EXISTS system_incident_components (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id UUID NOT NULL REFERENCES system_incidents(id) ON DELETE CASCADE,
    component_id UUID REFERENCES system_components(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(incident_id, component_id)
);

ALTER TABLE system_incident_components ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
    CREATE POLICY "Public can view incident components" ON system_incident_components FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS idx_system_incident_components_incident_id ON system_incident_components (incident_id);
CREATE INDEX IF NOT EXISTS idx_system_incident_components_component_id ON system_incident_components (component_id);

-- â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- 4. Health pings table (raw per-minute signals for strike gate logic)
-- â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
CREATE TABLE IF NOT EXISTS system_health_pings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    component_name TEXT NOT NULL,
    status system_status_type NOT NULL,
    latency_ms INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_system_health_pings_created_at ON system_health_pings (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_health_pings_component_created ON system_health_pings (component_name, created_at DESC);

-- Auto-purge pings older than 48h via policy (requires pg_cron or manual cleanup)
-- To keep the table lean, you can run: DELETE FROM system_health_pings WHERE created_at < now() - interval '48 hours';

-- â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- 5. Immutable daily severity: worst status of the day is never overwritten
-- â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
DROP FUNCTION IF EXISTS get_status_severity_weight(system_status_type);

CREATE OR REPLACE FUNCTION get_status_severity_weight(s system_status_type)
RETURNS INT AS $$
BEGIN
    RETURN CASE s
        WHEN 'operational'         THEN 1
        WHEN 'degraded_performance' THEN 2
        WHEN 'partial_outage'      THEN 3
        WHEN 'major_outage'        THEN 4
        ELSE 0
    END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION maintain_worst_daily_status()
RETURNS TRIGGER AS $$
BEGIN
    -- Only allow updates that are equal-or-worse severity than what's stored
    IF get_status_severity_weight(NEW.status) < get_status_severity_weight(OLD.status) THEN
        NEW.status = OLD.status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_maintain_worst_daily_status ON system_status_history;
CREATE TRIGGER trg_maintain_worst_daily_status
BEFORE UPDATE ON system_status_history
FOR EACH ROW
EXECUTE FUNCTION maintain_worst_daily_status();

-- â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- 6. Add label column to subscriptions (already present in subscriptions.ts)
-- â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
DO $$ BEGIN
    ALTER TABLE system_status_subscriptions ADD COLUMN label TEXT;
EXCEPTION WHEN duplicate_column THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE system_status_subscriptions ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true;
EXCEPTION WHEN duplicate_column THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE system_status_subscriptions ADD COLUMN verified_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE system_status_subscriptions ADD COLUMN metadata JSONB;
EXCEPTION WHEN duplicate_column THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE system_status_subscriptions ADD COLUMN last_delivery_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE system_status_subscriptions ADD COLUMN last_delivery_status INT;
EXCEPTION WHEN duplicate_column THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE system_status_subscriptions ADD COLUMN last_delivery_error TEXT;
EXCEPTION WHEN duplicate_column THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE system_status_subscriptions ADD COLUMN updated_at TIMESTAMPTZ DEFAULT now();
EXCEPTION WHEN duplicate_column THEN null; END $$;

-- Add UNIQUE constraint for on-conflict upserts
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'system_status_subscriptions_type_target_key') THEN
        ALTER TABLE system_status_subscriptions ADD CONSTRAINT system_status_subscriptions_type_target_key UNIQUE (type, target);
    END IF;
EXCEPTION WHEN duplicate_table OR duplicate_object THEN null; END $$;

-- â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- 7. Extra indexes for fast queries
-- â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
CREATE INDEX IF NOT EXISTS idx_system_components_status ON system_components (status);
CREATE INDEX IF NOT EXISTS idx_system_components_display_order ON system_components (display_order);
CREATE INDEX IF NOT EXISTS idx_system_incidents_status ON system_incidents (status);
CREATE INDEX IF NOT EXISTS idx_system_incidents_impact ON system_incidents (impact);
CREATE INDEX IF NOT EXISTS idx_system_incident_updates_created_at ON system_incident_updates (created_at DESC);


-- ============================================================================
-- MIGRATION: 076_status_ultra_audit.sql
-- ============================================================================

-- 076_status_ultra_audit.sql
-- StatusPage Enterprise Upgrade: Audit Logs, Failure Correlation & Detailed Metrics

-- 1. Create Status Audit Table
CREATE TABLE IF NOT EXISTS system_status_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    component_id UUID REFERENCES system_components(id),
    old_status system_status_type,
    new_status system_status_type,
    reason TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Create index for fast audit lookups
CREATE INDEX IF NOT EXISTS idx_status_audit_component ON system_status_audit(component_id, created_at DESC);

-- 3. Ensure new components exist
INSERT INTO system_components (name, description, status, is_core, display_order)
VALUES 
    ('Discord CDN', 'Entrega de icones e assets', 'operational', false, 100),
    ('Auditoria Interna', 'Integridade de logs e sinais', 'operational', true, 101)
ON CONFLICT (name) DO UPDATE SET is_core = EXCLUDED.is_core;

-- 4. Add last_failure_at to components
DO $$ BEGIN
    ALTER TABLE system_components ADD COLUMN last_failure_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN null; END $$;

-- 4. Create trigger to automatically log status changes
CREATE OR REPLACE FUNCTION log_system_status_change()
RETURNS TRIGGER AS $$
BEGIN
    if (OLD.status IS DISTINCT FROM NEW.status) THEN
        INSERT INTO system_status_audit (component_id, old_status, new_status, reason, metadata)
        VALUES (
            NEW.id, 
            OLD.status, 
            NEW.status, 
            'Mudanca automatica detectada pelo monitor',
            jsonb_build_object(
                'updated_at', NEW.updated_at,
                'latency_ms', NEW.latency_ms
            )
        );
        
        if (NEW.status = 'major_outage' OR NEW.status = 'partial_outage') THEN
            NEW.last_failure_at = now();
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_log_status_change ON system_components;
CREATE TRIGGER trg_log_status_change
    BEFORE UPDATE ON system_components
    FOR EACH ROW
    EXECUTE FUNCTION log_system_status_change();

-- 5. Add failure count column for today's reliability score
DO $$ BEGIN
    ALTER TABLE system_components ADD COLUMN today_failure_count INTEGER DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN null; END $$;

-- 6. Create Discord CDN Cache Table
CREATE TABLE IF NOT EXISTS discord_cdn_cache (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon_url TEXT NOT NULL,
    last_updated_at TIMESTAMPTZ DEFAULT now(),
    is_featured BOOLEAN DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_discord_cdn_featured ON discord_cdn_cache(is_featured);


-- ============================================================================
-- MIGRATION: 077_flowai_enterprise_platform.sql
-- ============================================================================

create extension if not exists pgcrypto;

create table if not exists public.auth_user_api_keys (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  name text not null,
  key_hash text not null unique,
  token_prefix text,
  last_four text not null,
  scopes text[] not null default array['flowai:invoke', 'flowai:jobs:read', 'flowai:jobs:write', 'flowai:health'],
  allowed_tasks text[] not null default array['*'],
  rate_limit_per_minute integer not null default 60,
  monthly_quota integer,
  metadata jsonb not null default '{}'::jsonb,
  last_used_at timestamptz,
  last_used_ip text,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.auth_user_api_keys
  add column if not exists token_prefix text,
  add column if not exists scopes text[] not null default array['flowai:invoke', 'flowai:jobs:read', 'flowai:jobs:write', 'flowai:health'],
  add column if not exists allowed_tasks text[] not null default array['*'],
  add column if not exists rate_limit_per_minute integer not null default 60,
  add column if not exists monthly_quota integer,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists last_used_at timestamptz,
  add column if not exists last_used_ip text,
  add column if not exists expires_at timestamptz,
  add column if not exists updated_at timestamptz not null default timezone('utc', now());

create index if not exists idx_auth_user_api_keys_user_id
on public.auth_user_api_keys (user_id, created_at desc);

create index if not exists idx_auth_user_api_keys_revoked_at
on public.auth_user_api_keys (revoked_at, created_at desc);

create index if not exists idx_auth_user_api_keys_active
on public.auth_user_api_keys (user_id, revoked_at)
where revoked_at is null;

drop trigger if exists tr_auth_user_api_keys_updated_at on public.auth_user_api_keys;
create trigger tr_auth_user_api_keys_updated_at
before update on public.auth_user_api_keys
for each row
execute function public.set_updated_at();

do $$ begin
  create type public.flowai_job_status as enum (
    'pending',
    'processing',
    'completed',
    'failed',
    'cancelled'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.flowai_job_queue (
  id uuid primary key default gen_random_uuid(),
  api_key_id bigint references public.auth_user_api_keys(id) on delete set null,
  auth_user_id bigint references public.auth_users(id) on delete set null,
  mode text not null check (mode in ('chat', 'json')),
  task_key text not null,
  payload jsonb not null default '{}'::jsonb,
  status public.flowai_job_status not null default 'pending',
  priority integer not null default 100,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  idempotency_key text,
  result jsonb,
  error text,
  request_ip text,
  available_at timestamptz not null default timezone('utc', now()),
  locked_at timestamptz,
  locked_by text,
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_flowai_job_queue_status_available
on public.flowai_job_queue (status, available_at, priority, created_at);

create index if not exists idx_flowai_job_queue_api_key
on public.flowai_job_queue (api_key_id, created_at desc);

create unique index if not exists idx_flowai_job_queue_idempotency
on public.flowai_job_queue (api_key_id, idempotency_key)
where api_key_id is not null and idempotency_key is not null;

drop trigger if exists tr_flowai_job_queue_updated_at on public.flowai_job_queue;
create trigger tr_flowai_job_queue_updated_at
before update on public.flowai_job_queue
for each row
execute function public.set_updated_at();

create table if not exists public.flowai_api_request_events (
  id uuid primary key default gen_random_uuid(),
  api_key_id bigint references public.auth_user_api_keys(id) on delete set null,
  auth_user_id bigint references public.auth_users(id) on delete set null,
  job_id uuid references public.flowai_job_queue(id) on delete set null,
  request_id text,
  trace_id text,
  mode text not null,
  task_key text not null,
  provider text,
  model text,
  response_status integer not null,
  latency_ms integer,
  queue_wait_ms integer,
  cache_hit boolean not null default false,
  request_ip text,
  error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_flowai_api_request_events_api_key_created
on public.flowai_api_request_events (api_key_id, created_at desc);

create index if not exists idx_flowai_api_request_events_task_created
on public.flowai_api_request_events (task_key, created_at desc);

create table if not exists public.flowai_provider_circuit_breakers (
  provider_key text primary key,
  state text not null default 'closed' check (state in ('closed', 'open', 'half_open')),
  consecutive_failures integer not null default 0,
  consecutive_successes integer not null default 0,
  opened_at timestamptz,
  next_attempt_at timestamptz,
  last_failure_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.auth_user_api_keys enable row level security;
alter table public.flowai_job_queue enable row level security;
alter table public.flowai_api_request_events enable row level security;
alter table public.flowai_provider_circuit_breakers enable row level security;

do $$ begin
  create policy "service_role_all_auth_user_api_keys"
  on public.auth_user_api_keys
  for all
  to service_role
  using (true)
  with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "service_role_all_flowai_job_queue"
  on public.flowai_job_queue
  for all
  to service_role
  using (true)
  with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "service_role_all_flowai_api_request_events"
  on public.flowai_api_request_events
  for all
  to service_role
  using (true)
  with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "service_role_all_flowai_provider_circuit_breakers"
  on public.flowai_provider_circuit_breakers
  for all
  to service_role
  using (true)
  with check (true);
exception when duplicate_object then null; end $$;


-- ============================================================================
-- MIGRATION: 077_ticket_ai_suggestion_sessions.sql
-- ============================================================================

create table if not exists public.ticket_ai_suggestion_sessions (
  guild_id text not null,
  user_id text not null,
  reason text not null,
  suggestion text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (guild_id, user_id)
);

drop trigger if exists tr_ticket_ai_suggestion_sessions_updated_at on public.ticket_ai_suggestion_sessions;
create trigger tr_ticket_ai_suggestion_sessions_updated_at
before update on public.ticket_ai_suggestion_sessions
for each row
execute function public.set_updated_at();

create index if not exists idx_ticket_ai_suggestion_sessions_expires_at
on public.ticket_ai_suggestion_sessions (expires_at desc);

create index if not exists idx_ticket_ai_suggestion_sessions_active
on public.ticket_ai_suggestion_sessions (consumed_at, expires_at desc);


-- ============================================================================
-- MIGRATION: 078_ticket_ai_suggestion_sessions_rls.sql
-- ============================================================================

alter table public.ticket_ai_suggestion_sessions enable row level security;

drop policy if exists "service_role_all_ticket_ai_suggestion_sessions" on public.ticket_ai_suggestion_sessions;
create policy "service_role_all_ticket_ai_suggestion_sessions"
on public.ticket_ai_suggestion_sessions
for all
to service_role
using (true)
with check (true);


-- ============================================================================
-- MIGRATION: 079_status_backend_reliability.sql
-- ============================================================================

alter table public.system_components
  add column if not exists status_message text,
  add column if not exists last_checked_at timestamptz,
  add column if not exists last_raw_status system_status_type,
  add column if not exists last_raw_checked_at timestamptz;

create index if not exists idx_system_components_last_checked_at
on public.system_components (last_checked_at desc nulls last);

create index if not exists idx_system_components_source_key
on public.system_components (source_key);

alter table public.system_incidents
  add column if not exists signal_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists false_alarm_score numeric(5,2) not null default 0;

create table if not exists public.system_status_monitor_snapshots (
  id uuid primary key default gen_random_uuid(),
  source_key text not null,
  component_slug text,
  status system_status_type not null,
  latency_ms integer,
  response_code integer,
  message text,
  metadata jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default timezone('utc', now())
);

alter table public.system_status_monitor_snapshots
  add column if not exists component_id uuid references public.system_components(id) on delete set null,
  add column if not exists component_name text,
  add column if not exists stable_status system_status_type;

create index if not exists idx_system_status_monitor_snapshots_source
on public.system_status_monitor_snapshots (source_key, observed_at desc);

create index if not exists idx_system_status_monitor_snapshots_component
on public.system_status_monitor_snapshots (component_id, observed_at desc);

create index if not exists idx_system_status_monitor_snapshots_stable_status
on public.system_status_monitor_snapshots (stable_status, observed_at desc);

alter table public.system_status_monitor_snapshots enable row level security;

do $$ begin
  create policy "Public can view status monitor snapshots"
  on public.system_status_monitor_snapshots
  for select
  using (true);
exception when duplicate_object then null; end $$;


-- ============================================================================
-- MIGRATION: 080_status_page_hard_reset.sql
-- ============================================================================

-- Reset Hard do Status Page (versÃ£o 2 â€” limpa tambÃ©m o daily lock e deduplicaÃ§Ã£o)
-- Execute no Supabase SQL Editor para zerar todos os cards e recomeÃ§ar do zero.

begin;

-- 1. Remove o lock diÃ¡rio primeiro (para nÃ£o violar FKs)
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'system_incident_daily_lock'
  ) then
    execute 'truncate table public.system_incident_daily_lock restart identity cascade';
  end if;
end $$;

-- 2. Limpa incidentes e tudo relacionado
truncate table public.system_incident_components restart identity cascade;
truncate table public.system_incident_updates    restart identity cascade;
truncate table public.system_incidents           restart identity cascade;

-- 3. Limpa histÃ³rico e pings
truncate table public.system_status_history restart identity cascade;
truncate table public.system_health_pings   restart identity cascade;

-- 4. Tabelas opcionais (existem em alguns ambientes)
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'system_status_monitor_snapshots'
  ) then
    execute 'truncate table public.system_status_monitor_snapshots restart identity cascade';
  end if;

  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'system_status_audit'
  ) then
    execute 'truncate table public.system_status_audit restart identity cascade';
  end if;

  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'system_status_metric_points'
  ) then
    execute 'truncate table public.system_status_metric_points restart identity cascade';
  end if;

  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'system_maintenance_components'
  ) then
    execute 'truncate table public.system_maintenance_components restart identity cascade';
  end if;

  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'system_maintenances'
  ) then
    execute 'truncate table public.system_maintenances restart identity cascade';
  end if;

  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'system_incident_postmortems'
  ) then
    execute 'truncate table public.system_incident_postmortems restart identity cascade';
  end if;

  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'system_status_activity_log'
  ) then
    execute 'truncate table public.system_status_activity_log restart identity cascade';
  end if;

  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'system_status_notification_outbox'
  ) then
    execute 'truncate table public.system_status_notification_outbox restart identity cascade';
  end if;

  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'system_status_runtime_leases'
  ) then
    execute 'truncate table public.system_status_runtime_leases restart identity cascade';
  end if;
end $$;

-- 5. Volta todos os componentes para operational
do $$
declare
  v_sql text := 'update public.system_components set status = ''operational''';
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'system_components' and column_name = 'latency_ms'
  ) then
    v_sql := v_sql || ', latency_ms = null';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'system_components' and column_name = 'status_message'
  ) then
    v_sql := v_sql || ', status_message = null';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'system_components' and column_name = 'last_checked_at'
  ) then
    v_sql := v_sql || ', last_checked_at = null';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'system_components' and column_name = 'last_raw_status'
  ) then
    v_sql := v_sql || ', last_raw_status = null';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'system_components' and column_name = 'last_raw_checked_at'
  ) then
    v_sql := v_sql || ', last_raw_checked_at = null';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'system_components' and column_name = 'last_failure_at'
  ) then
    v_sql := v_sql || ', last_failure_at = null';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'system_components' and column_name = 'last_recovered_at'
  ) then
    v_sql := v_sql || ', last_recovered_at = null';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'system_components' and column_name = 'status_changed_at'
  ) then
    v_sql := v_sql || ', status_changed_at = null';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'system_components' and column_name = 'last_alerted_at'
  ) then
    v_sql := v_sql || ', last_alerted_at = null';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'system_components' and column_name = 'today_failure_count'
  ) then
    v_sql := v_sql || ', today_failure_count = 0';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'system_components' and column_name = 'updated_at'
  ) then
    v_sql := v_sql || ', updated_at = timezone(''utc'', now())';
  end if;

  execute v_sql;
end $$;

commit;


-- ============================================================================
-- MIGRATION: 081_incident_daily_lock.sql
-- ============================================================================

-- Migration 081: Tabela de lock diÃ¡rio de incidentes
-- Garante que o sistema nunca crie mais de 1 incidente por dia.
-- A lÃ³gica da aplicaÃ§Ã£o consulta esta tabela antes de qualquer insert.

begin;

create table if not exists public.system_incident_daily_lock (
  id          bigint generated always as identity primary key,
  day_key     date        not null,          -- ex: '2026-04-16'
  incident_id uuid        not null,          -- FK para o incidente do dia
  created_at  timestamptz not null default timezone('utc', now()),
  updated_at  timestamptz not null default timezone('utc', now()),

  -- Garante unicidade: apenas 1 registro por dia, no nÃ­vel do banco
  constraint system_incident_daily_lock_day_key_unique unique (day_key)
);

-- FK para o incidente (nÃ£o cascade delete â€” queremos manter o lock mesmo se o incidente sumir)
alter table public.system_incident_daily_lock
  add constraint fk_incident_daily_lock_incident
  foreign key (incident_id)
  references public.system_incidents (id)
  on delete set null
  deferrable initially deferred;

-- Permite que incident_id seja null (para o caso de o incidente ter sido deletado)
alter table public.system_incident_daily_lock
  alter column incident_id drop not null;

-- Ãndice para busca rÃ¡pida por data
create index if not exists idx_incident_daily_lock_day_key
  on public.system_incident_daily_lock (day_key desc);

-- RLS: apenas service_role pode ler/escrever
alter table public.system_incident_daily_lock enable row level security;

drop policy if exists "service_role_all" on public.system_incident_daily_lock;
create policy "service_role_all"
  on public.system_incident_daily_lock
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

commit;


-- ============================================================================
-- MIGRATION: 082_status_page_final_boss.sql
-- ============================================================================

begin;

create extension if not exists pgcrypto;

alter table public.system_components
  add column if not exists latency_ms integer,
  add column if not exists source_key text,
  add column if not exists last_failure_at timestamptz,
  add column if not exists today_failure_count integer not null default 0,
  add column if not exists last_recovered_at timestamptz,
  add column if not exists status_changed_at timestamptz;

alter table public.system_incidents
  add column if not exists started_at timestamptz not null default timezone('utc', now()),
  add column if not exists resolved_at timestamptz,
  add column if not exists incident_day date,
  add column if not exists public_summary text,
  add column if not exists ai_summary text,
  add column if not exists component_summary text,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists signal_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists false_alarm_score numeric(5,2) not null default 0;

create table if not exists public.system_status_monitor_snapshots (
  id uuid primary key default gen_random_uuid(),
  source_key text not null,
  component_slug text,
  component_id uuid references public.system_components(id) on delete set null,
  component_name text,
  status public.system_status_type not null,
  stable_status public.system_status_type,
  latency_ms integer,
  response_code integer,
  message text,
  metadata jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.system_incident_daily_lock (
  id bigint generated always as identity primary key,
  day_key date not null,
  incident_id uuid,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint system_incident_daily_lock_day_key_unique unique (day_key)
);

do $$ begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'fk_incident_daily_lock_incident'
      and conrelid = 'public.system_incident_daily_lock'::regclass
  ) then
    alter table public.system_incident_daily_lock
      add constraint fk_incident_daily_lock_incident
      foreign key (incident_id)
      references public.system_incidents (id)
      on delete set null
      deferrable initially deferred;
  end if;
end $$;

alter table public.system_incident_daily_lock enable row level security;

do $$ begin
  create policy "service_role_all"
  on public.system_incident_daily_lock
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
exception when duplicate_object then null; end $$;

create index if not exists idx_system_components_status_changed_at
on public.system_components (status_changed_at desc nulls last);

create index if not exists idx_system_status_monitor_snapshots_component_observed
on public.system_status_monitor_snapshots (component_id, observed_at desc);

create index if not exists idx_system_status_monitor_snapshots_source_observed
on public.system_status_monitor_snapshots (source_key, observed_at desc);

create index if not exists idx_system_status_monitor_snapshots_stable_observed
on public.system_status_monitor_snapshots (stable_status, observed_at desc);

create index if not exists idx_incident_daily_lock_day_key
on public.system_incident_daily_lock (day_key desc);

alter table public.system_status_monitor_snapshots enable row level security;

do $$ begin
  create policy "Public can view status monitor snapshots"
  on public.system_status_monitor_snapshots
  for select
  using (true);
exception when duplicate_object then null; end $$;

create or replace function public.get_status_severity_weight(s public.system_status_type)
returns integer
language plpgsql
immutable
as $$
begin
  return case s
    when 'operational' then 1
    when 'degraded_performance' then 2
    when 'partial_outage' then 3
    when 'major_outage' then 4
    else 0
  end;
end;
$$;

create or replace function public.normalize_status_message(p_text text)
returns text
language sql
immutable
as $$
  select coalesce(
    nullif(
      regexp_replace(lower(trim(coalesce(p_text, ''))), '\s+', ' ', 'g'),
      ''
    ),
    ''
  );
$$;

create or replace function public.system_status_is_incident_worthy(s public.system_status_type)
returns boolean
language sql
immutable
as $$
  select s in ('partial_outage', 'major_outage');
$$;

create or replace function public.system_status_refresh_incident_copy(p_incident_id uuid)
returns void
language plpgsql
as $$
declare
  v_incident_status public.incident_status_type;
  v_has_major boolean := false;
  v_has_partial boolean := false;
  v_component_names text[] := array[]::text[];
  v_component_list text := 'componentes monitorados';
  v_title text;
  v_summary text;
  v_impact public.incident_impact_type;
begin
  select status
  into v_incident_status
  from public.system_incidents
  where id = p_incident_id;

  if not found then
    return;
  end if;

  select
    coalesce(array_agg(sc.name order by sc.display_order, sc.name), array[]::text[]),
    bool_or(sc.status = 'major_outage'),
    bool_or(sc.status = 'partial_outage')
  into v_component_names, v_has_major, v_has_partial
  from public.system_incident_components sic
  join public.system_components sc on sc.id = sic.component_id
  where sic.incident_id = p_incident_id;

  if array_length(v_component_names, 1) is not null then
    v_component_list := array_to_string(v_component_names, ', ');
  end if;

  if v_incident_status = 'resolved' then
    v_title := 'Incidente resolvido';
    v_summary := format(
      'Os sinais voltaram ao normal para %s.',
      v_component_list
    );
    v_impact := 'info';
  elsif v_has_major then
    v_title := 'Falha crÃ­tica detectada';
    v_summary := format(
      'Detectamos indisponibilidade crÃ­tica em %s e estamos investigando.',
      v_component_list
    );
    v_impact := 'critical';
  elsif v_has_partial then
    v_title := 'Instabilidade detectada';
    v_summary := format(
      'Detectamos instabilidade ou indisponibilidade parcial em %s e estamos investigando.',
      v_component_list
    );
    v_impact := 'warning';
  else
    v_title := 'Investigando instabilidade';
    v_summary := format(
      'Estamos acompanhando sinais recentes em %s.',
      v_component_list
    );
    v_impact := 'warning';
  end if;

  update public.system_incidents
  set
    title = v_title,
    public_summary = v_summary,
    component_summary = v_component_list,
    impact = v_impact,
    updated_at = timezone('utc', now())
  where id = p_incident_id;
end;
$$;

create or replace function public.system_status_insert_incident_update(
  p_incident_id uuid,
  p_status public.incident_status_type,
  p_message text
)
returns uuid
language plpgsql
as $$
declare
  v_update_id uuid;
begin
  if p_incident_id is null or coalesce(trim(p_message), '') = '' then
    return null;
  end if;

  insert into public.system_incident_updates (
    incident_id,
    message,
    status
  )
  values (
    p_incident_id,
    trim(p_message),
    p_status
  )
  on conflict do nothing
  returning id into v_update_id;

  return v_update_id;
end;
$$;

update public.system_incidents
set
  started_at = coalesce(started_at, created_at, timezone('utc', now())),
  incident_day = coalesce(
    incident_day,
    timezone('utc', coalesce(started_at, created_at, timezone('utc', now())))::date
  );

do $$
declare
  v_day date;
  v_canonical_id uuid;
  v_status public.incident_status_type;
  v_impact public.incident_impact_type;
  v_created_at timestamptz;
  v_started_at timestamptz;
  v_updated_at timestamptz;
  v_resolved_at timestamptz;
  v_public_summary text;
  v_ai_summary text;
  v_component_summary text;
  v_metadata jsonb;
  v_signal_snapshot jsonb;
  v_false_alarm_score numeric(5,2);
begin
  for v_day in
    select incident_day
    from public.system_incidents
    where incident_day is not null
    group by incident_day
    having count(*) > 1
  loop
    select id
    into v_canonical_id
    from public.system_incidents
    where incident_day = v_day
    order by created_at asc, id asc
    limit 1;

    insert into public.system_incident_components (incident_id, component_id, created_at)
    select
      v_canonical_id,
      sic.component_id,
      min(sic.created_at)
    from public.system_incident_components sic
    join public.system_incidents si on si.id = sic.incident_id
    where si.incident_day = v_day
      and sic.incident_id <> v_canonical_id
    group by sic.component_id
    on conflict (incident_id, component_id) do nothing;

    update public.system_incident_updates
    set incident_id = v_canonical_id
    where incident_id in (
      select id
      from public.system_incidents
      where incident_day = v_day
        and id <> v_canonical_id
    );

    with ranked_updates as (
      select
        id,
        row_number() over (
          partition by
            incident_id,
            status,
            public.normalize_status_message(message)
          order by created_at asc, id asc
        ) as rn
      from public.system_incident_updates
      where incident_id = v_canonical_id
    )
    delete from public.system_incident_updates
    where id in (
      select id
      from ranked_updates
      where rn > 1
    );

    select
      case
        when count(*) filter (where status = 'investigating') > 0 then 'investigating'::public.incident_status_type
        when count(*) filter (where status = 'identified') > 0 then 'identified'::public.incident_status_type
        when count(*) filter (where status = 'monitoring') > 0 then 'monitoring'::public.incident_status_type
        else 'resolved'::public.incident_status_type
      end,
      case
        when count(*) filter (where impact = 'critical') > 0 then 'critical'::public.incident_impact_type
        when count(*) filter (where impact = 'warning') > 0 then 'warning'::public.incident_impact_type
        else 'info'::public.incident_impact_type
      end,
      min(created_at),
      min(coalesce(started_at, created_at)),
      max(updated_at),
      case
        when count(*) filter (where status <> 'resolved') = 0 then max(resolved_at)
        else null
      end,
      (array_agg(public_summary order by updated_at desc) filter (where public_summary is not null))[1],
      (array_agg(ai_summary order by updated_at desc) filter (where ai_summary is not null))[1],
      (array_agg(component_summary order by updated_at desc) filter (where component_summary is not null))[1],
      coalesce((array_agg(metadata order by updated_at desc) filter (where metadata is not null))[1], '{}'::jsonb),
      coalesce((array_agg(signal_snapshot order by updated_at desc) filter (where signal_snapshot is not null))[1], '{}'::jsonb),
      max(false_alarm_score)
    into
      v_status,
      v_impact,
      v_created_at,
      v_started_at,
      v_updated_at,
      v_resolved_at,
      v_public_summary,
      v_ai_summary,
      v_component_summary,
      v_metadata,
      v_signal_snapshot,
      v_false_alarm_score
    from public.system_incidents
    where incident_day = v_day;

    update public.system_incidents
    set
      status = v_status,
      impact = v_impact,
      created_at = v_created_at,
      started_at = coalesce(v_started_at, v_created_at, timezone('utc', now())),
      updated_at = coalesce(v_updated_at, timezone('utc', now())),
      resolved_at = v_resolved_at,
      public_summary = coalesce(v_public_summary, public_summary),
      ai_summary = coalesce(v_ai_summary, ai_summary),
      component_summary = coalesce(v_component_summary, component_summary),
      metadata = coalesce(metadata, '{}'::jsonb) || coalesce(v_metadata, '{}'::jsonb),
      signal_snapshot = coalesce(signal_snapshot, '{}'::jsonb) || coalesce(v_signal_snapshot, '{}'::jsonb),
      false_alarm_score = greatest(coalesce(false_alarm_score, 0), coalesce(v_false_alarm_score, 0))
    where id = v_canonical_id;

    if exists (
      select 1
      from information_schema.tables
      where table_schema = 'public'
        and table_name = 'system_incident_daily_lock'
    ) then
      insert into public.system_incident_daily_lock (day_key, incident_id)
      values (v_day, v_canonical_id)
      on conflict (day_key) do update
      set
        incident_id = excluded.incident_id,
        updated_at = timezone('utc', now());
    end if;

    delete from public.system_incidents
    where incident_day = v_day
      and id <> v_canonical_id;
  end loop;
end;
$$;

with ranked_updates as (
  select
    id,
    row_number() over (
      partition by
        incident_id,
        status,
        public.normalize_status_message(message)
      order by created_at asc, id asc
    ) as rn
  from public.system_incident_updates
)
delete from public.system_incident_updates
where id in (
  select id
  from ranked_updates
  where rn > 1
);

alter table public.system_incidents
  alter column incident_day set not null;

do $$ begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'system_incidents_incident_day_key'
      and conrelid = 'public.system_incidents'::regclass
  ) then
    alter table public.system_incidents
      add constraint system_incidents_incident_day_key unique (incident_day);
  end if;
end $$;

create unique index if not exists idx_system_incident_updates_dedupe
on public.system_incident_updates (
  incident_id,
  status,
  public.normalize_status_message(message)
);

create or replace function public.sync_system_incident_dates()
returns trigger
language plpgsql
as $$
begin
  if new.started_at is null then
    new.started_at := coalesce(new.created_at, timezone('utc', now()));
  end if;

  if new.incident_day is null then
    new.incident_day := timezone('utc', coalesce(new.started_at, new.created_at, timezone('utc', now())))::date;
  end if;

  if new.status = 'resolved' then
    new.resolved_at := coalesce(new.resolved_at, timezone('utc', now()));
  else
    new.resolved_at := null;
  end if;

  new.updated_at := timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists tr_system_incidents_sync_dates on public.system_incidents;
create trigger tr_system_incidents_sync_dates
before insert or update on public.system_incidents
for each row
execute function public.sync_system_incident_dates();

create or replace function public.system_status_sync_daily_lock()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if exists (
      select 1
      from information_schema.tables
      where table_schema = 'public'
        and table_name = 'system_incident_daily_lock'
    ) then
      update public.system_incident_daily_lock
      set
        incident_id = null,
        updated_at = timezone('utc', now())
      where day_key = old.incident_day
        and incident_id = old.id;
    end if;
    return old;
  end if;

  if new.incident_day is not null and exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'system_incident_daily_lock'
  ) then
    insert into public.system_incident_daily_lock (day_key, incident_id)
    values (new.incident_day, new.id)
    on conflict (day_key) do update
    set
      incident_id = excluded.incident_id,
      updated_at = timezone('utc', now());
  end if;

  return new;
end;
$$;

drop trigger if exists tr_system_incidents_daily_lock_sync on public.system_incidents;
create trigger tr_system_incidents_daily_lock_sync
after insert or update or delete on public.system_incidents
for each row
execute function public.system_status_sync_daily_lock();

create or replace function public.system_status_touch_incident_from_update()
returns trigger
language plpgsql
as $$
begin
  update public.system_incidents
  set
    status = new.status,
    resolved_at = case
      when new.status = 'resolved' then coalesce(resolved_at, new.created_at, timezone('utc', now()))
      else null
    end,
    updated_at = coalesce(new.created_at, timezone('utc', now()))
  where id = new.incident_id;

  perform public.system_status_refresh_incident_copy(new.incident_id);
  return new;
end;
$$;

drop trigger if exists tr_system_incident_updates_sync_parent on public.system_incident_updates;
create trigger tr_system_incident_updates_sync_parent
after insert or update on public.system_incident_updates
for each row
execute function public.system_status_touch_incident_from_update();

create or replace function public.system_status_handle_component_transition()
returns trigger
language plpgsql
as $$
declare
  v_incident_id uuid;
  v_incident_day date;
  v_has_open_failures boolean := false;
begin
  if old.status is not distinct from new.status then
    return new;
  end if;

  v_incident_day := timezone('utc', coalesce(new.last_checked_at, timezone('utc', now())))::date;

  if public.system_status_is_incident_worthy(new.status) then
    insert into public.system_incidents (
      title,
      impact,
      status,
      started_at,
      incident_day,
      public_summary,
      component_summary,
      signal_snapshot
    )
    values (
      'Investigando instabilidade',
      case when new.status = 'major_outage' then 'critical'::public.incident_impact_type else 'warning'::public.incident_impact_type end,
      'investigating',
      coalesce(new.last_checked_at, timezone('utc', now())),
      v_incident_day,
      null,
      new.name,
      jsonb_build_object(
        'source', 'component-trigger',
        'component_id', new.id,
        'component_name', new.name,
        'status', new.status,
        'observed_at', coalesce(new.last_checked_at, timezone('utc', now()))
      )
    )
    on conflict (incident_day) do update
    set
      status = case
        when public.system_incidents.status = 'resolved' then 'investigating'::public.incident_status_type
        else public.system_incidents.status
      end,
      impact = case
        when public.system_incidents.impact = 'critical' or excluded.impact = 'critical' then 'critical'::public.incident_impact_type
        when public.system_incidents.impact = 'warning' or excluded.impact = 'warning' then 'warning'::public.incident_impact_type
        else public.system_incidents.impact
      end,
      resolved_at = null,
      updated_at = timezone('utc', now()),
      signal_snapshot = coalesce(public.system_incidents.signal_snapshot, '{}'::jsonb) || excluded.signal_snapshot
    returning id into v_incident_id;

    insert into public.system_incident_components (incident_id, component_id)
    values (v_incident_id, new.id)
    on conflict (incident_id, component_id) do nothing;

    perform public.system_status_refresh_incident_copy(v_incident_id);
    perform public.system_status_insert_incident_update(
      v_incident_id,
      'investigating',
      format('Detectamos instabilidade no %s e estamos investigando.', new.name)
    );

    return new;
  end if;

  select si.id
  into v_incident_id
  from public.system_incidents si
  join public.system_incident_components sic on sic.incident_id = si.id
  where sic.component_id = new.id
    and si.status <> 'resolved'
  order by si.incident_day desc, si.updated_at desc
  limit 1;

  if v_incident_id is null then
    return new;
  end if;

  select exists (
    select 1
    from public.system_incident_components sic
    join public.system_components sc on sc.id = sic.component_id
    where sic.incident_id = v_incident_id
      and public.system_status_is_incident_worthy(sc.status)
  )
  into v_has_open_failures;

  if not v_has_open_failures then
    update public.system_incidents
    set
      status = 'resolved',
      resolved_at = coalesce(new.last_checked_at, timezone('utc', now())),
      updated_at = coalesce(new.last_checked_at, timezone('utc', now()))
    where id = v_incident_id;

    perform public.system_status_insert_incident_update(
      v_incident_id,
      'resolved',
      'Os sinais voltaram ao normal e o incidente foi resolvido.'
    );

    perform public.system_status_refresh_incident_copy(v_incident_id);
  end if;

  return new;
end;
$$;

drop trigger if exists tr_system_components_manage_daily_incident on public.system_components;
create trigger tr_system_components_manage_daily_incident
after update on public.system_components
for each row
execute function public.system_status_handle_component_transition();

create or replace function public.system_status_ingest_check(
  p_component_name text,
  p_raw_status public.system_status_type,
  p_latency_ms integer default null,
  p_message text default null,
  p_response_code integer default null,
  p_source_key text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_observed_at timestamptz default timezone('utc', now())
)
returns table (
  component_id uuid,
  stable_status public.system_status_type,
  raw_status public.system_status_type,
  should_alert boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_component public.system_components%rowtype;
  v_snapshot_id uuid;
  v_previous_stable public.system_status_type;
  v_next_stable public.system_status_type;
  v_failures_last3 integer := 0;
  v_majors_last2 integer := 0;
  v_operational_last2 integer := 0;
  v_degraded_last3 integer := 0;
  v_today date := timezone('utc', coalesce(p_observed_at, timezone('utc', now())))::date;
begin
  select *
  into v_component
  from public.system_components
  where name = p_component_name
  limit 1;

  if not found then
    raise exception 'Componente de status nao encontrado: %', p_component_name;
  end if;

  v_previous_stable := coalesce(v_component.status, 'operational');

  insert into public.system_status_monitor_snapshots (
    source_key,
    component_slug,
    component_id,
    component_name,
    status,
    latency_ms,
    response_code,
    message,
    metadata,
    observed_at
  )
  values (
    coalesce(p_source_key, v_component.source_key, v_component.slug, lower(regexp_replace(v_component.name, '[^a-zA-Z0-9]+', '-', 'g'))),
    v_component.slug,
    v_component.id,
    v_component.name,
    p_raw_status,
    p_latency_ms,
    p_response_code,
    p_message,
    coalesce(p_metadata, '{}'::jsonb),
    coalesce(p_observed_at, timezone('utc', now()))
  )
  returning id into v_snapshot_id;

  with recent as (
    select
      status,
      row_number() over (order by observed_at desc, id desc) as rn
    from public.system_status_monitor_snapshots
    where component_id = v_component.id
    order by observed_at desc, id desc
    limit 5
  )
  select
    count(*) filter (where rn <= 3 and status in ('partial_outage', 'major_outage')),
    count(*) filter (where rn <= 2 and status = 'major_outage'),
    count(*) filter (where rn <= 2 and status = 'operational'),
    count(*) filter (where rn <= 3 and status = 'degraded_performance')
  into
    v_failures_last3,
    v_majors_last2,
    v_operational_last2,
    v_degraded_last3
  from recent;

  v_next_stable := v_previous_stable;

  if p_raw_status = 'major_outage' and v_majors_last2 >= 2 then
    v_next_stable := 'major_outage';
  elsif p_raw_status in ('partial_outage', 'major_outage') and v_failures_last3 >= 2 then
    v_next_stable := case
      when v_majors_last2 >= 2 then 'major_outage'
      else 'partial_outage'
    end;
  elsif p_raw_status = 'degraded_performance' and v_degraded_last3 >= 3 then
    v_next_stable := 'degraded_performance';
  elsif p_raw_status = 'operational' and v_operational_last2 >= 2 then
    v_next_stable := 'operational';
  end if;

  if v_component.name = 'Flow AI' and v_next_stable = 'degraded_performance' then
    v_next_stable := 'operational';
  end if;

  update public.system_status_monitor_snapshots
  set stable_status = v_next_stable
  where id = v_snapshot_id;

  update public.system_components
  set
    status = v_next_stable,
    latency_ms = p_latency_ms,
    source_key = coalesce(p_source_key, source_key),
    status_message = p_message,
    last_checked_at = coalesce(p_observed_at, timezone('utc', now())),
    last_raw_status = p_raw_status,
    last_raw_checked_at = coalesce(p_observed_at, timezone('utc', now())),
    status_changed_at = case
      when status is distinct from v_next_stable then coalesce(p_observed_at, timezone('utc', now()))
      else status_changed_at
    end,
    last_failure_at = case
      when public.system_status_is_incident_worthy(v_next_stable) then coalesce(p_observed_at, timezone('utc', now()))
      else last_failure_at
    end,
    last_recovered_at = case
      when v_next_stable = 'operational' and status <> 'operational' then coalesce(p_observed_at, timezone('utc', now()))
      else last_recovered_at
    end,
    today_failure_count = case
      when public.system_status_is_incident_worthy(v_next_stable) and status = 'operational' then
        case
          when last_failure_at is not null
            and timezone('utc', last_failure_at)::date = v_today
          then coalesce(today_failure_count, 0) + 1
          else 1
        end
      when last_failure_at is not null
        and timezone('utc', last_failure_at)::date <> v_today
      then 0
      else coalesce(today_failure_count, 0)
    end,
    updated_at = timezone('utc', now()),
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'last_raw_status', p_raw_status,
      'last_stable_status', v_next_stable,
      'last_message', p_message,
      'last_response_code', p_response_code,
      'last_monitor_metadata', coalesce(p_metadata, '{}'::jsonb)
    )
  where id = v_component.id;

  insert into public.system_status_history (
    component_id,
    status,
    recorded_at
  )
  values (
    v_component.id,
    v_next_stable,
    v_today
  )
  on conflict (component_id, recorded_at) do update
  set status = case
    when public.get_status_severity_weight(excluded.status) > public.get_status_severity_weight(public.system_status_history.status)
    then excluded.status
    else public.system_status_history.status
  end;

  return query
  select
    v_component.id,
    v_next_stable,
    p_raw_status,
    public.system_status_is_incident_worthy(v_next_stable);
end;
$$;

create or replace view public.system_incident_feed as
with canonical as (
  select
    si.*,
    row_number() over (
      partition by si.incident_day
      order by si.created_at asc, si.id asc
    ) as rn
  from public.system_incidents si
)
select
  si.id,
  si.title,
  si.impact,
  si.status,
  si.created_at,
  si.updated_at,
  si.started_at,
  si.resolved_at,
  si.incident_day,
  coalesce(
    si.public_summary,
    si.ai_summary,
    si.component_summary,
    last_update.message,
    'Ocorrencia registrada e monitorada pela equipe.'
  ) as summary,
  coalesce(component_names.names, array[]::text[]) as affected_components
from canonical si
left join lateral (
  select siu.message
  from public.system_incident_updates siu
  where siu.incident_id = si.id
  order by siu.created_at desc, siu.id desc
  limit 1
) as last_update on true
left join lateral (
  select array_agg(distinct sc.name order by sc.name) as names
  from public.system_incident_components sic
  join public.system_components sc on sc.id = sic.component_id
  where sic.incident_id = si.id
) as component_names on true
where si.rn = 1;

commit;


-- ============================================================================
-- MIGRATION: 083_status_page_enterprise_hardening.sql
-- ============================================================================

create extension if not exists pgcrypto;

do $$
begin
  alter type public.system_status_type add value 'under_maintenance';
exception
  when duplicate_object then null;
end $$;

begin;

do $$ begin
  create type public.system_maintenance_status_type as enum (
    'scheduled',
    'in_progress',
    'completed',
    'cancelled'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.system_dependency_type as enum (
    'hard',
    'soft',
    'external'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.system_outbox_status_type as enum (
    'pending',
    'processing',
    'sent',
    'failed',
    'dead_letter'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.system_component_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null,
  description text,
  display_order integer not null default 0,
  is_public boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint system_component_groups_name_key unique (name),
  constraint system_component_groups_slug_key unique (slug)
);

alter table public.system_components
  add column if not exists group_id uuid references public.system_component_groups(id) on delete set null,
  add column if not exists monitoring_enabled boolean not null default true,
  add column if not exists sla_target numeric(6,3) not null default 99.900,
  add column if not exists last_alerted_at timestamptz,
  add column if not exists public_description text,
  add column if not exists external_reference text;

create table if not exists public.system_component_dependencies (
  id uuid primary key default gen_random_uuid(),
  component_id uuid not null references public.system_components(id) on delete cascade,
  depends_on_component_id uuid not null references public.system_components(id) on delete cascade,
  dependency_type public.system_dependency_type not null default 'hard',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  constraint system_component_dependencies_unique unique (component_id, depends_on_component_id)
);

create table if not exists public.system_status_monitor_policies (
  component_id uuid primary key references public.system_components(id) on delete cascade,
  evaluation_window integer not null default 5,
  failure_quorum integer not null default 2,
  major_quorum integer not null default 2,
  degraded_quorum integer not null default 3,
  recovery_quorum integer not null default 2,
  latency_degraded_ms integer,
  latency_partial_ms integer,
  latency_major_ms integer,
  min_confidence_pct numeric(5,2) not null default 66.67,
  allow_degraded_status boolean not null default true,
  allow_degraded_incident boolean not null default false,
  alert_cooldown_minutes integer not null default 60,
  incident_cooldown_minutes integer not null default 180,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint system_status_monitor_policies_window_check check (evaluation_window >= 3),
  constraint system_status_monitor_policies_quorum_check check (
    failure_quorum >= 1
    and major_quorum >= 1
    and degraded_quorum >= 1
    and recovery_quorum >= 1
  )
);

alter table public.system_status_monitor_snapshots
  add column if not exists sample_size integer not null default 1,
  add column if not exists success_count integer not null default 0,
  add column if not exists degraded_count integer not null default 0,
  add column if not exists failure_count integer not null default 0,
  add column if not exists checker_key text,
  add column if not exists checker_region text,
  add column if not exists confidence_score numeric(5,2),
  add column if not exists policy_snapshot jsonb not null default '{}'::jsonb;

create table if not exists public.system_status_metric_definitions (
  id uuid primary key default gen_random_uuid(),
  component_id uuid not null references public.system_components(id) on delete cascade,
  metric_key text not null,
  display_name text not null,
  unit text not null default 'count',
  aggregation text not null default 'last',
  is_public boolean not null default true,
  display_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint system_status_metric_definitions_unique unique (component_id, metric_key)
);

create table if not exists public.system_status_metric_points (
  id uuid primary key default gen_random_uuid(),
  metric_id uuid not null references public.system_status_metric_definitions(id) on delete cascade,
  bucket_at timestamptz not null,
  numeric_value numeric(20,6) not null,
  sample_size integer not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  constraint system_status_metric_points_unique unique (metric_id, bucket_at)
);

create table if not exists public.system_maintenances (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  message text,
  status public.system_maintenance_status_type not null default 'scheduled',
  scheduled_for timestamptz not null,
  scheduled_until timestamptz not null,
  started_at timestamptz,
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.system_maintenance_components (
  id uuid primary key default gen_random_uuid(),
  maintenance_id uuid not null references public.system_maintenances(id) on delete cascade,
  component_id uuid not null references public.system_components(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  constraint system_maintenance_components_unique unique (maintenance_id, component_id)
);

create table if not exists public.system_incident_postmortems (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.system_incidents(id) on delete cascade,
  title text not null,
  summary text,
  root_cause text,
  resolution text,
  preventive_actions jsonb not null default '[]'::jsonb,
  published_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint system_incident_postmortems_incident_unique unique (incident_id)
);

create table if not exists public.system_status_activity_log (
  id uuid primary key default gen_random_uuid(),
  actor_type text not null default 'system',
  actor_id text,
  entity_type text not null,
  entity_id text not null,
  action text not null,
  message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.system_status_notification_outbox (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null,
  event_type text not null,
  component_id uuid references public.system_components(id) on delete set null,
  incident_id uuid references public.system_incidents(id) on delete set null,
  status public.system_outbox_status_type not null default 'pending',
  payload jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  available_at timestamptz not null default timezone('utc', now()),
  locked_at timestamptz,
  delivered_at timestamptz,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint system_status_notification_outbox_dedupe_key unique (dedupe_key)
);

create table if not exists public.system_status_subscription_components (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.system_status_subscriptions(id) on delete cascade,
  component_id uuid not null references public.system_components(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  constraint system_status_subscription_components_unique unique (subscription_id, component_id)
);

create index if not exists idx_system_components_group_id
on public.system_components (group_id, display_order, name);

create index if not exists idx_system_component_dependencies_component
on public.system_component_dependencies (component_id);

create index if not exists idx_system_component_dependencies_depends_on
on public.system_component_dependencies (depends_on_component_id);

create index if not exists idx_system_status_monitor_policies_updated_at
on public.system_status_monitor_policies (updated_at desc);

create index if not exists idx_system_status_monitor_snapshots_checker
on public.system_status_monitor_snapshots (checker_key, checker_region, observed_at desc);

create index if not exists idx_system_status_metric_points_metric_bucket
on public.system_status_metric_points (metric_id, bucket_at desc);

create index if not exists idx_system_maintenances_status_window
on public.system_maintenances (status, scheduled_for desc, scheduled_until desc);

create index if not exists idx_system_maintenance_components_component
on public.system_maintenance_components (component_id);

create index if not exists idx_system_status_activity_log_entity
on public.system_status_activity_log (entity_type, entity_id, created_at desc);

create index if not exists idx_system_status_notification_outbox_status_available
on public.system_status_notification_outbox (status, available_at, created_at);

create index if not exists idx_system_status_subscription_components_subscription
on public.system_status_subscription_components (subscription_id);

alter table public.system_component_groups enable row level security;
alter table public.system_component_dependencies enable row level security;
alter table public.system_status_monitor_policies enable row level security;
alter table public.system_status_metric_definitions enable row level security;
alter table public.system_status_metric_points enable row level security;
alter table public.system_maintenances enable row level security;
alter table public.system_maintenance_components enable row level security;
alter table public.system_incident_postmortems enable row level security;
alter table public.system_status_activity_log enable row level security;
alter table public.system_status_notification_outbox enable row level security;
alter table public.system_status_subscription_components enable row level security;

do $$ begin
  create policy "Public can view component groups"
  on public.system_component_groups
  for select
  using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Public can view component dependencies"
  on public.system_component_dependencies
  for select
  using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Public can view metric definitions"
  on public.system_status_metric_definitions
  for select
  using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Public can view metric points"
  on public.system_status_metric_points
  for select
  using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Public can view maintenances"
  on public.system_maintenances
  for select
  using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Public can view maintenance components"
  on public.system_maintenance_components
  for select
  using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Public can view incident postmortems"
  on public.system_incident_postmortems
  for select
  using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Public can view component subscriptions"
  on public.system_status_subscription_components
  for select
  using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "service_role_manage_monitor_policies"
  on public.system_status_monitor_policies
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "service_role_manage_component_groups"
  on public.system_component_groups
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "service_role_manage_component_dependencies"
  on public.system_component_dependencies
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "service_role_manage_metric_definitions"
  on public.system_status_metric_definitions
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "service_role_manage_metric_points"
  on public.system_status_metric_points
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "service_role_manage_maintenances"
  on public.system_maintenances
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "service_role_manage_maintenance_components"
  on public.system_maintenance_components
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "service_role_manage_postmortems"
  on public.system_incident_postmortems
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "service_role_manage_subscription_components"
  on public.system_status_subscription_components
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "service_role_manage_activity_log"
  on public.system_status_activity_log
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "service_role_manage_outbox"
  on public.system_status_notification_outbox
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
exception when duplicate_object then null; end $$;

create or replace function public.system_status_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists tr_system_component_groups_touch_updated_at on public.system_component_groups;
create trigger tr_system_component_groups_touch_updated_at
before update on public.system_component_groups
for each row
execute function public.system_status_touch_updated_at();

drop trigger if exists tr_system_status_monitor_policies_touch_updated_at on public.system_status_monitor_policies;
create trigger tr_system_status_monitor_policies_touch_updated_at
before update on public.system_status_monitor_policies
for each row
execute function public.system_status_touch_updated_at();

drop trigger if exists tr_system_status_metric_definitions_touch_updated_at on public.system_status_metric_definitions;
create trigger tr_system_status_metric_definitions_touch_updated_at
before update on public.system_status_metric_definitions
for each row
execute function public.system_status_touch_updated_at();

drop trigger if exists tr_system_maintenances_touch_updated_at on public.system_maintenances;
create trigger tr_system_maintenances_touch_updated_at
before update on public.system_maintenances
for each row
execute function public.system_status_touch_updated_at();

drop trigger if exists tr_system_incident_postmortems_touch_updated_at on public.system_incident_postmortems;
create trigger tr_system_incident_postmortems_touch_updated_at
before update on public.system_incident_postmortems
for each row
execute function public.system_status_touch_updated_at();

drop trigger if exists tr_system_status_notification_outbox_touch_updated_at on public.system_status_notification_outbox;
create trigger tr_system_status_notification_outbox_touch_updated_at
before update on public.system_status_notification_outbox
for each row
execute function public.system_status_touch_updated_at();

insert into public.system_component_groups (name, slug, description, display_order, metadata)
values
  ('Core Platform', 'core-platform', 'Servicos centrais da plataforma e APIs publicas.', 1, '{"tier":"core"}'::jsonb),
  ('Data and Storage', 'data-storage', 'Persistencia, banco de dados e ativos armazenados.', 2, '{"tier":"data"}'::jsonb),
  ('Edge and Delivery', 'edge-delivery', 'DNS, SSL, CDN e camadas de entrega.', 3, '{"tier":"edge"}'::jsonb),
  ('Automation and Bot', 'automation-bot', 'Jobs, automacoes, notificacoes e bot.', 4, '{"tier":"automation"}'::jsonb),
  ('Billing and Trust', 'billing-trust', 'Pagamentos, auditoria e sinais de confianca.', 5, '{"tier":"business"}'::jsonb)
on conflict (slug) do update
set
  name = excluded.name,
  description = excluded.description,
  display_order = excluded.display_order,
  metadata = public.system_component_groups.metadata || excluded.metadata;

update public.system_components sc
set group_id = cg.id
from public.system_component_groups cg
where sc.group_id is null
  and (
    (cg.slug = 'core-platform' and sc.name in ('API', 'Flow AI', 'Painel de controle'))
    or (cg.slug = 'data-storage' and sc.name in ('Armazenamento DB', 'Cache', 'Registros de auditoria'))
    or (cg.slug = 'edge-delivery' and sc.name in ('DNS', 'CDN', 'Certificado SSL', 'Registro de domÃ­nio', 'Rede', 'Firewall DNS'))
    or (cg.slug = 'automation-bot' and sc.name in ('DISCORD BOT', 'NotificaÃ§Ãµes', 'Tarefas agendadas'))
    or (cg.slug = 'billing-trust' and sc.name in ('Pagamentos e transaÃ§Ãµes', 'Analises da Web'))
  );

insert into public.system_component_dependencies (component_id, depends_on_component_id, dependency_type, metadata)
select c.id, d.id, x.dependency_type, x.metadata
from (
  values
    ('Painel de controle', 'API', 'hard'::public.system_dependency_type, '{"reason":"dashboard-requests"}'::jsonb),
    ('Painel de controle', 'Armazenamento DB', 'hard'::public.system_dependency_type, '{"reason":"dashboard-state"}'::jsonb),
    ('Painel de controle', 'CDN', 'soft'::public.system_dependency_type, '{"reason":"assets"}'::jsonb),
    ('Flow AI', 'API', 'soft'::public.system_dependency_type, '{"reason":"internal-routing"}'::jsonb),
    ('Flow AI', 'Armazenamento DB', 'soft'::public.system_dependency_type, '{"reason":"state"}'::jsonb),
    ('NotificaÃ§Ãµes', 'DISCORD BOT', 'hard'::public.system_dependency_type, '{"reason":"delivery"}'::jsonb),
    ('Pagamentos e transaÃ§Ãµes', 'API', 'hard'::public.system_dependency_type, '{"reason":"checkout"}'::jsonb),
    ('Pagamentos e transaÃ§Ãµes', 'Armazenamento DB', 'hard'::public.system_dependency_type, '{"reason":"reconciliation"}'::jsonb),
    ('API', 'Armazenamento DB', 'hard'::public.system_dependency_type, '{"reason":"primary-data-store"}'::jsonb),
    ('API', 'DNS', 'soft'::public.system_dependency_type, '{"reason":"routing"}'::jsonb),
    ('API', 'Certificado SSL', 'soft'::public.system_dependency_type, '{"reason":"tls"}'::jsonb)
) as x(component_name, depends_on_name, dependency_type, metadata)
join public.system_components c on c.name = x.component_name
join public.system_components d on d.name = x.depends_on_name
on conflict (component_id, depends_on_component_id) do update
set
  dependency_type = excluded.dependency_type,
  metadata = excluded.metadata;

insert into public.system_status_monitor_policies (
  component_id,
  evaluation_window,
  failure_quorum,
  major_quorum,
  degraded_quorum,
  recovery_quorum,
  latency_degraded_ms,
  latency_partial_ms,
  latency_major_ms,
  min_confidence_pct,
  allow_degraded_status,
  allow_degraded_incident,
  alert_cooldown_minutes,
  incident_cooldown_minutes,
  metadata
)
select
  sc.id,
  x.evaluation_window,
  x.failure_quorum,
  x.major_quorum,
  x.degraded_quorum,
  x.recovery_quorum,
  x.latency_degraded_ms,
  x.latency_partial_ms,
  x.latency_major_ms,
  x.min_confidence_pct,
  x.allow_degraded_status,
  x.allow_degraded_incident,
  x.alert_cooldown_minutes,
  x.incident_cooldown_minutes,
  x.metadata
from public.system_components sc
join (
  values
    ('Flow AI', 5, 2, 2, 4, 2, 4500, 7000, 12000, 80.00::numeric(5,2), true, false, 90, 240, '{"profile":"ai-strict"}'::jsonb),
    ('API', 5, 2, 2, 3, 2, 1800, 3500, 7000, 75.00::numeric(5,2), true, false, 60, 180, '{"profile":"api-core"}'::jsonb),
    ('CDN', 5, 3, 3, 3, 2, 1500, 2500, 5000, 75.00::numeric(5,2), true, false, 60, 180, '{"profile":"edge"}'::jsonb),
    ('DNS', 5, 3, 3, 3, 2, null, null, null, 75.00::numeric(5,2), false, false, 60, 180, '{"profile":"dns"}'::jsonb),
    ('Certificado SSL', 5, 2, 2, 3, 2, null, null, null, 75.00::numeric(5,2), false, false, 60, 180, '{"profile":"tls"}'::jsonb),
    ('Rede', 5, 3, 3, 4, 2, 2000, 3500, 6000, 80.00::numeric(5,2), true, false, 60, 180, '{"profile":"network"}'::jsonb),
    ('Armazenamento DB', 5, 2, 2, 3, 2, null, null, null, 80.00::numeric(5,2), false, false, 60, 180, '{"profile":"database"}'::jsonb),
    ('DISCORD BOT', 5, 2, 2, 3, 2, 1200, 2500, 5000, 75.00::numeric(5,2), true, false, 60, 180, '{"profile":"bot"}'::jsonb)
) as x(
  component_name,
  evaluation_window,
  failure_quorum,
  major_quorum,
  degraded_quorum,
  recovery_quorum,
  latency_degraded_ms,
  latency_partial_ms,
  latency_major_ms,
  min_confidence_pct,
  allow_degraded_status,
  allow_degraded_incident,
  alert_cooldown_minutes,
  incident_cooldown_minutes,
  metadata
) on x.component_name = sc.name
on conflict (component_id) do update
set
  evaluation_window = excluded.evaluation_window,
  failure_quorum = excluded.failure_quorum,
  major_quorum = excluded.major_quorum,
  degraded_quorum = excluded.degraded_quorum,
  recovery_quorum = excluded.recovery_quorum,
  latency_degraded_ms = excluded.latency_degraded_ms,
  latency_partial_ms = excluded.latency_partial_ms,
  latency_major_ms = excluded.latency_major_ms,
  min_confidence_pct = excluded.min_confidence_pct,
  allow_degraded_status = excluded.allow_degraded_status,
  allow_degraded_incident = excluded.allow_degraded_incident,
  alert_cooldown_minutes = excluded.alert_cooldown_minutes,
  incident_cooldown_minutes = excluded.incident_cooldown_minutes,
  metadata = public.system_status_monitor_policies.metadata || excluded.metadata;

create or replace function public.get_status_severity_weight(s public.system_status_type)
returns integer
language plpgsql
immutable
as $$
begin
  return case s
    when 'operational' then 1
    when 'degraded_performance' then 2
    when 'partial_outage' then 3
    when 'major_outage' then 4
    else 0
  end;
end;
$$;

create or replace function public.system_status_record_metric(
  p_component_name text,
  p_metric_key text,
  p_numeric_value numeric,
  p_unit text default 'count',
  p_bucket_at timestamptz default timezone('utc', now()),
  p_sample_size integer default 1,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_component_id uuid;
  v_metric_id uuid;
begin
  select id
  into v_component_id
  from public.system_components
  where name = p_component_name
  limit 1;

  if v_component_id is null or p_metric_key is null or p_numeric_value is null then
    return null;
  end if;

  insert into public.system_status_metric_definitions (
    component_id,
    metric_key,
    display_name,
    unit,
    aggregation
  )
  values (
    v_component_id,
    p_metric_key,
    initcap(replace(p_metric_key, '_', ' ')),
    coalesce(p_unit, 'count'),
    'last'
  )
  on conflict (component_id, metric_key) do update
  set
    display_name = excluded.display_name,
    unit = excluded.unit,
    updated_at = timezone('utc', now())
  returning id into v_metric_id;

  insert into public.system_status_metric_points (
    metric_id,
    bucket_at,
    numeric_value,
    sample_size,
    metadata
  )
  values (
    v_metric_id,
    date_trunc('minute', coalesce(p_bucket_at, timezone('utc', now()))),
    p_numeric_value,
    greatest(coalesce(p_sample_size, 1), 1),
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (metric_id, bucket_at) do update
  set
    numeric_value = excluded.numeric_value,
    sample_size = excluded.sample_size,
    metadata = public.system_status_metric_points.metadata || excluded.metadata;

  return v_metric_id;
end;
$$;

create or replace function public.system_status_insert_activity(
  p_entity_type text,
  p_entity_id text,
  p_action text,
  p_message text,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.system_status_activity_log (
    entity_type,
    entity_id,
    action,
    message,
    metadata
  )
  values (
    coalesce(p_entity_type, 'unknown'),
    coalesce(p_entity_id, 'unknown'),
    coalesce(p_action, 'unknown'),
    p_message,
    coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.system_status_enqueue_outbox(
  p_dedupe_key text,
  p_event_type text,
  p_component_id uuid default null,
  p_incident_id uuid default null,
  p_payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if coalesce(trim(p_dedupe_key), '') = '' then
    return null;
  end if;

  insert into public.system_status_notification_outbox (
    dedupe_key,
    event_type,
    component_id,
    incident_id,
    payload
  )
  values (
    trim(p_dedupe_key),
    coalesce(p_event_type, 'status_event'),
    p_component_id,
    p_incident_id,
    coalesce(p_payload, '{}'::jsonb)
  )
  on conflict (dedupe_key) do update
  set
    event_type = excluded.event_type,
    component_id = coalesce(excluded.component_id, public.system_status_notification_outbox.component_id),
    incident_id = coalesce(excluded.incident_id, public.system_status_notification_outbox.incident_id),
    payload = public.system_status_notification_outbox.payload || excluded.payload,
    available_at = timezone('utc', now())
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.system_status_log_component_status_change()
returns trigger
language plpgsql
as $$
begin
  if old.status is distinct from new.status then
    perform public.system_status_insert_activity(
      'component',
      new.id::text,
      'status_changed',
      format('%s mudou de %s para %s.', new.name, old.status, new.status),
      jsonb_build_object(
        'component_name', new.name,
        'old_status', old.status,
        'new_status', new.status,
        'status_message', new.status_message
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists tr_system_components_activity_log on public.system_components;
create trigger tr_system_components_activity_log
after update on public.system_components
for each row
execute function public.system_status_log_component_status_change();

create or replace function public.system_status_log_incident_change()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    perform public.system_status_insert_activity(
      'incident',
      new.id::text,
      'incident_created',
      new.title,
      jsonb_build_object(
        'status', new.status,
        'impact', new.impact,
        'incident_day', new.incident_day
      )
    );
  elsif old.status is distinct from new.status or old.impact is distinct from new.impact then
    perform public.system_status_insert_activity(
      'incident',
      new.id::text,
      'incident_updated',
      format('Incidente %s mudou para %s.', new.title, new.status),
      jsonb_build_object(
        'old_status', old.status,
        'new_status', new.status,
        'old_impact', old.impact,
        'new_impact', new.impact
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists tr_system_incidents_activity_log on public.system_incidents;
create trigger tr_system_incidents_activity_log
after insert or update on public.system_incidents
for each row
execute function public.system_status_log_incident_change();

create or replace function public.system_status_log_incident_update_change()
returns trigger
language plpgsql
as $$
begin
  perform public.system_status_insert_activity(
    'incident_update',
    new.id::text,
    'incident_update_created',
    new.message,
    jsonb_build_object(
      'incident_id', new.incident_id,
      'status', new.status
    )
  );
  return new;
end;
$$;

drop trigger if exists tr_system_incident_updates_activity_log on public.system_incident_updates;
create trigger tr_system_incident_updates_activity_log
after insert on public.system_incident_updates
for each row
execute function public.system_status_log_incident_update_change();

create or replace function public.system_status_log_maintenance_change()
returns trigger
language plpgsql
as $$
begin
  perform public.system_status_insert_activity(
    'maintenance',
    new.id::text,
    case when tg_op = 'INSERT' then 'maintenance_created' else 'maintenance_updated' end,
    new.title,
    jsonb_build_object(
      'status', new.status,
      'scheduled_for', new.scheduled_for,
      'scheduled_until', new.scheduled_until
    )
  );
  return new;
end;
$$;

drop trigger if exists tr_system_maintenances_activity_log on public.system_maintenances;
create trigger tr_system_maintenances_activity_log
after insert or update on public.system_maintenances
for each row
execute function public.system_status_log_maintenance_change();

create or replace function public.system_status_ingest_check(
  p_component_name text,
  p_raw_status public.system_status_type,
  p_latency_ms integer default null,
  p_message text default null,
  p_response_code integer default null,
  p_source_key text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_observed_at timestamptz default timezone('utc', now())
)
returns table (
  component_id uuid,
  stable_status public.system_status_type,
  raw_status public.system_status_type,
  should_alert boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_component public.system_components%rowtype;
  v_policy public.system_status_monitor_policies%rowtype;
  v_snapshot_id uuid;
  v_previous_stable public.system_status_type;
  v_next_stable public.system_status_type;
  v_failures_recent integer := 0;
  v_majors_recent integer := 0;
  v_operational_recent integer := 0;
  v_degraded_recent integer := 0;
  v_today date := timezone('utc', coalesce(p_observed_at, timezone('utc', now())))::date;
  v_sample_size integer := greatest(coalesce(nullif(p_metadata ->> 'sampleSize', '')::integer, 1), 1);
  v_success_count integer := 0;
  v_degraded_count integer := 0;
  v_failure_count integer := 0;
  v_checker_key text := coalesce(nullif(p_metadata ->> 'checkerKey', ''), 'internal-status-monitor');
  v_checker_region text := nullif(p_metadata ->> 'checkerRegion', '');
  v_confidence_score numeric(5,2);
  v_has_active_maintenance boolean := false;
  v_should_alert boolean := false;
  v_success_ratio numeric(5,2);
  v_effective_message text;
begin
  select *
  into v_component
  from public.system_components
  where name = p_component_name
  limit 1;

  if not found then
    raise exception 'Componente de status nao encontrado: %', p_component_name;
  end if;

  select *
  into v_policy
  from public.system_status_monitor_policies p
  where p.component_id = v_component.id;

  if not found then
    insert into public.system_status_monitor_policies (component_id)
    values (v_component.id)
    returning * into v_policy;
  end if;

  v_success_count := greatest(
    coalesce(
      nullif(p_metadata ->> 'successCount', '')::integer,
      case when p_raw_status = 'operational' then v_sample_size else 0 end
    ),
    0
  );
  v_degraded_count := greatest(
    coalesce(
      nullif(p_metadata ->> 'degradedCount', '')::integer,
      case when p_raw_status = 'degraded_performance' then v_sample_size else 0 end
    ),
    0
  );
  v_failure_count := greatest(
    coalesce(
      nullif(p_metadata ->> 'failureCount', '')::integer,
      case when p_raw_status in ('partial_outage', 'major_outage') then v_sample_size else 0 end
    ),
    0
  );

  v_confidence_score := coalesce(
    nullif(p_metadata ->> 'confidenceScore', '')::numeric(5,2),
    round(
      (
        greatest(v_success_count, v_degraded_count, v_failure_count)::numeric
        / greatest(v_sample_size, 1)::numeric
      ) * 100,
      2
    )::numeric(5,2)
  );

  v_success_ratio := round(
    (
      greatest(v_success_count, 0)::numeric
      / greatest(v_sample_size, 1)::numeric
    ) * 100,
    2
  )::numeric(5,2);

  select exists (
    select 1
    from public.system_maintenances sm
    join public.system_maintenance_components smc on smc.maintenance_id = sm.id
    where smc.component_id = v_component.id
      and sm.status in ('scheduled', 'in_progress')
      and coalesce(p_observed_at, timezone('utc', now())) between sm.scheduled_for and sm.scheduled_until
  )
  into v_has_active_maintenance;

  v_previous_stable := coalesce(v_component.status, 'operational');

  insert into public.system_status_monitor_snapshots (
    source_key,
    component_slug,
    component_id,
    component_name,
    status,
    stable_status,
    latency_ms,
    response_code,
    message,
    metadata,
    observed_at,
    sample_size,
    success_count,
    degraded_count,
    failure_count,
    checker_key,
    checker_region,
    confidence_score,
    policy_snapshot
  )
  values (
    coalesce(p_source_key, v_component.source_key, v_component.slug, lower(regexp_replace(v_component.name, '[^a-zA-Z0-9]+', '-', 'g'))),
    v_component.slug,
    v_component.id,
    v_component.name,
    p_raw_status,
    null,
    p_latency_ms,
    p_response_code,
    p_message,
    coalesce(p_metadata, '{}'::jsonb),
    coalesce(p_observed_at, timezone('utc', now())),
    v_sample_size,
    v_success_count,
    v_degraded_count,
    v_failure_count,
    v_checker_key,
    v_checker_region,
    v_confidence_score,
    to_jsonb(v_policy)
  )
  returning id into v_snapshot_id;

  with recent as (
    select
      s.status,
      row_number() over (order by s.observed_at desc, s.id desc) as rn
    from public.system_status_monitor_snapshots s
    where s.component_id = v_component.id
    order by s.observed_at desc, s.id desc
    limit greatest(v_policy.evaluation_window, 5)
  )
  select
    count(*) filter (where rn <= v_policy.evaluation_window and status in ('partial_outage', 'major_outage')),
    count(*) filter (where rn <= v_policy.evaluation_window and status = 'major_outage'),
    count(*) filter (where rn <= v_policy.evaluation_window and status = 'operational'),
    count(*) filter (where rn <= v_policy.evaluation_window and status = 'degraded_performance')
  into
    v_failures_recent,
    v_majors_recent,
    v_operational_recent,
    v_degraded_recent
  from recent;

  v_next_stable := v_previous_stable;

  if not coalesce(v_component.monitoring_enabled, true) then
    v_next_stable := v_previous_stable;
  elsif v_has_active_maintenance then
    v_next_stable := coalesce(v_previous_stable, 'operational');
  elsif p_raw_status = 'major_outage' and (
    v_failure_count >= v_policy.major_quorum
    or v_majors_recent >= v_policy.major_quorum
    or (
      v_policy.latency_major_ms is not null
      and p_latency_ms is not null
      and p_latency_ms >= v_policy.latency_major_ms
      and v_failure_count >= v_policy.failure_quorum
    )
  ) then
    v_next_stable := 'major_outage';
  elsif p_raw_status in ('partial_outage', 'major_outage') and (
    v_failure_count >= v_policy.failure_quorum
    or v_failures_recent >= v_policy.failure_quorum
    or (
      v_policy.latency_partial_ms is not null
      and p_latency_ms is not null
      and p_latency_ms >= v_policy.latency_partial_ms
      and (v_failure_count + v_degraded_count) >= v_policy.failure_quorum
    )
  ) then
    v_next_stable := 'partial_outage';
  elsif coalesce(v_policy.allow_degraded_status, true) and p_raw_status = 'degraded_performance' and (
    v_degraded_count >= v_policy.degraded_quorum
    or v_degraded_recent >= v_policy.degraded_quorum
    or (
      v_policy.latency_degraded_ms is not null
      and p_latency_ms is not null
      and p_latency_ms >= v_policy.latency_degraded_ms
    )
  ) then
    v_next_stable := 'degraded_performance';
  elsif p_raw_status = 'operational' and (
    v_success_count >= v_policy.recovery_quorum
    or v_operational_recent >= v_policy.recovery_quorum
  ) then
    v_next_stable := 'operational';
  end if;

  if v_component.name = 'Flow AI'
    and v_next_stable = 'degraded_performance'
    and v_confidence_score < greatest(v_policy.min_confidence_pct, 85.00::numeric)
  then
    v_next_stable := coalesce(v_previous_stable, 'operational');
  end if;

  v_effective_message := case
    when v_has_active_maintenance then coalesce(p_message, 'Componente em manutencao programada.')
    else p_message
  end;

  v_should_alert := public.system_status_is_incident_worthy(v_next_stable)
    and not v_has_active_maintenance
    and v_confidence_score >= coalesce(v_policy.min_confidence_pct, 66.67)
    and (
      v_previous_stable is distinct from v_next_stable
      or v_component.last_alerted_at is null
      or v_component.last_alerted_at <= coalesce(p_observed_at, timezone('utc', now())) - make_interval(mins => v_policy.alert_cooldown_minutes)
    );

  update public.system_status_monitor_snapshots
  set stable_status = v_next_stable
  where id = v_snapshot_id;

  update public.system_components
  set
    status = v_next_stable,
    latency_ms = p_latency_ms,
    source_key = coalesce(p_source_key, source_key),
    status_message = v_effective_message,
    last_checked_at = coalesce(p_observed_at, timezone('utc', now())),
    last_raw_status = p_raw_status,
    last_raw_checked_at = coalesce(p_observed_at, timezone('utc', now())),
    status_changed_at = case
      when status is distinct from v_next_stable then coalesce(p_observed_at, timezone('utc', now()))
      else status_changed_at
    end,
    last_failure_at = case
      when public.system_status_is_incident_worthy(v_next_stable) then coalesce(p_observed_at, timezone('utc', now()))
      else last_failure_at
    end,
    last_recovered_at = case
      when v_next_stable = 'operational' and status <> 'operational' then coalesce(p_observed_at, timezone('utc', now()))
      else last_recovered_at
    end,
    last_alerted_at = case
      when v_should_alert then coalesce(p_observed_at, timezone('utc', now()))
      else last_alerted_at
    end,
    last_incident_at = case
      when public.system_status_is_incident_worthy(v_next_stable) then coalesce(p_observed_at, timezone('utc', now()))
      else last_incident_at
    end,
    today_failure_count = case
      when public.system_status_is_incident_worthy(v_next_stable) and status = 'operational' then
        case
          when last_failure_at is not null
            and timezone('utc', last_failure_at)::date = v_today
          then coalesce(today_failure_count, 0) + 1
          else 1
        end
      when last_failure_at is not null
        and timezone('utc', last_failure_at)::date <> v_today
      then 0
      else coalesce(today_failure_count, 0)
    end,
    updated_at = timezone('utc', now()),
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'last_raw_status', p_raw_status,
      'last_stable_status', v_next_stable,
      'last_message', v_effective_message,
      'last_response_code', p_response_code,
      'last_monitor_metadata', coalesce(p_metadata, '{}'::jsonb),
      'sample_size', v_sample_size,
      'success_count', v_success_count,
      'degraded_count', v_degraded_count,
      'failure_count', v_failure_count,
      'checker_key', v_checker_key,
      'checker_region', v_checker_region,
      'confidence_score', v_confidence_score
    )
  where id = v_component.id;

  insert into public.system_status_history (
    component_id,
    status,
    recorded_at
  )
  values (
    v_component.id,
    v_next_stable,
    v_today
  )
  on conflict (component_id, recorded_at) do update
  set status = case
    when public.get_status_severity_weight(excluded.status) > public.get_status_severity_weight(public.system_status_history.status)
    then excluded.status
    else public.system_status_history.status
  end;

  if p_latency_ms is not null then
    perform public.system_status_record_metric(
      v_component.name,
      'latency_ms',
      p_latency_ms,
      'ms',
      coalesce(p_observed_at, timezone('utc', now())),
      v_sample_size,
      jsonb_build_object('status', v_next_stable, 'checker_key', v_checker_key)
    );
  end if;

  perform public.system_status_record_metric(
    v_component.name,
    'confidence_pct',
    v_confidence_score,
    'percent',
    coalesce(p_observed_at, timezone('utc', now())),
    v_sample_size,
    jsonb_build_object('raw_status', p_raw_status)
  );

  perform public.system_status_record_metric(
    v_component.name,
    'success_ratio_pct',
    v_success_ratio,
    'percent',
    coalesce(p_observed_at, timezone('utc', now())),
    v_sample_size,
    jsonb_build_object('stable_status', v_next_stable)
  );

  if v_previous_stable is distinct from v_next_stable then
    perform public.system_status_insert_activity(
      'component',
      v_component.id::text,
      'policy_decision',
      format('%s estabilizou em %s a partir de %s.', v_component.name, v_next_stable, p_raw_status),
      jsonb_build_object(
        'raw_status', p_raw_status,
        'stable_status', v_next_stable,
        'confidence_score', v_confidence_score,
        'sample_size', v_sample_size,
        'failure_count', v_failure_count,
        'degraded_count', v_degraded_count,
        'success_count', v_success_count,
        'maintenance_active', v_has_active_maintenance
      )
    );
  end if;

  if v_should_alert then
    perform public.system_status_enqueue_outbox(
      format(
        'component:%s:%s:%s',
        v_component.id,
        v_next_stable,
        to_char(date_trunc('minute', coalesce(p_observed_at, timezone('utc', now()))), 'YYYYMMDDHH24MI')
      ),
      'component_alert',
      v_component.id,
      null,
      jsonb_build_object(
        'component_name', v_component.name,
        'stable_status', v_next_stable,
        'raw_status', p_raw_status,
        'message', v_effective_message,
        'confidence_score', v_confidence_score
      )
    );
  end if;

  return query
  select
    v_component.id,
    v_next_stable,
    p_raw_status,
    v_should_alert;
end;
$$;

create or replace view public.system_status_active_maintenances as
select
  sm.id,
  sm.title,
  sm.message,
  sm.status,
  sm.scheduled_for,
  sm.scheduled_until,
  sm.started_at,
  sm.completed_at,
  sm.metadata,
  coalesce(array_agg(sc.name order by sc.display_order, sc.name) filter (where sc.id is not null), array[]::text[]) as component_names
from public.system_maintenances sm
left join public.system_maintenance_components smc on smc.maintenance_id = sm.id
left join public.system_components sc on sc.id = smc.component_id
where sm.status in ('scheduled', 'in_progress')
  and timezone('utc', now()) between sm.scheduled_for and sm.scheduled_until
group by sm.id;

create or replace view public.system_status_metric_latest as
select distinct on (md.id)
  md.id as metric_id,
  md.component_id,
  sc.name as component_name,
  md.metric_key,
  md.display_name,
  md.unit,
  mp.bucket_at,
  mp.numeric_value,
  mp.sample_size,
  mp.metadata
from public.system_status_metric_definitions md
join public.system_status_metric_points mp on mp.metric_id = md.id
join public.system_components sc on sc.id = md.component_id
order by md.id, mp.bucket_at desc;

create or replace view public.system_component_slo_30d as
with base as (
  select
    component_id,
    count(*) as total_samples,
    count(*) filter (where stable_status = 'operational') as operational_samples,
    count(*) filter (where stable_status = 'degraded_performance') as degraded_samples,
    count(*) filter (where stable_status in ('partial_outage', 'major_outage')) as outage_samples,
    avg(latency_ms) filter (where latency_ms is not null) as avg_latency_ms,
    percentile_cont(0.95) within group (order by latency_ms) filter (where latency_ms is not null) as p95_latency_ms
  from public.system_status_monitor_snapshots
  where observed_at >= timezone('utc', now()) - interval '30 days'
  group by component_id
)
select
  sc.id as component_id,
  sc.name as component_name,
  sc.sla_target,
  coalesce(base.total_samples, 0) as total_samples,
  coalesce(base.operational_samples, 0) as operational_samples,
  coalesce(base.degraded_samples, 0) as degraded_samples,
  coalesce(base.outage_samples, 0) as outage_samples,
  case
    when coalesce(base.total_samples, 0) = 0 then null
    else round((base.operational_samples::numeric / base.total_samples::numeric) * 100, 4)
  end as availability_pct_30d,
  round(base.avg_latency_ms::numeric, 2) as avg_latency_ms_30d,
  round(base.p95_latency_ms::numeric, 2) as p95_latency_ms_30d
from public.system_components sc
left join base on base.component_id = sc.id;

create or replace view public.system_component_public_status as
with active_maintenance as (
  select
    smc.component_id,
    max(sm.title) as maintenance_title
  from public.system_maintenances sm
  join public.system_maintenance_components smc on smc.maintenance_id = sm.id
  where sm.status in ('scheduled', 'in_progress')
    and timezone('utc', now()) between sm.scheduled_for and sm.scheduled_until
  group by smc.component_id
)
select
  sc.id,
  sc.name,
  sc.slug,
  sc.description,
  sc.public_description,
  cg.name as group_name,
  cg.slug as group_slug,
  case
    when am.component_id is not null then 'under_maintenance'
    else sc.status::text
  end as effective_status,
  sc.status::text as internal_status,
  sc.status_message,
  sc.latency_ms,
  sc.last_checked_at,
  sc.last_failure_at,
  sc.last_recovered_at,
  sc.sla_target,
  am.maintenance_title,
  coalesce(dep.depends_on, array[]::text[]) as depends_on,
  slo.availability_pct_30d,
  slo.avg_latency_ms_30d,
  slo.p95_latency_ms_30d
from public.system_components sc
left join public.system_component_groups cg on cg.id = sc.group_id
left join active_maintenance am on am.component_id = sc.id
left join lateral (
  select array_agg(d.name order by d.display_order, d.name) as depends_on
  from public.system_component_dependencies scd
  join public.system_components d on d.id = scd.depends_on_component_id
  where scd.component_id = sc.id
) dep on true
left join public.system_component_slo_30d slo on slo.component_id = sc.id
where sc.is_public = true;

create or replace view public.system_component_group_rollup as
select
  cg.id,
  cg.name,
  cg.slug,
  cg.description,
  min(sc.display_order) as display_order,
  case
    when count(*) filter (where cps.effective_status = 'major_outage') > 0 then 'major_outage'
    when count(*) filter (where cps.effective_status = 'partial_outage') > 0 then 'partial_outage'
    when count(*) filter (where cps.effective_status = 'degraded_performance') > 0 then 'degraded_performance'
    when count(*) filter (where cps.effective_status = 'under_maintenance') > 0 then 'under_maintenance'
    else 'operational'
  end as group_status,
  count(sc.id) as component_count
from public.system_component_groups cg
left join public.system_component_public_status cps on cps.group_slug = cg.slug
left join public.system_components sc on sc.id = cps.id
group by cg.id, cg.name, cg.slug, cg.description;

create or replace view public.system_status_enterprise_summary as
select
  (select count(*) from public.system_incidents where status <> 'resolved') as open_incidents,
  (select count(*) from public.system_maintenances where status in ('scheduled', 'in_progress') and timezone('utc', now()) <= scheduled_until) as active_or_upcoming_maintenances,
  (select count(*) from public.system_status_notification_outbox where status in ('pending', 'failed')) as pending_notifications,
  (select round(avg(availability_pct_30d)::numeric, 4) from public.system_component_slo_30d where availability_pct_30d is not null) as average_component_availability_pct_30d,
  (select count(*) from public.system_components where status in ('partial_outage', 'major_outage')) as components_in_outage;

commit;


-- ============================================================================
-- MIGRATION: 084_status_page_runtime_reliability.sql
-- ============================================================================

begin;

create extension if not exists pgcrypto;

create table if not exists public.system_status_runtime_leases (
  lease_name text primary key,
  holder_id text not null,
  lease_token uuid not null default gen_random_uuid(),
  leased_until timestamptz not null,
  heartbeat_at timestamptz not null default timezone('utc', now()),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_system_status_runtime_leases_until
on public.system_status_runtime_leases (leased_until, heartbeat_at desc);

alter table public.system_status_runtime_leases enable row level security;

do $$ begin
  create policy "service_role_manage_runtime_leases"
  on public.system_status_runtime_leases
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
exception when duplicate_object then null; end $$;

create or replace function public.system_status_touch_runtime_lease_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists tr_system_status_runtime_leases_touch_updated_at on public.system_status_runtime_leases;
create trigger tr_system_status_runtime_leases_touch_updated_at
before update on public.system_status_runtime_leases
for each row
execute function public.system_status_touch_runtime_lease_updated_at();

create or replace function public.system_status_acquire_runtime_lease(
  p_lease_name text,
  p_holder_id text,
  p_ttl_seconds integer default 90,
  p_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := timezone('utc', now());
  v_rows integer := 0;
  v_lease_name text := trim(coalesce(p_lease_name, ''));
  v_holder_id text := trim(coalesce(p_holder_id, ''));
  v_ttl integer := greatest(coalesce(p_ttl_seconds, 90), 30);
begin
  if v_lease_name = '' or v_holder_id = '' then
    return false;
  end if;

  update public.system_status_runtime_leases
  set
    holder_id = v_holder_id,
    lease_token = gen_random_uuid(),
    leased_until = v_now + make_interval(secs => v_ttl),
    heartbeat_at = v_now,
    metadata = coalesce(public.system_status_runtime_leases.metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb)
  where lease_name = v_lease_name
    and (
      leased_until <= v_now
      or holder_id = v_holder_id
    );

  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    insert into public.system_status_runtime_leases (
      lease_name,
      holder_id,
      leased_until,
      heartbeat_at,
      metadata
    )
    values (
      v_lease_name,
      v_holder_id,
      v_now + make_interval(secs => v_ttl),
      v_now,
      coalesce(p_metadata, '{}'::jsonb)
    )
    on conflict (lease_name) do nothing;

    get diagnostics v_rows = row_count;
  end if;

  return v_rows > 0;
end;
$$;

create or replace function public.system_status_release_runtime_lease(
  p_lease_name text,
  p_holder_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := timezone('utc', now());
begin
  update public.system_status_runtime_leases
  set
    leased_until = v_now,
    heartbeat_at = v_now,
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('released_at', v_now)
  where lease_name = trim(coalesce(p_lease_name, ''))
    and holder_id = trim(coalesce(p_holder_id, ''));

  return found;
end;
$$;

create or replace function public.system_status_claim_outbox_batch(
  p_worker_id text,
  p_limit integer default 10,
  p_visibility_timeout_seconds integer default 300
)
returns table (
  id uuid,
  dedupe_key text,
  event_type text,
  component_id uuid,
  incident_id uuid,
  attempts integer,
  payload jsonb,
  metadata jsonb,
  created_at timestamptz,
  available_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := timezone('utc', now());
  v_worker_id text := trim(coalesce(p_worker_id, ''));
  v_limit integer := greatest(coalesce(p_limit, 10), 1);
  v_visibility_timeout integer := greatest(coalesce(p_visibility_timeout_seconds, 300), 30);
begin
  if v_worker_id = '' then
    return;
  end if;

  return query
  with candidates as (
    select o.id
    from public.system_status_notification_outbox o
    where o.status in ('pending', 'failed')
      and o.available_at <= v_now
      and (
        o.locked_at is null
        or o.locked_at <= v_now - make_interval(secs => v_visibility_timeout)
      )
    order by o.available_at asc, o.created_at asc
    for update skip locked
    limit v_limit
  ),
  claimed as (
    update public.system_status_notification_outbox o
    set
      status = 'processing',
      locked_at = v_now,
      attempts = o.attempts + 1,
      metadata = coalesce(o.metadata, '{}'::jsonb) || jsonb_build_object(
        'last_worker_id', v_worker_id,
        'last_claimed_at', v_now
      )
    where o.id in (select c.id from candidates c)
    returning
      o.id,
      o.dedupe_key,
      o.event_type,
      o.component_id,
      o.incident_id,
      o.attempts,
      o.payload,
      o.metadata,
      o.created_at,
      o.available_at
  )
  select
    claimed.id,
    claimed.dedupe_key,
    claimed.event_type,
    claimed.component_id,
    claimed.incident_id,
    claimed.attempts,
    claimed.payload,
    claimed.metadata,
    claimed.created_at,
    claimed.available_at
  from claimed;
end;
$$;

create or replace function public.system_status_complete_outbox_item(
  p_notification_id uuid,
  p_delivery_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := timezone('utc', now());
begin
  update public.system_status_notification_outbox
  set
    status = 'sent',
    locked_at = null,
    delivered_at = v_now,
    last_error = null,
    metadata = coalesce(metadata, '{}'::jsonb) || coalesce(p_delivery_metadata, '{}'::jsonb)
  where id = p_notification_id;

  return found;
end;
$$;

create or replace function public.system_status_fail_outbox_item(
  p_notification_id uuid,
  p_error text,
  p_retry_seconds integer default 300,
  p_max_attempts integer default 8,
  p_error_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := timezone('utc', now());
begin
  update public.system_status_notification_outbox
  set
    status = case
      when attempts >= greatest(coalesce(p_max_attempts, 8), 1) then 'dead_letter'::public.system_outbox_status_type
      else 'failed'::public.system_outbox_status_type
    end,
    locked_at = null,
    available_at = case
      when attempts >= greatest(coalesce(p_max_attempts, 8), 1) then available_at
      else v_now + make_interval(secs => greatest(coalesce(p_retry_seconds, 300), 30))
    end,
    last_error = left(coalesce(p_error, 'unknown error'), 1000),
    metadata = coalesce(metadata, '{}'::jsonb)
      || jsonb_build_object('last_failed_at', v_now)
      || coalesce(p_error_metadata, '{}'::jsonb)
  where id = p_notification_id;

  return found;
end;
$$;

create or replace function public.system_status_reconcile_open_incidents()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_incident record;
  v_has_open_failures boolean := false;
  v_fixed integer := 0;
begin
  for v_incident in
    select id
    from public.system_incidents
    where status <> 'resolved'
    order by incident_day desc, updated_at desc
  loop
    select exists (
      select 1
      from public.system_incident_components sic
      join public.system_components sc on sc.id = sic.component_id
      where sic.incident_id = v_incident.id
        and public.system_status_is_incident_worthy(sc.status)
    )
    into v_has_open_failures;

    if not v_has_open_failures then
      update public.system_incidents
      set
        status = 'resolved',
        resolved_at = coalesce(resolved_at, timezone('utc', now())),
        updated_at = timezone('utc', now())
      where id = v_incident.id
        and status <> 'resolved';

      perform public.system_status_insert_incident_update(
        v_incident.id,
        'resolved',
        'Os sinais voltaram ao normal e o incidente foi conciliado automaticamente.'
      );

      v_fixed := v_fixed + 1;
    end if;

    perform public.system_status_refresh_incident_copy(v_incident.id);
  end loop;

  return v_fixed;
end;
$$;

create or replace view public.system_status_outbox_summary as
select
  status,
  count(*) as total,
  min(created_at) as oldest_created_at,
  max(updated_at) as newest_updated_at
from public.system_status_notification_outbox
group by status;

commit;


-- ============================================================================
-- MIGRATION: 086_payment_enterprise_hardening.sql
-- ============================================================================

create table if not exists public.payment_provider_event_inbox (
  id bigint generated always as identity primary key,
  provider text not null,
  event_key text not null,
  resource_type text,
  resource_id text,
  event_action text,
  status text not null default 'processing'
    check (status in ('processing', 'failed', 'completed', 'dead_letter')),
  attempt_count integer not null default 1 check (attempt_count >= 0),
  max_attempts integer not null default 6 check (max_attempts between 1 and 20),
  signature_verified boolean not null default false,
  request_id text,
  request_path text,
  headers jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  result_payload jsonb not null default '{}'::jsonb,
  last_error text,
  received_at timestamptz not null default timezone('utc', now()),
  last_received_at timestamptz not null default timezone('utc', now()),
  processed_at timestamptz,
  next_retry_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint payment_provider_event_inbox_provider_event_key_key unique (provider, event_key)
);

create index if not exists idx_payment_provider_event_inbox_status_retry
on public.payment_provider_event_inbox (status, next_retry_at, last_received_at desc);

create index if not exists idx_payment_provider_event_inbox_provider_resource
on public.payment_provider_event_inbox (provider, resource_type, resource_id, created_at desc)
where resource_id is not null;

drop trigger if exists tr_payment_provider_event_inbox_updated_at on public.payment_provider_event_inbox;
create trigger tr_payment_provider_event_inbox_updated_at
before update on public.payment_provider_event_inbox
for each row
execute function public.set_updated_at();

alter table public.payment_provider_event_inbox enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'drop policy if exists "service_role_all_payment_provider_event_inbox" on public.payment_provider_event_inbox';
    execute 'create policy "service_role_all_payment_provider_event_inbox" on public.payment_provider_event_inbox for all to service_role using (true) with check (true)';
  end if;
end
$$;

with ranked_pending_drafts as (
  select
    id,
    row_number() over (
      partition by user_id, coalesce(guild_id, '__global__'), payment_method
      order by created_at desc, id desc
    ) as rn
  from public.payment_orders
  where status = 'pending'
    and provider_payment_id is null
    and payment_method in ('pix', 'card')
)
update public.payment_orders po
set
  status = 'cancelled',
  provider_status = coalesce(po.provider_status, 'cancelled'),
  provider_status_detail = 'superseded_pending_draft_guard',
  provider_payload = coalesce(po.provider_payload, '{}'::jsonb) || jsonb_build_object(
    'duplicate_guard',
    jsonb_build_object(
      'reason', 'superseded_pending_draft_guard',
      'cancelled_at', timezone('utc', now())
    )
  ),
  updated_at = timezone('utc', now())
from ranked_pending_drafts ranked
where po.id = ranked.id
  and ranked.rn > 1;

create unique index if not exists idx_payment_orders_single_pending_draft_per_scope
on public.payment_orders (user_id, coalesce(guild_id, '__global__'), payment_method)
where status = 'pending'
  and provider_payment_id is null
  and payment_method in ('pix', 'card');


-- ============================================================================
-- MIGRATION: 087_payment_checkout_projection_and_portability.sql
-- ============================================================================

begin;

create or replace function public.base36_encode_bigint(p_value bigint)
returns text
language plpgsql
immutable
strict
as $$
declare
  v_alphabet constant text := '0123456789abcdefghijklmnopqrstuvwxyz';
  v_value bigint := abs(p_value);
  v_remainder integer;
  v_encoded text := '';
begin
  if p_value = 0 then
    return '0';
  end if;

  while v_value > 0 loop
    v_remainder := (v_value % 36)::integer;
    v_encoded := substr(v_alphabet, v_remainder + 1, 1) || v_encoded;
    v_value := v_value / 36;
  end loop;

  if p_value < 0 then
    return '-' || v_encoded;
  end if;

  return v_encoded;
end;
$$;

create or replace function public.payment_parse_numeric(
  p_value text,
  p_default numeric default 0
)
returns numeric
language plpgsql
immutable
as $$
begin
  if p_value is null or btrim(p_value) = '' then
    return p_default;
  end if;

  if btrim(p_value) ~ '^-?[0-9]+(\.[0-9]+)?$' then
    return p_value::numeric;
  end if;

  return p_default;
end;
$$;

create or replace function public.payment_parse_boolean(
  p_value text,
  p_default boolean default false
)
returns boolean
language plpgsql
immutable
as $$
declare
  v_normalized text;
begin
  if p_value is null or btrim(p_value) = '' then
    return p_default;
  end if;

  v_normalized := lower(btrim(p_value));

  if v_normalized in ('1', 'true', 't', 'yes', 'y', 'on') then
    return true;
  end if;

  if v_normalized in ('0', 'false', 'f', 'no', 'n', 'off') then
    return false;
  end if;

  return p_default;
end;
$$;

create or replace function public.ensure_service_role_all_policy(
  p_table regclass,
  p_policy_name text
)
returns void
language plpgsql
as $$
begin
  if exists (
    select 1
    from pg_roles
    where rolname = 'service_role'
  ) then
    execute format('drop policy if exists %I on %s', p_policy_name, p_table);
    execute format(
      'create policy %I on %s for all to service_role using (true) with check (true)',
      p_policy_name,
      p_table
    );
  end if;
end;
$$;

alter table public.payment_orders
  add column if not exists order_public_id text,
  add column if not exists cart_public_id text,
  add column if not exists scope_type text,
  add column if not exists checkout_surface text default 'payment',
  add column if not exists checkout_origin text default 'flowdesk_checkout';

update public.payment_orders
set
  scope_type = case when guild_id is null then 'account' else 'guild' end,
  order_public_id = coalesce(nullif(order_public_id, ''), 'flw_' || public.base36_encode_bigint(order_number)),
  cart_public_id = coalesce(nullif(cart_public_id, ''), 'crt_' || public.base36_encode_bigint(id)),
  checkout_surface = coalesce(nullif(checkout_surface, ''), 'payment'),
  checkout_origin = coalesce(
    nullif(checkout_origin, ''),
    nullif(provider_payload ->> 'source', ''),
    'flowdesk_checkout'
  )
where scope_type is null
   or order_public_id is null
   or order_public_id = ''
   or cart_public_id is null
   or cart_public_id = ''
   or checkout_surface is null
   or checkout_surface = ''
   or checkout_origin is null
   or checkout_origin = '';

alter table public.payment_orders
  alter column scope_type set default 'guild',
  alter column checkout_surface set default 'payment',
  alter column checkout_origin set default 'flowdesk_checkout';

alter table public.payment_orders
  alter column scope_type set not null,
  alter column checkout_surface set not null,
  alter column checkout_origin set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'payment_orders_scope_type_check'
      and conrelid = 'public.payment_orders'::regclass
  ) then
    alter table public.payment_orders
      add constraint payment_orders_scope_type_check
      check (scope_type in ('account', 'guild'));
  end if;
end
$$;

create unique index if not exists idx_payment_orders_order_public_id_unique
on public.payment_orders (order_public_id)
where order_public_id is not null;

create unique index if not exists idx_payment_orders_cart_public_id_unique
on public.payment_orders (cart_public_id)
where cart_public_id is not null;

create index if not exists idx_payment_orders_user_scope_status_created_at
on public.payment_orders (user_id, scope_type, status, created_at desc);

create index if not exists idx_payment_orders_public_lookup
on public.payment_orders (order_public_id, cart_public_id);

drop trigger if exists tr_payment_orders_public_identifiers on public.payment_orders;
create or replace function public.payment_orders_assign_public_identifiers()
returns trigger
language plpgsql
as $$
begin
  if new.order_number is not null and (new.order_public_id is null or btrim(new.order_public_id) = '') then
    new.order_public_id := 'flw_' || public.base36_encode_bigint(new.order_number);
  end if;

  if new.id is not null and (new.cart_public_id is null or btrim(new.cart_public_id) = '') then
    new.cart_public_id := 'crt_' || public.base36_encode_bigint(new.id);
  end if;

  new.scope_type := case when new.guild_id is null then 'account' else 'guild' end;
  new.checkout_surface := coalesce(nullif(new.checkout_surface, ''), 'payment');
  new.checkout_origin := coalesce(
    nullif(new.checkout_origin, ''),
    nullif(new.provider_payload ->> 'source', ''),
    'flowdesk_checkout'
  );

  return new;
end;
$$;

create trigger tr_payment_orders_public_identifiers
before insert or update on public.payment_orders
for each row
execute function public.payment_orders_assign_public_identifiers();

create table if not exists public.payment_checkout_carts (
  id bigint generated always as identity primary key,
  payment_order_id bigint not null references public.payment_orders(id) on delete cascade,
  order_number bigint not null,
  order_public_id text not null,
  cart_public_id text not null,
  user_id bigint not null references public.auth_users(id) on delete restrict,
  guild_id text,
  scope_type text not null
    check (scope_type in ('account', 'guild')),
  source text not null default 'flowdesk_checkout',
  checkout_surface text not null default 'payment',
  checkout_step integer
    check (checkout_step is null or checkout_step between 0 and 99),
  cart_status text not null default 'draft'
    check (cart_status in ('draft', 'pending', 'approved', 'rejected', 'cancelled', 'expired', 'failed')),
  payment_method text not null
    check (payment_method in ('pix', 'card', 'trial')),
  plan_code text not null,
  plan_name text not null,
  billing_cycle_days integer not null
    check (billing_cycle_days > 0),
  currency text not null default 'BRL',
  amount numeric(10,2) not null default 0
    check (amount >= 0),
  subtotal_amount numeric(10,2) not null default 0
    check (subtotal_amount >= 0),
  coupon_amount numeric(10,2) not null default 0
    check (coupon_amount >= 0),
  gift_card_amount numeric(10,2) not null default 0
    check (gift_card_amount >= 0),
  flow_points_amount numeric(10,2) not null default 0
    check (flow_points_amount >= 0),
  total_amount numeric(10,2) not null default 0
    check (total_amount >= 0),
  coupon_code text,
  gift_card_code text,
  payer_name text,
  payer_document_last4 text,
  payer_document_type text
    check (payer_document_type in ('CPF', 'CNPJ')),
  plan_snapshot jsonb not null default '{}'::jsonb,
  pricing_snapshot jsonb not null default '{}'::jsonb,
  transition_snapshot jsonb not null default '{}'::jsonb,
  provider_snapshot jsonb not null default '{}'::jsonb,
  customer_snapshot jsonb not null default '{}'::jsonb,
  checkout_context jsonb not null default '{}'::jsonb,
  opened_at timestamptz not null default timezone('utc', now()),
  last_seen_at timestamptz not null default timezone('utc', now()),
  finalized_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint payment_checkout_carts_payment_order_id_key unique (payment_order_id),
  constraint payment_checkout_carts_order_public_id_cart_public_id_key unique (order_public_id, cart_public_id)
);

create index if not exists idx_payment_checkout_carts_user_status_updated_at
on public.payment_checkout_carts (user_id, cart_status, updated_at desc);

create index if not exists idx_payment_checkout_carts_scope_status_updated_at
on public.payment_checkout_carts (scope_type, guild_id, cart_status, updated_at desc);

create index if not exists idx_payment_checkout_carts_public_lookup
on public.payment_checkout_carts (order_public_id, cart_public_id);

drop trigger if exists tr_payment_checkout_carts_updated_at on public.payment_checkout_carts;
create trigger tr_payment_checkout_carts_updated_at
before update on public.payment_checkout_carts
for each row
execute function public.set_updated_at();

alter table public.payment_checkout_carts enable row level security;
select public.ensure_service_role_all_policy(
  'public.payment_checkout_carts'::regclass,
  'service_role_all_payment_checkout_carts'
);

create table if not exists public.payment_order_state_history (
  id bigint generated always as identity primary key,
  payment_order_id bigint not null references public.payment_orders(id) on delete cascade,
  order_number bigint not null,
  order_public_id text,
  cart_public_id text,
  user_id bigint not null references public.auth_users(id) on delete restrict,
  guild_id text,
  scope_type text not null
    check (scope_type in ('account', 'guild')),
  payment_method text not null
    check (payment_method in ('pix', 'card', 'trial')),
  status text not null
    check (status in ('pending', 'approved', 'rejected', 'cancelled', 'expired', 'failed')),
  provider_status text,
  provider_status_detail text,
  provider_payment_id text,
  provider_external_reference text,
  amount numeric(10,2) not null default 0
    check (amount >= 0),
  currency text not null default 'BRL',
  plan_code text,
  plan_name text,
  billing_cycle_days integer,
  snapshot_kind text not null
    check (snapshot_kind in ('insert', 'update', 'backfill')),
  snapshot_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_payment_order_state_history_order_created_at
on public.payment_order_state_history (payment_order_id, created_at desc);

create index if not exists idx_payment_order_state_history_user_created_at
on public.payment_order_state_history (user_id, created_at desc);

create unique index if not exists idx_payment_order_state_history_backfill_unique
on public.payment_order_state_history (payment_order_id, snapshot_kind)
where snapshot_kind = 'backfill';

alter table public.payment_order_state_history enable row level security;
select public.ensure_service_role_all_policy(
  'public.payment_order_state_history'::regclass,
  'service_role_all_payment_order_state_history'
);

create or replace function public.refresh_payment_checkout_projection(
  p_order public.payment_orders,
  p_snapshot_kind text default 'update'
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_provider_payload jsonb := coalesce(p_order.provider_payload, '{}'::jsonb);
  v_pricing jsonb := case
    when jsonb_typeof(v_provider_payload -> 'pricing') = 'object'
      then v_provider_payload -> 'pricing'
    else '{}'::jsonb
  end;
  v_coupon jsonb := case
    when jsonb_typeof(v_pricing -> 'coupon') = 'object'
      then v_pricing -> 'coupon'
    else '{}'::jsonb
  end;
  v_gift_card jsonb := case
    when jsonb_typeof(v_pricing -> 'giftCard') = 'object'
      then v_pricing -> 'giftCard'
    else '{}'::jsonb
  end;
  v_flow_points jsonb := case
    when jsonb_typeof(v_pricing -> 'flowPoints') = 'object'
      then v_pricing -> 'flowPoints'
    else '{}'::jsonb
  end;
  v_transition jsonb := case
    when jsonb_typeof(v_provider_payload -> 'transition') = 'object'
      then v_provider_payload -> 'transition'
    else '{}'::jsonb
  end;
  v_plan jsonb := case
    when jsonb_typeof(v_provider_payload -> 'plan') = 'object'
      then v_provider_payload -> 'plan'
    else '{}'::jsonb
  end;
  v_scope_type text := case when p_order.guild_id is null then 'account' else 'guild' end;
  v_order_public_id text := coalesce(
    nullif(btrim(coalesce(p_order.order_public_id, '')), ''),
    'flw_' || public.base36_encode_bigint(p_order.order_number)
  );
  v_cart_public_id text := coalesce(
    nullif(btrim(coalesce(p_order.cart_public_id, '')), ''),
    'crt_' || public.base36_encode_bigint(p_order.id)
  );
  v_source text := coalesce(
    nullif(btrim(coalesce(v_provider_payload ->> 'source', '')), ''),
    nullif(btrim(coalesce(p_order.checkout_origin, '')), ''),
    'flowdesk_checkout'
  );
  v_checkout_surface text := coalesce(
    nullif(btrim(coalesce(p_order.checkout_surface, '')), ''),
    'payment'
  );
  v_checkout_step integer := case
    when coalesce(v_provider_payload ->> 'step', '') ~ '^\d+$'
      then (v_provider_payload ->> 'step')::integer
    else null
  end;
  v_plan_code text := coalesce(
    nullif(btrim(coalesce(v_plan ->> 'code', p_order.plan_code, '')), ''),
    'pro'
  );
  v_plan_name text := coalesce(
    nullif(btrim(coalesce(v_plan ->> 'name', p_order.plan_name, '')), ''),
    'Flow Pro'
  );
  v_billing_cycle_days integer := greatest(
    coalesce(
      public.payment_parse_numeric(v_plan ->> 'billingCycleDays', null)::integer,
      p_order.plan_billing_cycle_days,
      30
    ),
    1
  );
  v_coupon_amount numeric(10,2) := round(
    greatest(public.payment_parse_numeric(v_coupon ->> 'amount', 0), 0)::numeric,
    2
  );
  v_gift_card_amount numeric(10,2) := round(
    greatest(public.payment_parse_numeric(v_gift_card ->> 'amount', 0), 0)::numeric,
    2
  );
  v_flow_points_amount numeric(10,2) := round(
    greatest(
      coalesce(
        public.payment_parse_numeric(v_flow_points ->> 'appliedAmount', null),
        public.payment_parse_numeric(v_transition ->> 'flowPointsApplied', 0)
      ),
      0
    )::numeric,
    2
  );
  v_subtotal_amount numeric(10,2) := round(
    greatest(
      coalesce(
        public.payment_parse_numeric(v_pricing ->> 'subtotalAmount', null),
        public.payment_parse_numeric(v_pricing ->> 'baseAmount', null),
        p_order.amount,
        0
      ),
      0
    )::numeric,
    2
  );
  v_total_amount numeric(10,2) := round(
    greatest(
      coalesce(
        public.payment_parse_numeric(v_pricing ->> 'totalAmount', null),
        p_order.amount,
        0
      ),
      0
    )::numeric,
    2
  );
  v_cart_status text := case
    when p_order.status = 'pending'
      and p_order.provider_payment_id is null
      and public.payment_parse_boolean(v_provider_payload ->> 'precreated', false)
      then 'draft'
    else p_order.status
  end;
  v_payer_document_digits text := regexp_replace(coalesce(p_order.payer_document, ''), '\D', '', 'g');
  v_payer_document_last4 text := case
    when v_payer_document_digits <> '' then right(v_payer_document_digits, 4)
    else null
  end;
  v_plan_snapshot jsonb := case
    when v_plan <> '{}'::jsonb then v_plan
    else jsonb_strip_nulls(
      jsonb_build_object(
        'code', v_plan_code,
        'name', v_plan_name,
        'billingCycleDays', v_billing_cycle_days,
        'entitlements', jsonb_strip_nulls(
          jsonb_build_object(
            'maxLicensedServers', p_order.plan_max_licensed_servers,
            'maxActiveTickets', p_order.plan_max_active_tickets,
            'maxAutomations', p_order.plan_max_automations,
            'maxMonthlyActions', p_order.plan_max_monthly_actions
          )
        )
      )
    )
  end;
  v_provider_snapshot jsonb := jsonb_strip_nulls(
    jsonb_build_object(
      'provider', p_order.provider,
      'providerPaymentId', p_order.provider_payment_id,
      'externalReference', p_order.provider_external_reference,
      'status', p_order.provider_status,
      'statusDetail', p_order.provider_status_detail,
      'ticketUrl', p_order.provider_ticket_url,
      'mercadoPago', case
        when jsonb_typeof(v_provider_payload -> 'mercado_pago') = 'object'
          then v_provider_payload -> 'mercado_pago'
        else null
      end
    )
  );
  v_customer_snapshot jsonb := jsonb_strip_nulls(
    jsonb_build_object(
      'payerName', p_order.payer_name,
      'payerDocumentType', p_order.payer_document_type,
      'payerDocumentLast4', v_payer_document_last4
    )
  );
  v_now timestamptz := timezone('utc', now());
begin
  insert into public.payment_checkout_carts (
    payment_order_id,
    order_number,
    order_public_id,
    cart_public_id,
    user_id,
    guild_id,
    scope_type,
    source,
    checkout_surface,
    checkout_step,
    cart_status,
    payment_method,
    plan_code,
    plan_name,
    billing_cycle_days,
    currency,
    amount,
    subtotal_amount,
    coupon_amount,
    gift_card_amount,
    flow_points_amount,
    total_amount,
    coupon_code,
    gift_card_code,
    payer_name,
    payer_document_last4,
    payer_document_type,
    plan_snapshot,
    pricing_snapshot,
    transition_snapshot,
    provider_snapshot,
    customer_snapshot,
    checkout_context,
    opened_at,
    last_seen_at,
    finalized_at
  )
  values (
    p_order.id,
    p_order.order_number,
    v_order_public_id,
    v_cart_public_id,
    p_order.user_id,
    p_order.guild_id,
    v_scope_type,
    v_source,
    v_checkout_surface,
    v_checkout_step,
    v_cart_status,
    p_order.payment_method,
    v_plan_code,
    v_plan_name,
    v_billing_cycle_days,
    coalesce(nullif(btrim(coalesce(p_order.currency, '')), ''), 'BRL'),
    round(greatest(coalesce(p_order.amount, 0), 0)::numeric, 2),
    v_subtotal_amount,
    v_coupon_amount,
    v_gift_card_amount,
    v_flow_points_amount,
    v_total_amount,
    nullif(btrim(coalesce(v_coupon ->> 'code', '')), ''),
    nullif(btrim(coalesce(v_gift_card ->> 'code', '')), ''),
    p_order.payer_name,
    v_payer_document_last4,
    p_order.payer_document_type,
    coalesce(v_plan_snapshot, '{}'::jsonb),
    coalesce(v_pricing, '{}'::jsonb),
    coalesce(v_transition, '{}'::jsonb),
    coalesce(v_provider_snapshot, '{}'::jsonb),
    coalesce(v_customer_snapshot, '{}'::jsonb),
    coalesce(v_provider_payload, '{}'::jsonb),
    coalesce(p_order.created_at, v_now),
    v_now,
    case
      when v_cart_status in ('approved', 'rejected', 'cancelled', 'expired', 'failed')
        then coalesce(p_order.paid_at, p_order.updated_at, v_now)
      else null
    end
  )
  on conflict (payment_order_id) do update
  set
    order_number = excluded.order_number,
    order_public_id = excluded.order_public_id,
    cart_public_id = excluded.cart_public_id,
    user_id = excluded.user_id,
    guild_id = excluded.guild_id,
    scope_type = excluded.scope_type,
    source = excluded.source,
    checkout_surface = excluded.checkout_surface,
    checkout_step = excluded.checkout_step,
    cart_status = excluded.cart_status,
    payment_method = excluded.payment_method,
    plan_code = excluded.plan_code,
    plan_name = excluded.plan_name,
    billing_cycle_days = excluded.billing_cycle_days,
    currency = excluded.currency,
    amount = excluded.amount,
    subtotal_amount = excluded.subtotal_amount,
    coupon_amount = excluded.coupon_amount,
    gift_card_amount = excluded.gift_card_amount,
    flow_points_amount = excluded.flow_points_amount,
    total_amount = excluded.total_amount,
    coupon_code = excluded.coupon_code,
    gift_card_code = excluded.gift_card_code,
    payer_name = excluded.payer_name,
    payer_document_last4 = excluded.payer_document_last4,
    payer_document_type = excluded.payer_document_type,
    plan_snapshot = excluded.plan_snapshot,
    pricing_snapshot = excluded.pricing_snapshot,
    transition_snapshot = excluded.transition_snapshot,
    provider_snapshot = excluded.provider_snapshot,
    customer_snapshot = excluded.customer_snapshot,
    checkout_context = excluded.checkout_context,
    last_seen_at = excluded.last_seen_at,
    finalized_at = case
      when excluded.cart_status in ('approved', 'rejected', 'cancelled', 'expired', 'failed')
        then coalesce(public.payment_checkout_carts.finalized_at, excluded.finalized_at)
      else null
    end;

  if p_snapshot_kind is not null then
    if p_snapshot_kind <> 'backfill'
       or not exists (
         select 1
         from public.payment_order_state_history h
         where h.payment_order_id = p_order.id
           and h.snapshot_kind = 'backfill'
       ) then
      insert into public.payment_order_state_history (
        payment_order_id,
        order_number,
        order_public_id,
        cart_public_id,
        user_id,
        guild_id,
        scope_type,
        payment_method,
        status,
        provider_status,
        provider_status_detail,
        provider_payment_id,
        provider_external_reference,
        amount,
        currency,
        plan_code,
        plan_name,
        billing_cycle_days,
        snapshot_kind,
        snapshot_payload
      )
      values (
        p_order.id,
        p_order.order_number,
        v_order_public_id,
        v_cart_public_id,
        p_order.user_id,
        p_order.guild_id,
        v_scope_type,
        p_order.payment_method,
        p_order.status,
        p_order.provider_status,
        p_order.provider_status_detail,
        p_order.provider_payment_id,
        p_order.provider_external_reference,
        round(greatest(coalesce(p_order.amount, 0), 0)::numeric, 2),
        coalesce(nullif(btrim(coalesce(p_order.currency, '')), ''), 'BRL'),
        v_plan_code,
        v_plan_name,
        v_billing_cycle_days,
        p_snapshot_kind,
        jsonb_strip_nulls(
          jsonb_build_object(
            'checkoutSurface', v_checkout_surface,
            'checkoutOrigin', v_source,
            'plan', v_plan_snapshot,
            'pricing', v_pricing,
            'transition', v_transition,
            'customer', v_customer_snapshot,
            'provider', v_provider_snapshot,
            'providerPayload', v_provider_payload,
            'paidAt', p_order.paid_at,
            'expiresAt', p_order.expires_at
          )
        )
      );
    end if;
  end if;
end;
$$;

create or replace function public.tr_payment_orders_checkout_projection()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if new.guild_id is not distinct from old.guild_id
       and new.payment_method is not distinct from old.payment_method
       and new.status is not distinct from old.status
       and new.amount is not distinct from old.amount
       and new.currency is not distinct from old.currency
       and new.payer_name is not distinct from old.payer_name
       and new.payer_document is not distinct from old.payer_document
       and new.payer_document_type is not distinct from old.payer_document_type
       and new.provider is not distinct from old.provider
       and new.provider_payment_id is not distinct from old.provider_payment_id
       and new.provider_external_reference is not distinct from old.provider_external_reference
       and new.provider_qr_code is not distinct from old.provider_qr_code
       and new.provider_qr_base64 is not distinct from old.provider_qr_base64
       and new.provider_ticket_url is not distinct from old.provider_ticket_url
       and new.provider_status is not distinct from old.provider_status
       and new.provider_status_detail is not distinct from old.provider_status_detail
       and new.provider_payload is not distinct from old.provider_payload
       and new.plan_code is not distinct from old.plan_code
       and new.plan_name is not distinct from old.plan_name
       and new.plan_billing_cycle_days is not distinct from old.plan_billing_cycle_days
       and new.plan_max_licensed_servers is not distinct from old.plan_max_licensed_servers
       and new.plan_max_active_tickets is not distinct from old.plan_max_active_tickets
       and new.plan_max_automations is not distinct from old.plan_max_automations
       and new.plan_max_monthly_actions is not distinct from old.plan_max_monthly_actions
       and new.order_public_id is not distinct from old.order_public_id
       and new.cart_public_id is not distinct from old.cart_public_id
       and new.scope_type is not distinct from old.scope_type
       and new.checkout_surface is not distinct from old.checkout_surface
       and new.checkout_origin is not distinct from old.checkout_origin
       and new.paid_at is not distinct from old.paid_at
       and new.expires_at is not distinct from old.expires_at then
      return new;
    end if;
  end if;

  perform public.refresh_payment_checkout_projection(new, lower(tg_op));
  return new;
end;
$$;

drop trigger if exists tr_payment_orders_checkout_projection on public.payment_orders;
create trigger tr_payment_orders_checkout_projection
after insert or update on public.payment_orders
for each row
execute function public.tr_payment_orders_checkout_projection();

with ranked_coupon_redemptions as (
  select
    id,
    row_number() over (
      partition by coupon_id, payment_order_id
      order by created_at asc, id asc
    ) as rn
  from public.payment_coupon_redemptions
  where payment_order_id is not null
)
delete from public.payment_coupon_redemptions pcr
using ranked_coupon_redemptions ranked
where pcr.id = ranked.id
  and ranked.rn > 1;

with ranked_gift_card_redemptions as (
  select
    id,
    row_number() over (
      partition by gift_card_id, payment_order_id
      order by created_at asc, id asc
    ) as rn
  from public.payment_gift_card_redemptions
  where payment_order_id is not null
)
delete from public.payment_gift_card_redemptions pgcr
using ranked_gift_card_redemptions ranked
where pgcr.id = ranked.id
  and ranked.rn > 1;

create unique index if not exists idx_payment_coupon_redemptions_coupon_order_unique
on public.payment_coupon_redemptions (coupon_id, payment_order_id)
where payment_order_id is not null;

create unique index if not exists idx_payment_gift_card_redemptions_gift_card_order_unique
on public.payment_gift_card_redemptions (gift_card_id, payment_order_id)
where payment_order_id is not null;

select public.refresh_payment_checkout_projection(po, 'backfill')
from public.payment_orders po;

create or replace view public.payment_checkout_portable_orders_v1 as
select
  po.id as payment_order_id,
  po.order_number,
  po.order_public_id,
  po.cart_public_id,
  po.user_id,
  po.guild_id,
  po.scope_type,
  po.checkout_surface,
  po.checkout_origin,
  po.payment_method,
  po.status,
  po.amount,
  po.currency,
  po.plan_code,
  po.plan_name,
  po.plan_billing_cycle_days,
  po.provider,
  po.provider_payment_id,
  po.provider_external_reference,
  po.provider_status,
  po.provider_status_detail,
  po.paid_at,
  po.expires_at,
  po.created_at,
  po.updated_at,
  pc.cart_status,
  pc.subtotal_amount,
  pc.coupon_amount,
  pc.gift_card_amount,
  pc.flow_points_amount,
  (pc.coupon_amount + pc.gift_card_amount + pc.flow_points_amount) as discount_total_amount,
  pc.total_amount,
  pc.coupon_code,
  pc.gift_card_code,
  pc.plan_snapshot,
  pc.pricing_snapshot,
  pc.transition_snapshot,
  pc.provider_snapshot,
  pc.customer_snapshot,
  pc.checkout_context,
  pc.finalized_at
from public.payment_orders po
left join public.payment_checkout_carts pc
  on pc.payment_order_id = po.id;

commit;


-- ============================================================================
-- MIGRATION: 088_hotspot_query_indexes.sql
-- ============================================================================

create index if not exists idx_account_violations_user_expires_at
on public.account_violations (user_id, expires_at);

create index if not exists idx_auth_security_events_started_session_action_created_at
on public.auth_security_events (session_id, action, created_at desc)
where outcome = 'started';

create index if not exists idx_auth_security_events_started_user_action_created_at
on public.auth_security_events (user_id, action, created_at desc)
where outcome = 'started';

create index if not exists idx_auth_security_events_started_ip_action_created_at
on public.auth_security_events (ip_fingerprint, action, created_at desc)
where outcome = 'started';

create index if not exists idx_payment_orders_user_status_paid_at_created_at_approved
on public.payment_orders (user_id, status, paid_at desc, created_at desc)
where status = 'approved';

create index if not exists idx_payment_orders_user_guild_created_at_desc
on public.payment_orders (user_id, guild_id, created_at desc);

create index if not exists idx_payment_orders_user_status_guild_updated_created_desc
on public.payment_orders (user_id, status, guild_id, updated_at desc, created_at desc);

create index if not exists idx_payment_orders_guild_status_created_at_desc
on public.payment_orders (guild_id, status, created_at desc);

create index if not exists idx_payment_orders_order_number_guild_id
on public.payment_orders (order_number, guild_id);

create index if not exists idx_payment_orders_provider_payment_id
on public.payment_orders (provider_payment_id)
where provider_payment_id is not null;

create index if not exists idx_payment_orders_pending_user_guild_provider_created_desc
on public.payment_orders (user_id, guild_id, provider_payment_id, created_at desc)
where status = 'pending';

create index if not exists idx_auth_sessions_active_user_expires_at
on public.auth_sessions (user_id, expires_at desc)
where revoked_at is null;

create index if not exists idx_guild_ticket_settings_configured_by_user_guild_updated_at
on public.guild_ticket_settings (configured_by_user_id, guild_id, updated_at desc);

create index if not exists idx_guild_ticket_staff_settings_configured_by_user_guild_updated_at
on public.guild_ticket_staff_settings (configured_by_user_id, guild_id, updated_at desc);

create index if not exists idx_guild_welcome_settings_configured_by_user_guild_updated_at
on public.guild_welcome_settings (configured_by_user_id, guild_id, updated_at desc);

create index if not exists idx_guild_antilink_settings_configured_by_user_guild_updated_at
on public.guild_antilink_settings (configured_by_user_id, guild_id, updated_at desc);

create index if not exists idx_guild_autorole_settings_configured_by_user_guild_updated_at
on public.guild_autorole_settings (configured_by_user_id, guild_id, updated_at desc);

create index if not exists idx_guild_plan_settings_user_guild_updated_at
on public.guild_plan_settings (user_id, guild_id, updated_at desc);

create index if not exists idx_auth_user_plan_guilds_guild_user
on public.auth_user_plan_guilds (guild_id, user_id);

create index if not exists idx_auth_user_team_servers_guild_team
on public.auth_user_team_servers (guild_id, team_id);

create index if not exists idx_auth_user_teams_owner_user_id_id
on public.auth_user_teams (owner_user_id, id);

create index if not exists idx_auth_user_team_members_auth_status_team
on public.auth_user_team_members (invited_auth_user_id, status, team_id);

create index if not exists idx_auth_user_team_members_discord_status_team
on public.auth_user_team_members (invited_discord_user_id, status, team_id);


-- ============================================================================
-- MIGRATION: 089_auth_user_team_roles_schema.sql
-- ============================================================================

create table if not exists public.auth_user_team_roles (
  id bigint generated always as identity primary key,
  team_id bigint not null references public.auth_user_teams(id) on delete cascade,
  name text not null,
  permissions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (team_id, name),
  constraint auth_user_team_roles_permissions_array_check
    check (jsonb_typeof(permissions) = 'array')
);

create index if not exists idx_auth_user_team_roles_team_id
on public.auth_user_team_roles (team_id);

drop trigger if exists tr_auth_user_team_roles_updated_at on public.auth_user_team_roles;
create trigger tr_auth_user_team_roles_updated_at
before update on public.auth_user_team_roles
for each row
execute function public.set_updated_at();

alter table public.auth_user_team_members
  add column if not exists role_id bigint references public.auth_user_team_roles(id) on delete set null;

alter table public.auth_user_team_members
  add column if not exists custom_permissions jsonb not null default '[]'::jsonb;

drop index if exists idx_auth_user_team_members_role_id;
create index if not exists idx_auth_user_team_members_role_id
on public.auth_user_team_members (role_id);

alter table public.auth_user_team_members
  drop constraint if exists auth_user_team_members_custom_permissions_array_check;

alter table public.auth_user_team_members
  add constraint auth_user_team_members_custom_permissions_array_check
  check (jsonb_typeof(custom_permissions) = 'array');

alter table public.auth_user_team_roles enable row level security;

drop policy if exists "service_role_all_auth_user_team_roles" on public.auth_user_team_roles;
create policy "service_role_all_auth_user_team_roles"
on public.auth_user_team_roles
for all
to service_role
using (true)
with check (true);


-- ============================================================================
-- MIGRATION: 089_supabase_lint_fixes.sql
-- ============================================================================

-- Supabase lint fixes acumulados.
-- Envie os proximos itens e eu continuo adicionando neste mesmo arquivo.

alter function public.get_status_severity_weight(public.system_status_type)
set search_path = pg_catalog, public;

alter function public.normalize_status_message(text)
set search_path = pg_catalog, public;

alter function public.system_status_is_incident_worthy(public.system_status_type)
set search_path = pg_catalog, public;

alter function public.maintain_worst_daily_status()
set search_path = pg_catalog, public;

alter function public.set_updated_at()
set search_path = pg_catalog, public;

alter function public.base36_encode_bigint(bigint)
set search_path = pg_catalog, public;

alter function public.log_system_status_change()
set search_path = pg_catalog, public;

alter function public.create_plan_expiry_task()
set search_path = pg_catalog, public;

alter function public.handle_plan_status_change()
set search_path = pg_catalog, public;

alter function public.touch_system_component_updated_at()
set search_path = pg_catalog, public;

alter function public.touch_system_status_subscription_updated_at()
set search_path = pg_catalog, public;

alter function public.system_status_refresh_incident_copy(uuid)
set search_path = pg_catalog, public;

alter function public.system_status_insert_incident_update(
  uuid,
  public.incident_status_type,
  text
)
set search_path = pg_catalog, public;

alter function public.sync_system_incident_dates()
set search_path = pg_catalog, public;

alter function public.system_status_sync_daily_lock()
set search_path = pg_catalog, public;

alter function public.system_status_touch_incident_from_update()
set search_path = pg_catalog, public;

alter function public.system_status_handle_component_transition()
set search_path = pg_catalog, public;

alter function public.system_status_touch_updated_at()
set search_path = pg_catalog, public;

alter function public.system_status_log_component_status_change()
set search_path = pg_catalog, public;

alter function public.system_status_log_incident_change()
set search_path = pg_catalog, public;

alter function public.system_status_log_incident_update_change()
set search_path = pg_catalog, public;

alter function public.system_status_log_maintenance_change()
set search_path = pg_catalog, public;

alter function public.system_status_touch_runtime_lease_updated_at()
set search_path = pg_catalog, public;

alter function public.payment_parse_numeric(text, numeric)
set search_path = pg_catalog, public;

alter function public.payment_parse_boolean(text, boolean)
set search_path = pg_catalog, public;

alter function public.ensure_service_role_all_policy(regclass, text)
set search_path = pg_catalog, public;

alter function public.payment_orders_assign_public_identifiers()
set search_path = pg_catalog, public;

do $$
begin
  if to_regclass('public.discord_cdn_cache') is not null then
    alter table public.discord_cdn_cache enable row level security;
    perform public.ensure_service_role_all_policy(
      'public.discord_cdn_cache'::regclass,
      'service_role_all_discord_cdn_cache'
    );
  end if;
end
$$;

do $$
begin
  if to_regclass('public.system_health_pings') is not null then
    alter table public.system_health_pings enable row level security;
    perform public.ensure_service_role_all_policy(
      'public.system_health_pings'::regclass,
      'service_role_all_system_health_pings'
    );
  end if;
end
$$;

do $$
begin
  if to_regclass('public.system_status_audit') is not null then
    alter table public.system_status_audit enable row level security;
    perform public.ensure_service_role_all_policy(
      'public.system_status_audit'::regclass,
      'service_role_all_system_status_audit'
    );
  end if;
end
$$;

do $$
begin
  if to_regclass('public.system_status_subscriptions') is not null then
    alter table public.system_status_subscriptions enable row level security;
    perform public.ensure_service_role_all_policy(
      'public.system_status_subscriptions'::regclass,
      'service_role_all_system_status_subscriptions'
    );
  end if;
end
$$;

do $$
begin
  if to_regclass('public.system_status_webhook_deliveries') is not null then
    alter table public.system_status_webhook_deliveries enable row level security;
    perform public.ensure_service_role_all_policy(
      'public.system_status_webhook_deliveries'::regclass,
      'service_role_all_system_status_webhook_deliveries'
    );
  end if;
end
$$;

do $$
begin
  if to_regclass('public.ticket_dm_queue') is not null then
    alter table public.ticket_dm_queue enable row level security;
    perform public.ensure_service_role_all_policy(
      'public.ticket_dm_queue'::regclass,
      'service_role_all_ticket_dm_queue'
    );
  end if;
end
$$;

do $$
begin
  if to_regclass('public.ticket_transcripts') is not null then
    alter table public.ticket_transcripts enable row level security;
    perform public.ensure_service_role_all_policy(
      'public.ticket_transcripts'::regclass,
      'service_role_all_ticket_transcripts'
    );
  end if;
end
$$;


-- ============================================================================
-- MIGRATION: 090_status_ingest_check_runtime_fix.sql
-- ============================================================================

-- Corrige o RPC public.system_status_ingest_check em ambientes que ainda
-- estao com a versao antiga da funcao (082) e tambem regrava a versao nova
-- (083+) quando a estrutura enterprise ja existe.

do $$
begin
  if to_regclass('public.system_status_monitor_policies') is not null
    and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'system_status_monitor_snapshots'
        and column_name = 'policy_snapshot'
    )
    and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'system_components'
        and column_name = 'monitoring_enabled'
    )
  then
    execute $fn$
create or replace function public.system_status_ingest_check(
  p_component_name text,
  p_raw_status public.system_status_type,
  p_latency_ms integer default null,
  p_message text default null,
  p_response_code integer default null,
  p_source_key text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_observed_at timestamptz default timezone('utc', now())
)
returns table (
  component_id uuid,
  stable_status public.system_status_type,
  raw_status public.system_status_type,
  should_alert boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $body$
declare
  v_component public.system_components%rowtype;
  v_policy public.system_status_monitor_policies%rowtype;
  v_snapshot_id uuid;
  v_previous_stable public.system_status_type;
  v_next_stable public.system_status_type;
  v_failures_recent integer := 0;
  v_majors_recent integer := 0;
  v_operational_recent integer := 0;
  v_degraded_recent integer := 0;
  v_today date := timezone('utc', coalesce(p_observed_at, timezone('utc', now())))::date;
  v_sample_size integer := greatest(coalesce(nullif(p_metadata ->> 'sampleSize', '')::integer, 1), 1);
  v_success_count integer := 0;
  v_degraded_count integer := 0;
  v_failure_count integer := 0;
  v_checker_key text := coalesce(nullif(p_metadata ->> 'checkerKey', ''), 'internal-status-monitor');
  v_checker_region text := nullif(p_metadata ->> 'checkerRegion', '');
  v_confidence_score numeric(5,2);
  v_has_active_maintenance boolean := false;
  v_should_alert boolean := false;
  v_success_ratio numeric(5,2);
  v_effective_message text;
begin
  select *
  into v_component
  from public.system_components
  where name = p_component_name
  limit 1;

  if not found then
    raise exception 'Componente de status nao encontrado: %', p_component_name;
  end if;

  select *
  into v_policy
  from public.system_status_monitor_policies p
  where p.component_id = v_component.id;

  if not found then
    insert into public.system_status_monitor_policies (component_id)
    values (v_component.id)
    returning * into v_policy;
  end if;

  v_success_count := greatest(
    coalesce(
      nullif(p_metadata ->> 'successCount', '')::integer,
      case when p_raw_status = 'operational' then v_sample_size else 0 end
    ),
    0
  );
  v_degraded_count := greatest(
    coalesce(
      nullif(p_metadata ->> 'degradedCount', '')::integer,
      case when p_raw_status = 'degraded_performance' then v_sample_size else 0 end
    ),
    0
  );
  v_failure_count := greatest(
    coalesce(
      nullif(p_metadata ->> 'failureCount', '')::integer,
      case when p_raw_status in ('partial_outage', 'major_outage') then v_sample_size else 0 end
    ),
    0
  );

  v_confidence_score := coalesce(
    nullif(p_metadata ->> 'confidenceScore', '')::numeric(5,2),
    round(
      (
        greatest(v_success_count, v_degraded_count, v_failure_count)::numeric
        / greatest(v_sample_size, 1)::numeric
      ) * 100,
      2
    )::numeric(5,2)
  );

  v_success_ratio := round(
    (
      greatest(v_success_count, 0)::numeric
      / greatest(v_sample_size, 1)::numeric
    ) * 100,
    2
  )::numeric(5,2);

  select exists (
    select 1
    from public.system_maintenances sm
    join public.system_maintenance_components smc on smc.maintenance_id = sm.id
    where smc.component_id = v_component.id
      and sm.status in ('scheduled', 'in_progress')
      and coalesce(p_observed_at, timezone('utc', now())) between sm.scheduled_for and sm.scheduled_until
  )
  into v_has_active_maintenance;

  v_previous_stable := coalesce(v_component.status, 'operational');

  insert into public.system_status_monitor_snapshots (
    source_key,
    component_slug,
    component_id,
    component_name,
    status,
    stable_status,
    latency_ms,
    response_code,
    message,
    metadata,
    observed_at,
    sample_size,
    success_count,
    degraded_count,
    failure_count,
    checker_key,
    checker_region,
    confidence_score,
    policy_snapshot
  )
  values (
    coalesce(p_source_key, v_component.source_key, v_component.slug, lower(regexp_replace(v_component.name, '[^a-zA-Z0-9]+', '-', 'g'))),
    v_component.slug,
    v_component.id,
    v_component.name,
    p_raw_status,
    null,
    p_latency_ms,
    p_response_code,
    p_message,
    coalesce(p_metadata, '{}'::jsonb),
    coalesce(p_observed_at, timezone('utc', now())),
    v_sample_size,
    v_success_count,
    v_degraded_count,
    v_failure_count,
    v_checker_key,
    v_checker_region,
    v_confidence_score,
    to_jsonb(v_policy)
  )
  returning id into v_snapshot_id;

  with recent as (
    select
      s.status,
      row_number() over (order by s.observed_at desc, s.id desc) as rn
    from public.system_status_monitor_snapshots s
    where s.component_id = v_component.id
    order by s.observed_at desc, s.id desc
    limit greatest(v_policy.evaluation_window, 5)
  )
  select
    count(*) filter (where rn <= v_policy.evaluation_window and status in ('partial_outage', 'major_outage')),
    count(*) filter (where rn <= v_policy.evaluation_window and status = 'major_outage'),
    count(*) filter (where rn <= v_policy.evaluation_window and status = 'operational'),
    count(*) filter (where rn <= v_policy.evaluation_window and status = 'degraded_performance')
  into
    v_failures_recent,
    v_majors_recent,
    v_operational_recent,
    v_degraded_recent
  from recent;

  v_next_stable := v_previous_stable;

  if not coalesce(v_component.monitoring_enabled, true) then
    v_next_stable := v_previous_stable;
  elsif v_has_active_maintenance then
    v_next_stable := coalesce(v_previous_stable, 'operational');
  elsif p_raw_status = 'major_outage' and (
    v_failure_count >= v_policy.major_quorum
    or v_majors_recent >= v_policy.major_quorum
    or (
      v_policy.latency_major_ms is not null
      and p_latency_ms is not null
      and p_latency_ms >= v_policy.latency_major_ms
      and v_failure_count >= v_policy.failure_quorum
    )
  ) then
    v_next_stable := 'major_outage';
  elsif p_raw_status in ('partial_outage', 'major_outage') and (
    v_failure_count >= v_policy.failure_quorum
    or v_failures_recent >= v_policy.failure_quorum
    or (
      v_policy.latency_partial_ms is not null
      and p_latency_ms is not null
      and p_latency_ms >= v_policy.latency_partial_ms
      and (v_failure_count + v_degraded_count) >= v_policy.failure_quorum
    )
  ) then
    v_next_stable := 'partial_outage';
  elsif coalesce(v_policy.allow_degraded_status, true) and p_raw_status = 'degraded_performance' and (
    v_degraded_count >= v_policy.degraded_quorum
    or v_degraded_recent >= v_policy.degraded_quorum
    or (
      v_policy.latency_degraded_ms is not null
      and p_latency_ms is not null
      and p_latency_ms >= v_policy.latency_degraded_ms
    )
  ) then
    v_next_stable := 'degraded_performance';
  elsif p_raw_status = 'operational' and (
    v_success_count >= v_policy.recovery_quorum
    or v_operational_recent >= v_policy.recovery_quorum
  ) then
    v_next_stable := 'operational';
  end if;

  if v_component.name = 'Flow AI'
    and v_next_stable = 'degraded_performance'
    and v_confidence_score < greatest(v_policy.min_confidence_pct, 85.00::numeric)
  then
    v_next_stable := coalesce(v_previous_stable, 'operational');
  end if;

  v_effective_message := case
    when v_has_active_maintenance then coalesce(p_message, 'Componente em manutencao programada.')
    else p_message
  end;

  v_should_alert := public.system_status_is_incident_worthy(v_next_stable)
    and not v_has_active_maintenance
    and v_confidence_score >= coalesce(v_policy.min_confidence_pct, 66.67)
    and (
      v_previous_stable is distinct from v_next_stable
      or v_component.last_alerted_at is null
      or v_component.last_alerted_at <= coalesce(p_observed_at, timezone('utc', now())) - make_interval(mins => v_policy.alert_cooldown_minutes)
    );

  update public.system_status_monitor_snapshots
  set stable_status = v_next_stable
  where id = v_snapshot_id;

  update public.system_components
  set
    status = v_next_stable,
    latency_ms = p_latency_ms,
    source_key = coalesce(p_source_key, source_key),
    status_message = v_effective_message,
    last_checked_at = coalesce(p_observed_at, timezone('utc', now())),
    last_raw_status = p_raw_status,
    last_raw_checked_at = coalesce(p_observed_at, timezone('utc', now())),
    status_changed_at = case
      when status is distinct from v_next_stable then coalesce(p_observed_at, timezone('utc', now()))
      else status_changed_at
    end,
    last_failure_at = case
      when public.system_status_is_incident_worthy(v_next_stable) then coalesce(p_observed_at, timezone('utc', now()))
      else last_failure_at
    end,
    last_recovered_at = case
      when v_next_stable = 'operational' and status <> 'operational' then coalesce(p_observed_at, timezone('utc', now()))
      else last_recovered_at
    end,
    last_alerted_at = case
      when v_should_alert then coalesce(p_observed_at, timezone('utc', now()))
      else last_alerted_at
    end,
    last_incident_at = case
      when public.system_status_is_incident_worthy(v_next_stable) then coalesce(p_observed_at, timezone('utc', now()))
      else last_incident_at
    end,
    today_failure_count = case
      when public.system_status_is_incident_worthy(v_next_stable) and status = 'operational' then
        case
          when last_failure_at is not null
            and timezone('utc', last_failure_at)::date = v_today
          then coalesce(today_failure_count, 0) + 1
          else 1
        end
      when last_failure_at is not null
        and timezone('utc', last_failure_at)::date <> v_today
      then 0
      else coalesce(today_failure_count, 0)
    end,
    updated_at = timezone('utc', now()),
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'last_raw_status', p_raw_status,
      'last_stable_status', v_next_stable,
      'last_message', v_effective_message,
      'last_response_code', p_response_code,
      'last_monitor_metadata', coalesce(p_metadata, '{}'::jsonb),
      'sample_size', v_sample_size,
      'success_count', v_success_count,
      'degraded_count', v_degraded_count,
      'failure_count', v_failure_count,
      'checker_key', v_checker_key,
      'checker_region', v_checker_region,
      'confidence_score', v_confidence_score
    )
  where id = v_component.id;

  insert into public.system_status_history (
    component_id,
    status,
    recorded_at
  )
  values (
    v_component.id,
    v_next_stable,
    v_today
  )
  on conflict on constraint system_status_history_component_id_recorded_at_key do update
  set status = case
    when public.get_status_severity_weight(excluded.status) > public.get_status_severity_weight(public.system_status_history.status)
    then excluded.status
    else public.system_status_history.status
  end;

  if p_latency_ms is not null then
    perform public.system_status_record_metric(
      v_component.name,
      'latency_ms',
      p_latency_ms,
      'ms',
      coalesce(p_observed_at, timezone('utc', now())),
      v_sample_size,
      jsonb_build_object('status', v_next_stable, 'checker_key', v_checker_key)
    );
  end if;

  perform public.system_status_record_metric(
    v_component.name,
    'confidence_pct',
    v_confidence_score,
    'percent',
    coalesce(p_observed_at, timezone('utc', now())),
    v_sample_size,
    jsonb_build_object('raw_status', p_raw_status)
  );

  perform public.system_status_record_metric(
    v_component.name,
    'success_ratio_pct',
    v_success_ratio,
    'percent',
    coalesce(p_observed_at, timezone('utc', now())),
    v_sample_size,
    jsonb_build_object('stable_status', v_next_stable)
  );

  if v_previous_stable is distinct from v_next_stable then
    perform public.system_status_insert_activity(
      'component',
      v_component.id::text,
      'policy_decision',
      format('%s estabilizou em %s a partir de %s.', v_component.name, v_next_stable, p_raw_status),
      jsonb_build_object(
        'raw_status', p_raw_status,
        'stable_status', v_next_stable,
        'confidence_score', v_confidence_score,
        'sample_size', v_sample_size,
        'failure_count', v_failure_count,
        'degraded_count', v_degraded_count,
        'success_count', v_success_count,
        'maintenance_active', v_has_active_maintenance
      )
    );
  end if;

  if v_should_alert then
    perform public.system_status_enqueue_outbox(
      format(
        'component:%s:%s:%s',
        v_component.id,
        v_next_stable,
        to_char(date_trunc('minute', coalesce(p_observed_at, timezone('utc', now()))), 'YYYYMMDDHH24MI')
      ),
      'component_alert',
      v_component.id,
      null,
      jsonb_build_object(
        'component_name', v_component.name,
        'stable_status', v_next_stable,
        'raw_status', p_raw_status,
        'message', v_effective_message,
        'confidence_score', v_confidence_score
      )
    );
  end if;

  return query
  select
    v_component.id,
    v_next_stable,
    p_raw_status,
    v_should_alert;
end;
$body$;
$fn$;
  else
    execute $fn$
create or replace function public.system_status_ingest_check(
  p_component_name text,
  p_raw_status public.system_status_type,
  p_latency_ms integer default null,
  p_message text default null,
  p_response_code integer default null,
  p_source_key text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_observed_at timestamptz default timezone('utc', now())
)
returns table (
  component_id uuid,
  stable_status public.system_status_type,
  raw_status public.system_status_type,
  should_alert boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $body$
declare
  v_component public.system_components%rowtype;
  v_snapshot_id uuid;
  v_previous_stable public.system_status_type;
  v_next_stable public.system_status_type;
  v_failures_last3 integer := 0;
  v_majors_last2 integer := 0;
  v_operational_last2 integer := 0;
  v_degraded_last3 integer := 0;
  v_today date := timezone('utc', coalesce(p_observed_at, timezone('utc', now())))::date;
begin
  select *
  into v_component
  from public.system_components
  where name = p_component_name
  limit 1;

  if not found then
    raise exception 'Componente de status nao encontrado: %', p_component_name;
  end if;

  v_previous_stable := coalesce(v_component.status, 'operational');

  insert into public.system_status_monitor_snapshots (
    source_key,
    component_slug,
    component_id,
    component_name,
    status,
    latency_ms,
    response_code,
    message,
    metadata,
    observed_at
  )
  values (
    coalesce(p_source_key, v_component.source_key, v_component.slug, lower(regexp_replace(v_component.name, '[^a-zA-Z0-9]+', '-', 'g'))),
    v_component.slug,
    v_component.id,
    v_component.name,
    p_raw_status,
    p_latency_ms,
    p_response_code,
    p_message,
    coalesce(p_metadata, '{}'::jsonb),
    coalesce(p_observed_at, timezone('utc', now()))
  )
  returning id into v_snapshot_id;

  with recent as (
    select
      s.status,
      row_number() over (order by s.observed_at desc, s.id desc) as rn
    from public.system_status_monitor_snapshots s
    where s.component_id = v_component.id
    order by s.observed_at desc, s.id desc
    limit 5
  )
  select
    count(*) filter (where rn <= 3 and status in ('partial_outage', 'major_outage')),
    count(*) filter (where rn <= 2 and status = 'major_outage'),
    count(*) filter (where rn <= 2 and status = 'operational'),
    count(*) filter (where rn <= 3 and status = 'degraded_performance')
  into
    v_failures_last3,
    v_majors_last2,
    v_operational_last2,
    v_degraded_last3
  from recent;

  v_next_stable := v_previous_stable;

  if p_raw_status = 'major_outage' and v_majors_last2 >= 2 then
    v_next_stable := 'major_outage';
  elsif p_raw_status in ('partial_outage', 'major_outage') and v_failures_last3 >= 2 then
    v_next_stable := case
      when v_majors_last2 >= 2 then 'major_outage'
      else 'partial_outage'
    end;
  elsif p_raw_status = 'degraded_performance' and v_degraded_last3 >= 3 then
    v_next_stable := 'degraded_performance';
  elsif p_raw_status = 'operational' and v_operational_last2 >= 2 then
    v_next_stable := 'operational';
  end if;

  if v_component.name = 'Flow AI' and v_next_stable = 'degraded_performance' then
    v_next_stable := 'operational';
  end if;

  update public.system_status_monitor_snapshots
  set stable_status = v_next_stable
  where id = v_snapshot_id;

  update public.system_components
  set
    status = v_next_stable,
    latency_ms = p_latency_ms,
    source_key = coalesce(p_source_key, source_key),
    status_message = p_message,
    last_checked_at = coalesce(p_observed_at, timezone('utc', now())),
    last_raw_status = p_raw_status,
    last_raw_checked_at = coalesce(p_observed_at, timezone('utc', now())),
    status_changed_at = case
      when status is distinct from v_next_stable then coalesce(p_observed_at, timezone('utc', now()))
      else status_changed_at
    end,
    last_failure_at = case
      when public.system_status_is_incident_worthy(v_next_stable) then coalesce(p_observed_at, timezone('utc', now()))
      else last_failure_at
    end,
    last_recovered_at = case
      when v_next_stable = 'operational' and status <> 'operational' then coalesce(p_observed_at, timezone('utc', now()))
      else last_recovered_at
    end,
    today_failure_count = case
      when public.system_status_is_incident_worthy(v_next_stable) and status = 'operational' then
        case
          when last_failure_at is not null
            and timezone('utc', last_failure_at)::date = v_today
          then coalesce(today_failure_count, 0) + 1
          else 1
        end
      when last_failure_at is not null
        and timezone('utc', last_failure_at)::date <> v_today
      then 0
      else coalesce(today_failure_count, 0)
    end,
    updated_at = timezone('utc', now()),
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'last_raw_status', p_raw_status,
      'last_stable_status', v_next_stable,
      'last_message', p_message,
      'last_response_code', p_response_code,
      'last_monitor_metadata', coalesce(p_metadata, '{}'::jsonb)
    )
  where id = v_component.id;

  insert into public.system_status_history (
    component_id,
    status,
    recorded_at
  )
  values (
    v_component.id,
    v_next_stable,
    v_today
  )
  on conflict on constraint system_status_history_component_id_recorded_at_key do update
  set status = case
    when public.get_status_severity_weight(excluded.status) > public.get_status_severity_weight(public.system_status_history.status)
    then excluded.status
    else public.system_status_history.status
  end;

  return query
  select
    v_component.id,
    v_next_stable,
    p_raw_status,
    public.system_status_is_incident_worthy(v_next_stable);
end;
$body$;
$fn$;
  end if;
end
$$;


-- ============================================================================
-- MIGRATION: 091_status_ingest_check_ambiguity_hotfix.sql
-- ============================================================================

-- Hotfix para ambientes onde o RPC public.system_status_ingest_check
-- foi criado com ON CONFLICT (component_id, recorded_at) dentro de uma
-- funcao RETURNS TABLE, o que torna "component_id" ambiguo no PL/pgSQL.

do $$
declare
  v_signature regprocedure;
  v_definition text;
  v_old_fragment text := 'on conflict (component_id, recorded_at) do update';
  v_new_fragment text :=
    'on conflict on constraint system_status_history_component_id_recorded_at_key do update';
begin
  v_signature := to_regprocedure(
    'public.system_status_ingest_check(text,public.system_status_type,integer,text,integer,text,jsonb,timestamptz)'
  );

  if v_signature is null then
    raise notice 'system_status_ingest_check nao encontrada; hotfix ignorado.';
    return;
  end if;

  select pg_get_functiondef(v_signature)
  into v_definition;

  if v_definition is null then
    raise notice 'Nao foi possivel ler a definicao atual de system_status_ingest_check.';
    return;
  end if;

  if position(v_new_fragment in lower(v_definition)) > 0 then
    raise notice 'system_status_ingest_check ja esta com o hotfix aplicado.';
    return;
  end if;

  if position(v_old_fragment in lower(v_definition)) = 0 then
    raise notice 'Trecho legado nao encontrado; nenhuma alteracao aplicada em system_status_ingest_check.';
    return;
  end if;

  execute replace(v_definition, v_old_fragment, v_new_fragment);
  raise notice 'Hotfix aplicado em system_status_ingest_check.';
end
$$;


-- ============================================================================
-- MIGRATION: 092_auth_email_password_and_otp.sql
-- ============================================================================

alter table public.auth_users
  alter column discord_user_id drop not null;

alter table public.auth_users
  add column if not exists email_normalized text,
  add column if not exists email_verified_at timestamptz,
  add column if not exists last_login_at timestamptz,
  add column if not exists last_auth_method text;

update public.auth_users
set
  email = lower(trim(email)),
  email_normalized = lower(trim(email))
where email is not null
  and (
    email <> lower(trim(email))
    or email_normalized is distinct from lower(trim(email))
  );

create unique index if not exists idx_auth_users_email_normalized_unique
on public.auth_users (email_normalized)
where email_normalized is not null;

create index if not exists idx_auth_users_discord_user_id_not_null
on public.auth_users (discord_user_id)
where discord_user_id is not null;

create table if not exists public.auth_user_credentials (
  user_id bigint primary key references public.auth_users(id) on delete cascade,
  password_hash text not null,
  password_version integer not null default 1,
  password_set_at timestamptz not null default timezone('utc', now()),
  last_password_login_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_user_credentials_password_hash_length_check
    check (char_length(password_hash) >= 32)
);

drop trigger if exists tr_auth_user_credentials_updated_at on public.auth_user_credentials;
create trigger tr_auth_user_credentials_updated_at
before update on public.auth_user_credentials
for each row
execute function public.set_updated_at();

create table if not exists public.auth_email_otp_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.auth_users(id) on delete cascade,
  email text not null,
  email_normalized text not null,
  purpose text not null default 'login',
  code_hash text not null,
  ip_address text,
  user_agent text,
  attempts integer not null default 0,
  max_attempts integer not null default 6,
  resend_count integer not null default 0,
  last_sent_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_email_otp_challenges_purpose_check
    check (purpose in ('login')),
  constraint auth_email_otp_challenges_attempts_check
    check (attempts >= 0 and attempts <= 50),
  constraint auth_email_otp_challenges_resend_count_check
    check (resend_count >= 0 and resend_count <= 20)
);

drop trigger if exists tr_auth_email_otp_challenges_updated_at on public.auth_email_otp_challenges;
create trigger tr_auth_email_otp_challenges_updated_at
before update on public.auth_email_otp_challenges
for each row
execute function public.set_updated_at();

create index if not exists idx_auth_email_otp_challenges_user_created_at
on public.auth_email_otp_challenges (user_id, created_at desc);

create index if not exists idx_auth_email_otp_challenges_email_created_at
on public.auth_email_otp_challenges (email_normalized, created_at desc);

create index if not exists idx_auth_email_otp_challenges_expires_at
on public.auth_email_otp_challenges (expires_at);

create index if not exists idx_auth_email_otp_challenges_active
on public.auth_email_otp_challenges (email_normalized, expires_at desc)
where consumed_at is null;


-- ============================================================================
-- MIGRATION: 093_auth_email_password_and_otp_rls.sql
-- ============================================================================

alter table public.auth_user_credentials enable row level security;

drop policy if exists "service_role_all_auth_user_credentials" on public.auth_user_credentials;
create policy "service_role_all_auth_user_credentials"
on public.auth_user_credentials
for all
to service_role
using (true)
with check (true);

alter table public.auth_email_otp_challenges enable row level security;

drop policy if exists "service_role_all_auth_email_otp_challenges" on public.auth_email_otp_challenges;
create policy "service_role_all_auth_email_otp_challenges"
on public.auth_email_otp_challenges
for all
to service_role
using (true)
with check (true);


-- ============================================================================
-- MIGRATION: 094_auth_google_and_trusted_devices.sql
-- ============================================================================

alter table public.auth_users
  add column if not exists google_user_id text;

create unique index if not exists idx_auth_users_google_user_id_unique
on public.auth_users (google_user_id)
where google_user_id is not null;

create table if not exists public.auth_user_trusted_devices (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.auth_users(id) on delete cascade,
  token_hash text not null unique,
  user_agent_hash text,
  last_used_at timestamptz,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_user_trusted_devices_token_hash_length_check
    check (char_length(token_hash) >= 32)
);

drop trigger if exists tr_auth_user_trusted_devices_updated_at on public.auth_user_trusted_devices;
create trigger tr_auth_user_trusted_devices_updated_at
before update on public.auth_user_trusted_devices
for each row
execute function public.set_updated_at();

create index if not exists idx_auth_user_trusted_devices_user_expires_at
on public.auth_user_trusted_devices (user_id, expires_at desc);

create index if not exists idx_auth_user_trusted_devices_active
on public.auth_user_trusted_devices (user_id, expires_at desc)
where revoked_at is null;


-- ============================================================================
-- MIGRATION: 095_auth_google_and_trusted_devices_rls.sql
-- ============================================================================

alter table public.auth_user_trusted_devices enable row level security;

drop policy if exists "service_role_all_auth_user_trusted_devices" on public.auth_user_trusted_devices;
create policy "service_role_all_auth_user_trusted_devices"
on public.auth_user_trusted_devices
for all
to service_role
using (true)
with check (true);


-- ============================================================================
-- MIGRATION: 096_auth_microsoft.sql
-- ============================================================================

alter table public.auth_users
  add column if not exists microsoft_user_id text;

create unique index if not exists idx_auth_users_microsoft_user_id_unique
on public.auth_users (microsoft_user_id)
where microsoft_user_id is not null;


-- ============================================================================
-- MIGRATION: 096_scheduled_tasks_search_path_hardening.sql
-- ============================================================================

-- Reforca o search_path das funcoes antigas do sistema de tarefas agendadas.
-- Isso corrige ambientes ja provisionados onde as funcoes podem ter ficado sem
-- search_path fixo mesmo apos recriacoes manuais.

alter function public.create_plan_expiry_task()
set search_path = pg_catalog, public;

alter function public.handle_plan_status_change()
set search_path = pg_catalog, public;


-- ============================================================================
-- MIGRATION: 097_auth_social_otp_and_session_hardening.sql
-- ============================================================================

create extension if not exists pgcrypto;

alter table if exists public.auth_users
  alter column discord_user_id drop not null;

alter table if exists public.auth_users
  add column if not exists email_normalized text,
  add column if not exists email_verified_at timestamptz,
  add column if not exists google_user_id text,
  add column if not exists microsoft_user_id text,
  add column if not exists last_login_at timestamptz,
  add column if not exists last_auth_method text;

update public.auth_users
set
  email = nullif(lower(trim(email)), ''),
  email_normalized = nullif(lower(trim(email)), '')
where email is not null
  and (
    email is distinct from nullif(lower(trim(email)), '')
    or email_normalized is distinct from nullif(lower(trim(email)), '')
  );

do $$
declare
  duplicate_record record;
  base_username text;
  candidate_username text;
  suffix_number integer;
begin
  for duplicate_record in
    select id, username
    from (
      select
        id,
        username,
        row_number() over (
          partition by username
          order by id
        ) as duplicate_rank
      from public.auth_users
      where username is not null
    ) duplicated
    where duplicate_rank > 1
    order by id
  loop
    base_username := lower(trim(coalesce(duplicate_record.username, 'flowdesk-user')));
    base_username := regexp_replace(base_username, '[^a-z0-9._-]+', '-', 'g');
    base_username := regexp_replace(base_username, '-{2,}', '-', 'g');
    base_username := regexp_replace(base_username, '^[-._]+|[-._]+$', '', 'g');
    base_username := left(nullif(base_username, ''), 32);

    if base_username is null then
      base_username := 'flowdesk-user';
    end if;

    candidate_username := base_username;
    suffix_number := 2;

    while exists (
      select 1
      from public.auth_users
      where username = candidate_username
        and id <> duplicate_record.id
    ) loop
      candidate_username :=
        left(
          base_username,
          greatest(1, 32 - char_length('-' || suffix_number::text))
        ) || '-' || suffix_number::text;
      suffix_number := suffix_number + 1;
    end loop;

    update public.auth_users
    set username = candidate_username
    where id = duplicate_record.id;
  end loop;
end
$$;

create unique index if not exists idx_auth_users_username_unique
on public.auth_users (username);

create unique index if not exists idx_auth_users_email_normalized_unique
on public.auth_users (email_normalized)
where email_normalized is not null;

create index if not exists idx_auth_users_discord_user_id_not_null
on public.auth_users (discord_user_id)
where discord_user_id is not null;

create unique index if not exists idx_auth_users_google_user_id_unique
on public.auth_users (google_user_id)
where google_user_id is not null;

create unique index if not exists idx_auth_users_microsoft_user_id_unique
on public.auth_users (microsoft_user_id)
where microsoft_user_id is not null;

create table if not exists public.auth_user_credentials (
  user_id bigint primary key references public.auth_users(id) on delete cascade,
  password_hash text not null,
  password_version integer not null default 1,
  password_set_at timestamptz not null default timezone('utc', now()),
  last_password_login_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_user_credentials_password_hash_length_check
    check (char_length(password_hash) >= 32)
);

drop trigger if exists tr_auth_user_credentials_updated_at on public.auth_user_credentials;
create trigger tr_auth_user_credentials_updated_at
before update on public.auth_user_credentials
for each row
execute function public.set_updated_at();

create table if not exists public.auth_email_otp_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.auth_users(id) on delete cascade,
  email text not null,
  email_normalized text not null,
  purpose text not null default 'login',
  code_hash text not null,
  ip_address text,
  user_agent text,
  attempts integer not null default 0,
  max_attempts integer not null default 6,
  resend_count integer not null default 0,
  last_sent_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_email_otp_challenges_purpose_check
    check (purpose in ('login')),
  constraint auth_email_otp_challenges_attempts_check
    check (attempts >= 0 and attempts <= 50),
  constraint auth_email_otp_challenges_resend_count_check
    check (resend_count >= 0 and resend_count <= 20)
);

alter table public.auth_email_otp_challenges
  add column if not exists metadata jsonb not null default '{}'::jsonb;

drop trigger if exists tr_auth_email_otp_challenges_updated_at on public.auth_email_otp_challenges;
create trigger tr_auth_email_otp_challenges_updated_at
before update on public.auth_email_otp_challenges
for each row
execute function public.set_updated_at();

create index if not exists idx_auth_email_otp_challenges_user_created_at
on public.auth_email_otp_challenges (user_id, created_at desc);

create index if not exists idx_auth_email_otp_challenges_email_created_at
on public.auth_email_otp_challenges (email_normalized, created_at desc);

create index if not exists idx_auth_email_otp_challenges_expires_at
on public.auth_email_otp_challenges (expires_at);

create index if not exists idx_auth_email_otp_challenges_active
on public.auth_email_otp_challenges (email_normalized, expires_at desc)
where consumed_at is null;

create index if not exists idx_auth_email_otp_challenges_active_user_purpose
on public.auth_email_otp_challenges (user_id, purpose, expires_at desc)
where consumed_at is null;

create table if not exists public.auth_user_trusted_devices (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.auth_users(id) on delete cascade,
  token_hash text not null unique,
  user_agent_hash text,
  last_used_at timestamptz,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_user_trusted_devices_token_hash_length_check
    check (char_length(token_hash) >= 32)
);

alter table public.auth_user_trusted_devices
  add column if not exists user_agent_hash text,
  add column if not exists last_used_at timestamptz,
  add column if not exists revoked_at timestamptz;

drop trigger if exists tr_auth_user_trusted_devices_updated_at on public.auth_user_trusted_devices;
create trigger tr_auth_user_trusted_devices_updated_at
before update on public.auth_user_trusted_devices
for each row
execute function public.set_updated_at();

create index if not exists idx_auth_user_trusted_devices_user_expires_at
on public.auth_user_trusted_devices (user_id, expires_at desc);

create index if not exists idx_auth_user_trusted_devices_active
on public.auth_user_trusted_devices (user_id, expires_at desc)
where revoked_at is null;

alter table if exists public.auth_sessions
  add column if not exists discord_access_token text,
  add column if not exists discord_refresh_token text,
  add column if not exists discord_token_expires_at timestamptz,
  add column if not exists auth_method text,
  add column if not exists otp_verified_at timestamptz,
  add column if not exists remembered_until timestamptz;

update public.auth_sessions s
set auth_method = coalesce(
  s.auth_method,
  case
    when s.discord_access_token is not null then 'discord'
    when u.google_user_id is not null and u.discord_user_id is null then 'google'
    when u.microsoft_user_id is not null and u.discord_user_id is null then 'microsoft'
    else 'email'
  end
)
from public.auth_users u
where u.id = s.user_id
  and s.auth_method is null;

update public.auth_sessions
set auth_method = 'email'
where auth_method is null;

alter table public.auth_sessions
  alter column auth_method set default 'email';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'auth_sessions_auth_method_check'
      and conrelid = 'public.auth_sessions'::regclass
  ) then
    alter table public.auth_sessions
      add constraint auth_sessions_auth_method_check
      check (auth_method in ('email', 'discord', 'google', 'microsoft'));
  end if;
end
$$;

create index if not exists idx_auth_sessions_auth_method_expires_at
on public.auth_sessions (auth_method, expires_at desc);

create index if not exists idx_auth_sessions_remembered_until
on public.auth_sessions (remembered_until)
where remembered_until is not null;

alter table public.auth_users enable row level security;
alter table public.auth_sessions enable row level security;
alter table public.auth_user_credentials enable row level security;
alter table public.auth_email_otp_challenges enable row level security;
alter table public.auth_user_trusted_devices enable row level security;

drop policy if exists "service_role_all_auth_users" on public.auth_users;
create policy "service_role_all_auth_users"
on public.auth_users
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_auth_sessions" on public.auth_sessions;
create policy "service_role_all_auth_sessions"
on public.auth_sessions
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_auth_user_credentials" on public.auth_user_credentials;
create policy "service_role_all_auth_user_credentials"
on public.auth_user_credentials
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_auth_email_otp_challenges" on public.auth_email_otp_challenges;
create policy "service_role_all_auth_email_otp_challenges"
on public.auth_email_otp_challenges
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_auth_user_trusted_devices" on public.auth_user_trusted_devices;
create policy "service_role_all_auth_user_trusted_devices"
on public.auth_user_trusted_devices
for all
to service_role
using (true)
with check (true);


-- ============================================================================
-- MIGRATION: 098_payment_pii_hardening.sql
-- ============================================================================

alter table public.payment_orders
add column if not exists payer_document_encrypted text,
add column if not exists payer_document_last4 text;

alter table public.auth_user_payment_method_verifications
add column if not exists payer_document_encrypted text,
add column if not exists payer_document_last4 text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'payment_orders_payer_document_last4_check'
      and conrelid = 'public.payment_orders'::regclass
  ) then
    alter table public.payment_orders
      add constraint payment_orders_payer_document_last4_check
      check (
        payer_document_last4 is null
        or payer_document_last4 ~ '^[0-9]{1,4}$'
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'auth_user_payment_method_verifications_payer_document_last4_check'
      and conrelid = 'public.auth_user_payment_method_verifications'::regclass
  ) then
    alter table public.auth_user_payment_method_verifications
      add constraint auth_user_payment_method_verifications_payer_document_last4_check
      check (
        payer_document_last4 is null
        or payer_document_last4 ~ '^[0-9]{1,4}$'
      );
  end if;
end $$;

update public.payment_orders
set payer_document_last4 = right(
  regexp_replace(coalesce(payer_document, ''), '\D', '', 'g'),
  4
)
where payer_document_last4 is null
  and nullif(regexp_replace(coalesce(payer_document, ''), '\D', '', 'g'), '') is not null;

update public.auth_user_payment_method_verifications
set payer_document_last4 = right(
  regexp_replace(coalesce(payer_document, ''), '\D', '', 'g'),
  4
)
where payer_document_last4 is null
  and nullif(regexp_replace(coalesce(payer_document, ''), '\D', '', 'g'), '') is not null;


-- ============================================================================
-- MIGRATION: 099_flowsecure_rate_limit.sql
-- ============================================================================

create table if not exists public.flowsecure_rate_limit_hits (
  id bigint generated always as identity primary key,
  request_id text not null,
  ip_fingerprint text not null,
  ip_encrypted text not null,
  request_method text not null,
  request_path text not null,
  route_key text not null,
  traffic_scope text not null
    check (traffic_scope in ('page', 'api_read', 'api_mutation', 'auth', 'other')),
  signature_hash text not null,
  signature_kind text not null
    check (signature_kind in ('page', 'query', 'json', 'urlencoded', 'opaque')),
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  blocked boolean not null default false,
  blocked_reason text,
  blocked_until timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_flowsecure_rate_limit_hits_ip_created_at
on public.flowsecure_rate_limit_hits (ip_fingerprint, created_at desc);

create index if not exists idx_flowsecure_rate_limit_hits_ip_signature_created_at
on public.flowsecure_rate_limit_hits (ip_fingerprint, signature_hash, created_at desc);

create index if not exists idx_flowsecure_rate_limit_hits_ip_route_created_at
on public.flowsecure_rate_limit_hits (ip_fingerprint, route_key, created_at desc);

create index if not exists idx_flowsecure_rate_limit_hits_ip_scope_created_at
on public.flowsecure_rate_limit_hits (ip_fingerprint, traffic_scope, created_at desc);

create table if not exists public.flowsecure_rate_limit_blocks (
  ip_fingerprint text primary key,
  ip_encrypted text not null,
  request_method text not null,
  request_path text not null,
  route_key text not null,
  traffic_scope text not null
    check (traffic_scope in ('page', 'api_read', 'api_mutation', 'auth', 'other')),
  signature_hash text not null,
  block_reason text not null,
  hit_count integer not null default 0,
  duplicate_hits integer not null default 0,
  route_hits integer not null default 0,
  scope_hits integer not null default 0,
  site_hits integer not null default 0,
  threshold integer not null default 0,
  window_seconds integer not null default 60,
  blocked_until timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_flowsecure_rate_limit_blocks_until
on public.flowsecure_rate_limit_blocks (blocked_until desc);

alter table public.flowsecure_rate_limit_hits enable row level security;
alter table public.flowsecure_rate_limit_blocks enable row level security;

drop policy if exists "service_role_all_flowsecure_rate_limit_hits"
on public.flowsecure_rate_limit_hits;

create policy "service_role_all_flowsecure_rate_limit_hits"
on public.flowsecure_rate_limit_hits
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_flowsecure_rate_limit_blocks"
on public.flowsecure_rate_limit_blocks;

create policy "service_role_all_flowsecure_rate_limit_blocks"
on public.flowsecure_rate_limit_blocks
for all
to service_role
using (true)
with check (true);

create or replace function public.apply_flowsecure_rate_limit(
  p_request_id text,
  p_ip_fingerprint text,
  p_ip_encrypted text,
  p_request_method text,
  p_request_path text,
  p_route_key text,
  p_traffic_scope text,
  p_signature_hash text,
  p_signature_kind text,
  p_user_agent text default null,
  p_window_seconds integer default 60,
  p_penalty_seconds integer default 60,
  p_duplicate_threshold integer default 8,
  p_scope_threshold integer default 40,
  p_site_threshold integer default 160,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := timezone('utc', now());
  v_window_seconds integer := greatest(1, coalesce(p_window_seconds, 60));
  v_penalty_seconds integer := greatest(1, coalesce(p_penalty_seconds, 60));
  v_duplicate_threshold integer := greatest(1, coalesce(p_duplicate_threshold, 8));
  v_scope_threshold integer := greatest(1, coalesce(p_scope_threshold, 40));
  v_site_threshold integer := greatest(1, coalesce(p_site_threshold, 160));
  v_window_start timestamptz := v_now - make_interval(secs => v_window_seconds);
  v_traffic_scope text := case
    when p_traffic_scope in ('page', 'api_read', 'api_mutation', 'auth', 'other')
      then p_traffic_scope
    else 'other'
  end;
  v_signature_kind text := case
    when p_signature_kind in ('page', 'query', 'json', 'urlencoded', 'opaque')
      then p_signature_kind
    else 'opaque'
  end;
  v_existing_block public.flowsecure_rate_limit_blocks%rowtype;
  v_hit_id bigint;
  v_duplicate_hits integer := 0;
  v_route_hits integer := 0;
  v_scope_hits integer := 0;
  v_site_hits integer := 0;
  v_reason text := null;
  v_blocked_until timestamptz := null;
  v_retry_after_seconds integer := 0;
begin
  if coalesce(btrim(p_ip_fingerprint), '') = '' or coalesce(btrim(p_ip_encrypted), '') = '' then
    return jsonb_build_object(
      'allowed', true,
      'blocked', false,
      'retry_after_seconds', 0,
      'block_reason', null,
      'duplicate_hits', 0,
      'route_hits', 0,
      'scope_hits', 0,
      'site_hits', 0,
      'blocked_until', null
    );
  end if;

  if random() < 0.01 then
    delete from public.flowsecure_rate_limit_hits
    where created_at < v_now - interval '2 days';

    delete from public.flowsecure_rate_limit_blocks
    where blocked_until <= v_now - interval '1 day';
  end if;

  select *
  into v_existing_block
  from public.flowsecure_rate_limit_blocks
  where ip_fingerprint = p_ip_fingerprint
    and blocked_until > v_now
  limit 1
  for update;

  if found then
    v_retry_after_seconds := greatest(
      1,
      ceil(extract(epoch from (v_existing_block.blocked_until - v_now)))::integer
    );

    insert into public.flowsecure_rate_limit_hits (
      request_id,
      ip_fingerprint,
      ip_encrypted,
      request_method,
      request_path,
      route_key,
      traffic_scope,
      signature_hash,
      signature_kind,
      user_agent,
      metadata,
      blocked,
      blocked_reason,
      blocked_until
    )
    values (
      coalesce(nullif(btrim(p_request_id), ''), gen_random_uuid()::text),
      p_ip_fingerprint,
      p_ip_encrypted,
      coalesce(nullif(btrim(p_request_method), ''), 'GET'),
      coalesce(nullif(btrim(p_request_path), ''), '/'),
      coalesce(nullif(btrim(p_route_key), ''), 'GET:/'),
      v_traffic_scope,
      coalesce(nullif(btrim(p_signature_hash), ''), 'missing'),
      v_signature_kind,
      nullif(btrim(p_user_agent), ''),
      coalesce(p_metadata, '{}'::jsonb),
      true,
      coalesce(v_existing_block.block_reason, 'active_block'),
      v_existing_block.blocked_until
    );

    return jsonb_build_object(
      'allowed', false,
      'blocked', true,
      'retry_after_seconds', v_retry_after_seconds,
      'block_reason', coalesce(v_existing_block.block_reason, 'active_block'),
      'duplicate_hits', v_existing_block.duplicate_hits,
      'route_hits', v_existing_block.route_hits,
      'scope_hits', v_existing_block.scope_hits,
      'site_hits', v_existing_block.site_hits,
      'blocked_until', v_existing_block.blocked_until
    );
  end if;

  insert into public.flowsecure_rate_limit_hits (
    request_id,
    ip_fingerprint,
    ip_encrypted,
    request_method,
    request_path,
    route_key,
    traffic_scope,
    signature_hash,
    signature_kind,
    user_agent,
    metadata
  )
  values (
    coalesce(nullif(btrim(p_request_id), ''), gen_random_uuid()::text),
    p_ip_fingerprint,
    p_ip_encrypted,
    coalesce(nullif(btrim(p_request_method), ''), 'GET'),
    coalesce(nullif(btrim(p_request_path), ''), '/'),
    coalesce(nullif(btrim(p_route_key), ''), 'GET:/'),
    v_traffic_scope,
    coalesce(nullif(btrim(p_signature_hash), ''), 'missing'),
    v_signature_kind,
    nullif(btrim(p_user_agent), ''),
    coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_hit_id;

  select count(*)::integer
  into v_duplicate_hits
  from public.flowsecure_rate_limit_hits
  where ip_fingerprint = p_ip_fingerprint
    and signature_hash = coalesce(nullif(btrim(p_signature_hash), ''), 'missing')
    and created_at >= v_window_start;

  select count(*)::integer
  into v_route_hits
  from public.flowsecure_rate_limit_hits
  where ip_fingerprint = p_ip_fingerprint
    and route_key = coalesce(nullif(btrim(p_route_key), ''), 'GET:/')
    and created_at >= v_window_start;

  select count(*)::integer
  into v_scope_hits
  from public.flowsecure_rate_limit_hits
  where ip_fingerprint = p_ip_fingerprint
    and traffic_scope = v_traffic_scope
    and created_at >= v_window_start;

  select count(*)::integer
  into v_site_hits
  from public.flowsecure_rate_limit_hits
  where ip_fingerprint = p_ip_fingerprint
    and created_at >= v_window_start;

  if v_traffic_scope = 'page' and v_route_hits >= v_duplicate_threshold then
    v_reason := 'page_reload_burst';
  elsif v_duplicate_hits >= v_duplicate_threshold then
    v_reason := 'duplicate_signature';
  elsif v_scope_hits >= v_scope_threshold then
    v_reason := 'scope_burst';
  elsif v_site_hits >= v_site_threshold then
    v_reason := 'site_burst';
  end if;

  if v_reason is not null then
    v_blocked_until := v_now + make_interval(secs => v_penalty_seconds);
    v_retry_after_seconds := greatest(
      1,
      ceil(extract(epoch from (v_blocked_until - v_now)))::integer
    );

    update public.flowsecure_rate_limit_hits
    set
      blocked = true,
      blocked_reason = v_reason,
      blocked_until = v_blocked_until
    where id = v_hit_id;

    insert into public.flowsecure_rate_limit_blocks (
      ip_fingerprint,
      ip_encrypted,
      request_method,
      request_path,
      route_key,
      traffic_scope,
      signature_hash,
      block_reason,
      hit_count,
      duplicate_hits,
      route_hits,
      scope_hits,
      site_hits,
      threshold,
      window_seconds,
      blocked_until,
      metadata,
      updated_at
    )
    values (
      p_ip_fingerprint,
      p_ip_encrypted,
      coalesce(nullif(btrim(p_request_method), ''), 'GET'),
      coalesce(nullif(btrim(p_request_path), ''), '/'),
      coalesce(nullif(btrim(p_route_key), ''), 'GET:/'),
      v_traffic_scope,
      coalesce(nullif(btrim(p_signature_hash), ''), 'missing'),
      v_reason,
      greatest(v_duplicate_hits, v_route_hits, v_scope_hits, v_site_hits),
      v_duplicate_hits,
      v_route_hits,
      v_scope_hits,
      v_site_hits,
      case
        when v_reason = 'duplicate_signature' then v_duplicate_threshold
        when v_reason = 'page_reload_burst' then v_duplicate_threshold
        when v_reason = 'scope_burst' then v_scope_threshold
        else v_site_threshold
      end,
      v_window_seconds,
      v_blocked_until,
      coalesce(p_metadata, '{}'::jsonb),
      v_now
    )
    on conflict (ip_fingerprint) do update
    set
      ip_encrypted = excluded.ip_encrypted,
      request_method = excluded.request_method,
      request_path = excluded.request_path,
      route_key = excluded.route_key,
      traffic_scope = excluded.traffic_scope,
      signature_hash = excluded.signature_hash,
      block_reason = excluded.block_reason,
      hit_count = excluded.hit_count,
      duplicate_hits = excluded.duplicate_hits,
      route_hits = excluded.route_hits,
      scope_hits = excluded.scope_hits,
      site_hits = excluded.site_hits,
      threshold = excluded.threshold,
      window_seconds = excluded.window_seconds,
      blocked_until = excluded.blocked_until,
      metadata = excluded.metadata,
      updated_at = v_now;

    return jsonb_build_object(
      'allowed', false,
      'blocked', true,
      'retry_after_seconds', v_retry_after_seconds,
      'block_reason', v_reason,
      'duplicate_hits', v_duplicate_hits,
      'route_hits', v_route_hits,
      'scope_hits', v_scope_hits,
      'site_hits', v_site_hits,
      'blocked_until', v_blocked_until
    );
  end if;

  return jsonb_build_object(
    'allowed', true,
    'blocked', false,
    'retry_after_seconds', 0,
    'block_reason', null,
    'duplicate_hits', v_duplicate_hits,
    'route_hits', v_route_hits,
    'scope_hits', v_scope_hits,
    'site_hits', v_site_hits,
    'blocked_until', null
  );
end;
$$;

revoke all on function public.apply_flowsecure_rate_limit(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  integer,
  integer,
  integer,
  integer,
  integer,
  jsonb
) from public, anon, authenticated;

grant execute on function public.apply_flowsecure_rate_limit(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  integer,
  integer,
  integer,
  integer,
  integer,
  jsonb
) to service_role;


-- ============================================================================
-- MIGRATION: 100_flowsecure_rate_limit_targeted_blocks.sql
-- ============================================================================

alter table public.flowsecure_rate_limit_blocks
  add column if not exists block_scope text,
  add column if not exists block_key text;

update public.flowsecure_rate_limit_blocks
set
  block_scope = coalesce(nullif(block_scope, ''), 'ip'),
  block_key = coalesce(nullif(block_key, ''), '__ip__')
where
  block_scope is null
  or btrim(block_scope) = ''
  or block_key is null
  or btrim(block_key) = '';

alter table public.flowsecure_rate_limit_blocks
  alter column block_scope set default 'ip',
  alter column block_scope set not null,
  alter column block_key set default '__ip__',
  alter column block_key set not null;

alter table public.flowsecure_rate_limit_blocks
  drop constraint if exists flowsecure_rate_limit_blocks_block_scope_check;

alter table public.flowsecure_rate_limit_blocks
  drop constraint if exists flowsecure_rate_limit_blocks_block_scope_check_v2;

alter table public.flowsecure_rate_limit_blocks
  add constraint flowsecure_rate_limit_blocks_block_scope_check_v2
  check (block_scope in ('ip', 'scope', 'route', 'signature'));

alter table public.flowsecure_rate_limit_blocks
  drop constraint if exists flowsecure_rate_limit_blocks_pkey;

alter table public.flowsecure_rate_limit_blocks
  add constraint flowsecure_rate_limit_blocks_pkey
  primary key (ip_fingerprint, block_scope, block_key);

create index if not exists idx_flowsecure_rate_limit_blocks_ip_scope_key_until
on public.flowsecure_rate_limit_blocks (ip_fingerprint, block_scope, block_key, blocked_until desc);

create or replace function public.apply_flowsecure_rate_limit(
  p_request_id text,
  p_ip_fingerprint text,
  p_ip_encrypted text,
  p_request_method text,
  p_request_path text,
  p_route_key text,
  p_traffic_scope text,
  p_signature_hash text,
  p_signature_kind text,
  p_user_agent text default null,
  p_window_seconds integer default 60,
  p_penalty_seconds integer default 60,
  p_duplicate_threshold integer default 8,
  p_scope_threshold integer default 40,
  p_site_threshold integer default 160,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := timezone('utc', now());
  v_window_seconds integer := greatest(1, coalesce(p_window_seconds, 60));
  v_penalty_seconds integer := greatest(1, coalesce(p_penalty_seconds, 60));
  v_duplicate_threshold integer := greatest(1, coalesce(p_duplicate_threshold, 8));
  v_scope_threshold integer := greatest(1, coalesce(p_scope_threshold, 40));
  v_site_threshold integer := greatest(1, coalesce(p_site_threshold, 160));
  v_window_start timestamptz := v_now - make_interval(secs => v_window_seconds);
  v_traffic_scope text := case
    when p_traffic_scope in ('page', 'api_read', 'api_mutation', 'auth', 'other')
      then p_traffic_scope
    else 'other'
  end;
  v_signature_kind text := case
    when p_signature_kind in ('page', 'query', 'json', 'urlencoded', 'opaque')
      then p_signature_kind
    else 'opaque'
  end;
  v_route_key text := coalesce(nullif(btrim(p_route_key), ''), 'GET:/');
  v_signature_hash text := coalesce(nullif(btrim(p_signature_hash), ''), 'missing');
  v_route_threshold integer := case
    when v_traffic_scope = 'page' then v_duplicate_threshold
    when v_traffic_scope = 'api_mutation' then greatest(24, v_duplicate_threshold * 2)
    when v_traffic_scope = 'api_read' then greatest(60, v_duplicate_threshold * 4)
    when v_traffic_scope = 'auth' then greatest(12, v_duplicate_threshold + 2)
    else greatest(40, v_duplicate_threshold * 3)
  end;
  v_existing_block public.flowsecure_rate_limit_blocks%rowtype;
  v_hit_id bigint;
  v_duplicate_hits integer := 0;
  v_route_hits integer := 0;
  v_scope_hits integer := 0;
  v_site_hits integer := 0;
  v_reason text := null;
  v_block_scope text := 'ip';
  v_block_key text := '__ip__';
  v_blocked_until timestamptz := null;
  v_retry_after_seconds integer := 0;
begin
  if coalesce(btrim(p_ip_fingerprint), '') = '' or coalesce(btrim(p_ip_encrypted), '') = '' then
    return jsonb_build_object(
      'allowed', true,
      'blocked', false,
      'retry_after_seconds', 0,
      'block_reason', null,
      'duplicate_hits', 0,
      'route_hits', 0,
      'scope_hits', 0,
      'site_hits', 0,
      'blocked_until', null
    );
  end if;

  if random() < 0.01 then
    delete from public.flowsecure_rate_limit_hits
    where created_at < v_now - interval '2 days';

    delete from public.flowsecure_rate_limit_blocks
    where blocked_until <= v_now - interval '1 day';
  end if;

  select *
  into v_existing_block
  from public.flowsecure_rate_limit_blocks
  where ip_fingerprint = p_ip_fingerprint
    and blocked_until > v_now
    and (
      block_scope = 'ip'
      or (block_scope = 'scope' and block_key = v_traffic_scope)
      or (block_scope = 'route' and block_key = v_route_key)
      or (block_scope = 'signature' and block_key = v_signature_hash)
    )
  order by
    case block_scope
      when 'signature' then 1
      when 'route' then 2
      when 'scope' then 3
      else 4
    end,
    blocked_until desc
  limit 1
  for update;

  if found then
    v_retry_after_seconds := greatest(
      1,
      ceil(extract(epoch from (v_existing_block.blocked_until - v_now)))::integer
    );

    insert into public.flowsecure_rate_limit_hits (
      request_id,
      ip_fingerprint,
      ip_encrypted,
      request_method,
      request_path,
      route_key,
      traffic_scope,
      signature_hash,
      signature_kind,
      user_agent,
      metadata,
      blocked,
      blocked_reason,
      blocked_until
    )
    values (
      coalesce(nullif(btrim(p_request_id), ''), gen_random_uuid()::text),
      p_ip_fingerprint,
      p_ip_encrypted,
      coalesce(nullif(btrim(p_request_method), ''), 'GET'),
      coalesce(nullif(btrim(p_request_path), ''), '/'),
      v_route_key,
      v_traffic_scope,
      v_signature_hash,
      v_signature_kind,
      nullif(btrim(p_user_agent), ''),
      coalesce(p_metadata, '{}'::jsonb),
      true,
      coalesce(v_existing_block.block_reason, 'active_block'),
      v_existing_block.blocked_until
    );

    return jsonb_build_object(
      'allowed', false,
      'blocked', true,
      'retry_after_seconds', v_retry_after_seconds,
      'block_reason', coalesce(v_existing_block.block_reason, 'active_block'),
      'duplicate_hits', v_existing_block.duplicate_hits,
      'route_hits', v_existing_block.route_hits,
      'scope_hits', v_existing_block.scope_hits,
      'site_hits', v_existing_block.site_hits,
      'blocked_until', v_existing_block.blocked_until
    );
  end if;

  insert into public.flowsecure_rate_limit_hits (
    request_id,
    ip_fingerprint,
    ip_encrypted,
    request_method,
    request_path,
    route_key,
    traffic_scope,
    signature_hash,
    signature_kind,
    user_agent,
    metadata
  )
  values (
    coalesce(nullif(btrim(p_request_id), ''), gen_random_uuid()::text),
    p_ip_fingerprint,
    p_ip_encrypted,
    coalesce(nullif(btrim(p_request_method), ''), 'GET'),
    coalesce(nullif(btrim(p_request_path), ''), '/'),
    v_route_key,
    v_traffic_scope,
    v_signature_hash,
    v_signature_kind,
    nullif(btrim(p_user_agent), ''),
    coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_hit_id;

  select count(*)::integer
  into v_duplicate_hits
  from public.flowsecure_rate_limit_hits
  where ip_fingerprint = p_ip_fingerprint
    and signature_hash = v_signature_hash
    and created_at >= v_window_start;

  select count(*)::integer
  into v_route_hits
  from public.flowsecure_rate_limit_hits
  where ip_fingerprint = p_ip_fingerprint
    and route_key = v_route_key
    and created_at >= v_window_start;

  select count(*)::integer
  into v_scope_hits
  from public.flowsecure_rate_limit_hits
  where ip_fingerprint = p_ip_fingerprint
    and traffic_scope = v_traffic_scope
    and created_at >= v_window_start;

  select count(*)::integer
  into v_site_hits
  from public.flowsecure_rate_limit_hits
  where ip_fingerprint = p_ip_fingerprint
    and created_at >= v_window_start;

  if v_traffic_scope = 'page' and v_route_hits >= v_duplicate_threshold then
    v_reason := 'page_reload_burst';
  elsif v_duplicate_hits >= v_duplicate_threshold then
    v_reason := 'duplicate_signature';
  elsif v_route_hits >= v_route_threshold then
    v_reason := 'route_burst';
  elsif v_traffic_scope in ('auth', 'other') and v_scope_hits >= v_scope_threshold then
    v_reason := 'scope_burst';
  elsif v_site_hits >= v_site_threshold then
    v_reason := 'site_burst';
  end if;

  if v_reason = 'duplicate_signature' then
    v_block_scope := 'signature';
    v_block_key := v_signature_hash;
  elsif v_reason in ('page_reload_burst', 'route_burst') then
    v_block_scope := 'route';
    v_block_key := v_route_key;
  elsif v_reason = 'scope_burst' then
    v_block_scope := 'scope';
    v_block_key := v_traffic_scope;
  end if;

  if v_reason is not null then
    v_blocked_until := v_now + make_interval(secs => v_penalty_seconds);
    v_retry_after_seconds := greatest(
      1,
      ceil(extract(epoch from (v_blocked_until - v_now)))::integer
    );

    update public.flowsecure_rate_limit_hits
    set
      blocked = true,
      blocked_reason = v_reason,
      blocked_until = v_blocked_until
    where id = v_hit_id;

    insert into public.flowsecure_rate_limit_blocks (
      ip_fingerprint,
      block_scope,
      block_key,
      ip_encrypted,
      request_method,
      request_path,
      route_key,
      traffic_scope,
      signature_hash,
      block_reason,
      hit_count,
      duplicate_hits,
      route_hits,
      scope_hits,
      site_hits,
      threshold,
      window_seconds,
      blocked_until,
      metadata,
      updated_at
    )
    values (
      p_ip_fingerprint,
      v_block_scope,
      v_block_key,
      p_ip_encrypted,
      coalesce(nullif(btrim(p_request_method), ''), 'GET'),
      coalesce(nullif(btrim(p_request_path), ''), '/'),
      v_route_key,
      v_traffic_scope,
      v_signature_hash,
      v_reason,
      greatest(v_duplicate_hits, v_route_hits, v_scope_hits, v_site_hits),
      v_duplicate_hits,
      v_route_hits,
      v_scope_hits,
      v_site_hits,
      case
        when v_reason = 'duplicate_signature' then v_duplicate_threshold
        when v_reason = 'page_reload_burst' then v_duplicate_threshold
        when v_reason = 'route_burst' then v_route_threshold
        when v_reason = 'scope_burst' then v_scope_threshold
        else v_site_threshold
      end,
      v_window_seconds,
      v_blocked_until,
      coalesce(p_metadata, '{}'::jsonb),
      v_now
    )
    on conflict (ip_fingerprint, block_scope, block_key) do update
    set
      ip_encrypted = excluded.ip_encrypted,
      request_method = excluded.request_method,
      request_path = excluded.request_path,
      route_key = excluded.route_key,
      traffic_scope = excluded.traffic_scope,
      signature_hash = excluded.signature_hash,
      block_reason = excluded.block_reason,
      hit_count = excluded.hit_count,
      duplicate_hits = excluded.duplicate_hits,
      route_hits = excluded.route_hits,
      scope_hits = excluded.scope_hits,
      site_hits = excluded.site_hits,
      threshold = excluded.threshold,
      window_seconds = excluded.window_seconds,
      blocked_until = excluded.blocked_until,
      metadata = excluded.metadata,
      updated_at = v_now;

    return jsonb_build_object(
      'allowed', false,
      'blocked', true,
      'retry_after_seconds', v_retry_after_seconds,
      'block_reason', v_reason,
      'duplicate_hits', v_duplicate_hits,
      'route_hits', v_route_hits,
      'scope_hits', v_scope_hits,
      'site_hits', v_site_hits,
      'blocked_until', v_blocked_until
    );
  end if;

  return jsonb_build_object(
    'allowed', true,
    'blocked', false,
    'retry_after_seconds', 0,
    'block_reason', null,
    'duplicate_hits', v_duplicate_hits,
    'route_hits', v_route_hits,
    'scope_hits', v_scope_hits,
    'site_hits', v_site_hits,
    'blocked_until', null
  );
end;
$$;


-- ============================================================================
-- MIGRATION: 101_flowsecure_server_settings_snapshots.sql
-- ============================================================================

create table if not exists public.guild_settings_secure_snapshots (
  id bigint generated always as identity primary key,
  guild_id text not null,
  module_key text not null,
  payload_encrypted text not null,
  configured_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_settings_secure_snapshots_unique_module unique (guild_id, module_key)
);

create index if not exists idx_guild_settings_secure_snapshots_guild_module_updated_at
on public.guild_settings_secure_snapshots (guild_id, module_key, updated_at desc);

create index if not exists idx_guild_settings_secure_snapshots_configured_by_user_updated_at
on public.guild_settings_secure_snapshots (configured_by_user_id, updated_at desc);

drop trigger if exists tr_guild_settings_secure_snapshots_updated_at on public.guild_settings_secure_snapshots;
create trigger tr_guild_settings_secure_snapshots_updated_at
before update on public.guild_settings_secure_snapshots
for each row
execute function public.set_updated_at();

alter table public.guild_settings_secure_snapshots enable row level security;

drop policy if exists "service_role_all_guild_settings_secure_snapshots" on public.guild_settings_secure_snapshots;
create policy "service_role_all_guild_settings_secure_snapshots"
on public.guild_settings_secure_snapshots
for all
to service_role
using (true)
with check (true);


-- ============================================================================
-- MIGRATION: 102_guild_sales_settings.sql
-- ============================================================================

create table if not exists public.guild_sales_settings (
  id bigint generated always as identity primary key,
  guild_id text not null unique,
  enabled boolean not null default false,
  carts_category_id text null,
  payment_approved_log_channel_id text null,
  payment_pending_log_channel_id text null,
  payment_rejected_log_channel_id text null,
  receipt_company_name text not null default '',
  receipt_company_document text not null default '',
  receipt_support_text text not null default '',
  configured_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_guild_sales_settings_configured_by_user_guild_updated_at
on public.guild_sales_settings (configured_by_user_id, guild_id, updated_at desc);

drop trigger if exists tr_guild_sales_settings_updated_at on public.guild_sales_settings;
create trigger tr_guild_sales_settings_updated_at
before update on public.guild_sales_settings
for each row
execute function public.set_updated_at();

alter table public.guild_sales_settings enable row level security;

drop policy if exists "service_role_all_guild_sales_settings" on public.guild_sales_settings;
create policy "service_role_all_guild_sales_settings"
on public.guild_sales_settings
for all
to service_role
using (true)
with check (true);

comment on table public.guild_sales_settings is 'Configuracoes base do modulo de vendas por servidor.';
comment on column public.guild_sales_settings.carts_category_id is 'Categoria onde os canais de carrinho serao criados.';
comment on column public.guild_sales_settings.payment_approved_log_channel_id is 'Canal de log para pagamentos aprovados.';
comment on column public.guild_sales_settings.payment_pending_log_channel_id is 'Canal de log para pagamentos pendentes.';
comment on column public.guild_sales_settings.payment_rejected_log_channel_id is 'Canal de log para pagamentos recusados.';
comment on column public.guild_sales_settings.receipt_company_name is 'Nome da empresa exibido no comprovante.';


-- ============================================================================
-- MIGRATION: 103_security_definer_execute_hardening.sql
-- ============================================================================

-- Hardening: SECURITY DEFINER functions must not be callable from public API roles.
-- Run once after the functions exist. This script is idempotent and skips missing functions.

do $$
declare
  v_proc regprocedure;
  v_proc_name text;
  v_procs text[] := array[
    'public.apply_user_plan_flow_points_event(bigint,text,numeric,text,text,bigint,jsonb)',
    'public.rls_auto_enable()',
    'public.system_status_acquire_runtime_lease(text,text,integer,jsonb)',
    'public.system_status_claim_outbox_batch(text,integer,integer)',
    'public.system_status_complete_outbox_item(uuid,jsonb)',
    'public.system_status_enqueue_outbox(text,text,uuid,uuid,jsonb)',
    'public.system_status_fail_outbox_item(uuid,text,integer,integer,jsonb)',
    'public.system_status_ingest_check(text,public.system_status_type,integer,text,integer,text,jsonb,timestamptz)',
    'public.system_status_insert_activity(text,text,text,text,jsonb)',
    'public.system_status_record_metric(text,text,numeric,text,timestamptz,integer,jsonb)',
    'public.system_status_release_runtime_lease(text,text)',
    'public.system_status_reconcile_open_incidents()'
  ];
begin
  foreach v_proc_name in array v_procs loop
    v_proc := to_regprocedure(v_proc_name);

    if v_proc is null then
      raise notice 'Skipping missing function: %', v_proc_name;
      continue;
    end if;

    execute format('revoke execute on function %s from public', v_proc);

    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke execute on function %s from anon', v_proc);
    end if;

    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke execute on function %s from authenticated', v_proc);
    end if;

    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', v_proc);
    end if;
  end loop;
end
$$;


-- ============================================================================
-- MIGRATION: 104_auth_password_reset_tokens.sql
-- ============================================================================

create table if not exists public.auth_password_reset_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.auth_users(id) on delete cascade,
  email_normalized text not null,
  token_hash text not null unique,
  ip_address text null,
  user_agent text null,
  attempts integer not null default 0,
  max_attempts integer not null default 8,
  expires_at timestamptz not null,
  consumed_at timestamptz null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_password_reset_tokens_attempts_check
    check (attempts >= 0 and attempts <= 50)
);

create index if not exists idx_auth_password_reset_tokens_user_created_at
on public.auth_password_reset_tokens (user_id, created_at desc);

create index if not exists idx_auth_password_reset_tokens_email_created_at
on public.auth_password_reset_tokens (email_normalized, created_at desc);

create index if not exists idx_auth_password_reset_tokens_active
on public.auth_password_reset_tokens (token_hash, expires_at desc)
where consumed_at is null;

drop trigger if exists tr_auth_password_reset_tokens_updated_at on public.auth_password_reset_tokens;
create trigger tr_auth_password_reset_tokens_updated_at
before update on public.auth_password_reset_tokens
for each row
execute function public.set_updated_at();

alter table public.auth_password_reset_tokens enable row level security;

drop policy if exists "service_role_all_auth_password_reset_tokens" on public.auth_password_reset_tokens;
create policy "service_role_all_auth_password_reset_tokens"
on public.auth_password_reset_tokens
for all
to service_role
using (true)
with check (true);


-- ============================================================================
-- MIGRATION: 105_guild_sales_categories.sql
-- ============================================================================

create table if not exists public.guild_sales_categories (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  title text not null,
  description text not null default '',
  collection_type text not null default 'manual',
  image_url text null,
  theme_model text not null default 'default',
  published_virtual_store boolean not null default true,
  published_point_of_sale boolean not null default false,
  seo_title text not null default '',
  seo_description text not null default '',
  products_count integer not null default 0,
  active boolean not null default true,
  sort_order integer not null default 0,
  configured_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_sales_categories_guild_id_check
    check (guild_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_categories_title_check
    check (char_length(trim(title)) between 2 and 90),
  constraint guild_sales_categories_description_check
    check (char_length(description) <= 1200),
  constraint guild_sales_categories_collection_type_check
    check (collection_type in ('manual', 'smart')),
  constraint guild_sales_categories_theme_model_check
    check (theme_model in ('default', 'compact', 'featured')),
  constraint guild_sales_categories_products_count_check
    check (products_count >= 0)
);

create index if not exists idx_guild_sales_categories_guild_sort
on public.guild_sales_categories (guild_id, active desc, sort_order asc, created_at desc);

create index if not exists idx_guild_sales_categories_configured_by_user
on public.guild_sales_categories (configured_by_user_id, guild_id, updated_at desc);

drop trigger if exists tr_guild_sales_categories_updated_at on public.guild_sales_categories;
create trigger tr_guild_sales_categories_updated_at
before update on public.guild_sales_categories
for each row
execute function public.set_updated_at();

alter table public.guild_sales_categories enable row level security;

drop policy if exists "service_role_all_guild_sales_categories" on public.guild_sales_categories;
create policy "service_role_all_guild_sales_categories"
on public.guild_sales_categories
for all
to service_role
using (true)
with check (true);

comment on table public.guild_sales_categories is 'Categorias/colecoes de vendas por servidor, prontas para Discord e futura vitrine web.';
comment on column public.guild_sales_categories.collection_type is 'manual: produtos escolhidos um a um; smart: futura regra automatica.';
comment on column public.guild_sales_categories.published_virtual_store is 'Define se a categoria aparece na futura loja web.';
comment on column public.guild_sales_categories.published_point_of_sale is 'Define se a categoria aparece em canais de venda assistidos.';


-- ============================================================================
-- MIGRATION: 106_dashboard_performance_indexes.sql
-- ============================================================================

-- Performance: indices for the hottest dashboard/account reads.
-- Safe to run more than once. Missing optional tables are skipped.

do $$
begin
  if to_regclass('public.auth_user_team_servers') is not null then
    create index if not exists idx_auth_user_team_servers_guild_team
    on public.auth_user_team_servers (guild_id, team_id);
  end if;

  if to_regclass('public.auth_user_team_members') is not null then
    create index if not exists idx_auth_user_team_members_user_status
    on public.auth_user_team_members (invited_auth_user_id, status, team_id);

    if exists (
      select 1
        from information_schema.columns
       where table_schema = 'public'
         and table_name = 'auth_user_team_members'
         and column_name = 'invited_discord_user_id'
    ) then
      create index if not exists idx_auth_user_team_members_discord_status
      on public.auth_user_team_members (invited_discord_user_id, status, team_id);
    elsif exists (
      select 1
        from information_schema.columns
       where table_schema = 'public'
         and table_name = 'auth_user_team_members'
         and column_name = 'discord_user_id'
    ) then
      create index if not exists idx_auth_user_team_members_discord_status
      on public.auth_user_team_members (discord_user_id, status, team_id);
    end if;

    create index if not exists idx_auth_user_team_members_team_status
    on public.auth_user_team_members (team_id, status, created_at desc);
  end if;

  if to_regclass('public.auth_user_teams') is not null then
    create index if not exists idx_auth_user_teams_owner_updated
    on public.auth_user_teams (owner_user_id, updated_at desc);
  end if;

  if to_regclass('public.user_plan_guilds') is not null then
    create index if not exists idx_user_plan_guilds_user_active_guild
    on public.user_plan_guilds (user_id, is_active, guild_id);

    create index if not exists idx_user_plan_guilds_guild_active
    on public.user_plan_guilds (guild_id, is_active);
  end if;

  if to_regclass('public.guild_settings_secure_snapshots') is not null then
    create index if not exists idx_guild_settings_secure_snapshots_user_guild_module
    on public.guild_settings_secure_snapshots (configured_by_user_id, guild_id, module_key, updated_at desc);
  end if;

  if to_regclass('public.guild_ticket_settings') is not null then
    create index if not exists idx_guild_ticket_settings_user_guild
    on public.guild_ticket_settings (configured_by_user_id, guild_id, updated_at desc);
  end if;

  if to_regclass('public.guild_ticket_staff_settings') is not null then
    create index if not exists idx_guild_ticket_staff_settings_user_guild
    on public.guild_ticket_staff_settings (configured_by_user_id, guild_id, updated_at desc);
  end if;

  if to_regclass('public.guild_welcome_settings') is not null then
    create index if not exists idx_guild_welcome_settings_user_guild
    on public.guild_welcome_settings (configured_by_user_id, guild_id, updated_at desc);
  end if;

  if to_regclass('public.guild_antilink_settings') is not null then
    create index if not exists idx_guild_antilink_settings_user_guild
    on public.guild_antilink_settings (configured_by_user_id, guild_id, updated_at desc);
  end if;

  if to_regclass('public.guild_autorole_settings') is not null then
    create index if not exists idx_guild_autorole_settings_user_guild
    on public.guild_autorole_settings (configured_by_user_id, guild_id, updated_at desc);
  end if;

  if to_regclass('public.guild_security_logs_settings') is not null then
    create index if not exists idx_guild_security_logs_settings_user_guild
    on public.guild_security_logs_settings (configured_by_user_id, guild_id, updated_at desc);
  end if;

  if to_regclass('public.payment_orders') is not null then
    create index if not exists idx_payment_orders_user_status_created
    on public.payment_orders (user_id, status, created_at desc);
  end if;

  if to_regclass('public.payment_methods') is not null then
    create index if not exists idx_payment_methods_user_status_updated
    on public.payment_methods (user_id, status, updated_at desc);
  end if;
end
$$;


-- ============================================================================
-- MIGRATION: 107_guild_sales_products.sql
-- ============================================================================

create table if not exists public.guild_sales_products (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  title text not null,
  description text not null default '',
  category_id uuid null references public.guild_sales_categories(id) on delete set null,
  status text not null default 'active',
  media_urls jsonb not null default '[]'::jsonb,
  price_amount numeric(12,2) not null default 0,
  compare_at_price_amount numeric(12,2) null,
  unit_price_amount numeric(12,2) null,
  charge_taxes boolean not null default true,
  cost_per_item_amount numeric(12,2) null,
  inventory_tracked boolean not null default true,
  stock_quantity integer not null default 0,
  sku text not null default '',
  barcode text not null default '',
  barcode_mode text not null default 'auto',
  product_type text not null default '',
  manufacturer text not null default '',
  tags text[] not null default '{}',
  theme_model text not null default 'default',
  published_virtual_store boolean not null default true,
  published_point_of_sale boolean not null default true,
  published_pinterest boolean not null default false,
  active boolean not null default true,
  configured_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_sales_products_guild_id_check
    check (guild_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_products_title_check
    check (char_length(trim(title)) between 2 and 120),
  constraint guild_sales_products_description_check
    check (char_length(description) <= 1800),
  constraint guild_sales_products_status_check
    check (status in ('active', 'draft', 'archived')),
  constraint guild_sales_products_theme_model_check
    check (theme_model in ('default', 'compact', 'featured')),
  constraint guild_sales_products_barcode_mode_check
    check (barcode_mode in ('auto', 'manual')),
  constraint guild_sales_products_price_check
    check (price_amount >= 0 and coalesce(compare_at_price_amount, 0) >= 0 and coalesce(unit_price_amount, 0) >= 0 and coalesce(cost_per_item_amount, 0) >= 0),
  constraint guild_sales_products_stock_check
    check (stock_quantity >= 0)
);

create index if not exists idx_guild_sales_products_guild_status_created
on public.guild_sales_products (guild_id, status, created_at desc);

create index if not exists idx_guild_sales_products_category_created
on public.guild_sales_products (category_id, created_at desc)
where category_id is not null;

create index if not exists idx_guild_sales_products_configured_by_user
on public.guild_sales_products (configured_by_user_id, guild_id, updated_at desc);

drop trigger if exists tr_guild_sales_products_updated_at on public.guild_sales_products;
create trigger tr_guild_sales_products_updated_at
before update on public.guild_sales_products
for each row
execute function public.set_updated_at();

alter table public.guild_sales_products enable row level security;

drop policy if exists "service_role_all_guild_sales_products" on public.guild_sales_products;
create policy "service_role_all_guild_sales_products"
on public.guild_sales_products
for all
to service_role
using (true)
with check (true);

comment on table public.guild_sales_products is 'Produtos de vendas por servidor, prontos para Discord e futura vitrine web.';
comment on column public.guild_sales_products.sku is 'Codigo interno do produto. Pode ser gerado automaticamente pelo painel e editado manualmente.';
comment on column public.guild_sales_products.barcode is 'Codigo de barras do produto. Pode ser automatico ou preenchido manualmente.';


-- ============================================================================
-- MIGRATION: 108_admin_bootstrap_security_hardening.sql
-- ============================================================================

-- Hardening: admin bootstrap functions must not be exposed through public API roles.
-- Run once after the functions exist. This script is idempotent and skips missing functions.

do $$
declare
  v_guard_proc regprocedure;
  v_bootstrap_proc regprocedure;
begin
  v_guard_proc := to_regprocedure('public.flowdesk_guard_singleton_admin_role()');

  if v_guard_proc is null then
    raise notice 'Skipping missing function: public.flowdesk_guard_singleton_admin_role()';
  else
    execute format('alter function %s set search_path = pg_catalog, public', v_guard_proc);
  end if;

  v_bootstrap_proc := to_regprocedure('public.flowdesk_bootstrap_admin(text)');

  if v_bootstrap_proc is null then
    raise notice 'Skipping missing function: public.flowdesk_bootstrap_admin(text)';
  else
    execute format('alter function %s set search_path = pg_catalog, public', v_bootstrap_proc);
    execute format('revoke execute on function %s from public', v_bootstrap_proc);

    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke execute on function %s from anon', v_bootstrap_proc);
    end if;

    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke execute on function %s from authenticated', v_bootstrap_proc);
    end if;

    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', v_bootstrap_proc);
    end if;
  end if;
end
$$;


-- ============================================================================
-- MIGRATION: 109_admin_tables_rls_policy_hardening.sql
-- ============================================================================

-- Hardening: admin tables with RLS enabled must have explicit policies.
-- These tables are sensitive, so only service_role receives direct table access.
-- Run once after the admin tables exist. This script is idempotent and skips missing tables.

do $$
declare
  v_table regclass;
  v_table_name text;
  v_policy_name text;
  v_tables text[] := array[
    'public.admin_action_approvals',
    'public.admin_audit_logs',
    'public.admin_permissions',
    'public.admin_role_permissions',
    'public.admin_roles'
  ];
begin
  foreach v_table_name in array v_tables loop
    v_table := to_regclass(v_table_name);

    if v_table is null then
      raise notice 'Skipping missing table: %', v_table_name;
      continue;
    end if;

    v_policy_name := 'service_role_all_' || replace(split_part(v_table_name, '.', 2), '.', '_');

    execute format('alter table %s enable row level security', v_table);
    execute format('drop policy if exists %I on %s', v_policy_name, v_table);

    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format(
        'create policy %I on %s for all to service_role using (true) with check (true)',
        v_policy_name,
        v_table
      );
    else
      raise notice 'Role service_role not found; policy not created for %', v_table_name;
    end if;
  end loop;
end
$$;


-- ============================================================================
-- MIGRATION: 110_test_variables_rls_policy_hardening.sql
-- ============================================================================

-- Hardening: test variable tables with RLS enabled must have explicit policies.
-- These tables can contain sensitive runtime/test values, so only service_role receives direct table access.
-- Run once after the tables exist. This script is idempotent and skips missing tables.

do $$
declare
  v_table regclass;
  v_table_name text;
  v_policy_name text;
  v_tables text[] := array[
    'public.test_variables',
    'public.test_variable_read_logs',
    'public.test_variable_projects',
    'public.test_variable_groups'
  ];
begin
  foreach v_table_name in array v_tables loop
    v_table := to_regclass(v_table_name);

    if v_table is null then
      raise notice 'Skipping missing table: %', v_table_name;
      continue;
    end if;

    v_policy_name := 'service_role_all_' || split_part(v_table_name, '.', 2);

    execute format('alter table %s enable row level security', v_table);
    execute format('drop policy if exists %I on %s', v_policy_name, v_table);

    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format(
        'create policy %I on %s for all to service_role using (true) with check (true)',
        v_policy_name,
        v_table
      );
    else
      raise notice 'Role service_role not found; policy not created for %', v_table_name;
    end if;
  end loop;
end
$$;


-- ============================================================================
-- MIGRATION: 111_admin_dev_tables_rls_policy_hardening.sql
-- ============================================================================

-- Hardening: admin/dev/test tables with RLS enabled must have explicit policies.
-- These tables contain sessions, tokens, staff data or access logs, so only service_role receives direct table access.
-- Run once after the tables exist. This script is idempotent and skips missing tables.

do $$
declare
  v_table regclass;
  v_table_name text;
  v_policy_name text;
  v_tables text[] := array[
    'public.admin_sessions',
    'public.admin_staff_profiles',
    'public.admin_staff_role_assignments',
    'public.dev_auth_tokens',
    'public.dev_certificates',
    'public.dev_ip_allowlist',
    'public.test_variable_access_grants',
    'public.dev_login_attempts',
    'public.dev_ip_requests'
  ];
begin
  foreach v_table_name in array v_tables loop
    v_table := to_regclass(v_table_name);

    if v_table is null then
      raise notice 'Skipping missing table: %', v_table_name;
      continue;
    end if;

    v_policy_name := 'service_role_all_' || split_part(v_table_name, '.', 2);

    execute format('alter table %s enable row level security', v_table);
    execute format('drop policy if exists %I on %s', v_policy_name, v_table);

    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format(
        'create policy %I on %s for all to service_role using (true) with check (true)',
        v_policy_name,
        v_table
      );
    else
      raise notice 'Role service_role not found; policy not created for %', v_table_name;
    end if;
  end loop;
end
$$;


-- ============================================================================
-- MIGRATION: 112_admin_runtime_compatibility_fixes.sql
-- ============================================================================

-- Runtime compatibility fixes for admin dashboard.
-- Safe to run more than once.

do $$
begin
  if to_regtype('public.ticket_status') is not null then
    alter type public.ticket_status add value if not exists 'pending';
    alter type public.ticket_status add value if not exists 'review';
    alter type public.ticket_status add value if not exists 'resolved';
  else
    raise notice 'Skipping missing enum: public.ticket_status';
  end if;

  if to_regclass('public.tickets') is not null then
    alter table public.tickets
      add column if not exists opened_reason text not null default '';
  else
    raise notice 'Skipping missing table: public.tickets';
  end if;

  if to_regclass('public.guild_sales_products') is not null then
    alter table public.guild_sales_products
      add column if not exists discord_publication_mode text not null default 'online_only',
      add column if not exists discord_channel_id text null,
      add column if not exists discord_message_id text null,
      add column if not exists discord_last_synced_at timestamptz null,
      add column if not exists discord_sync_status text not null default 'idle',
      add column if not exists discord_sync_error text null;

    if not exists (
      select 1
      from pg_constraint
      where conname = 'guild_sales_products_discord_publication_mode_check'
        and conrelid = 'public.guild_sales_products'::regclass
    ) then
      alter table public.guild_sales_products
        add constraint guild_sales_products_discord_publication_mode_check
        check (discord_publication_mode in ('online_only', 'channel'));
    end if;

    if not exists (
      select 1
      from pg_constraint
      where conname = 'guild_sales_products_discord_channel_id_check'
        and conrelid = 'public.guild_sales_products'::regclass
    ) then
      alter table public.guild_sales_products
        add constraint guild_sales_products_discord_channel_id_check
        check (discord_channel_id is null or discord_channel_id ~ '^[0-9]{10,25}$');
    end if;

    if not exists (
      select 1
      from pg_constraint
      where conname = 'guild_sales_products_discord_message_id_check'
        and conrelid = 'public.guild_sales_products'::regclass
    ) then
      alter table public.guild_sales_products
        add constraint guild_sales_products_discord_message_id_check
        check (discord_message_id is null or discord_message_id ~ '^[0-9]{10,25}$');
    end if;

    if not exists (
      select 1
      from pg_constraint
      where conname = 'guild_sales_products_discord_sync_status_check'
        and conrelid = 'public.guild_sales_products'::regclass
    ) then
      alter table public.guild_sales_products
        add constraint guild_sales_products_discord_sync_status_check
        check (discord_sync_status in ('idle', 'synced', 'failed'));
    end if;

    create index if not exists idx_guild_sales_products_discord_channel
      on public.guild_sales_products (guild_id, discord_channel_id)
      where discord_channel_id is not null;
  else
    raise notice 'Skipping missing table: public.guild_sales_products';
  end if;

  if to_regclass('public.guild_sales_categories') is not null then
    alter table public.guild_sales_categories
      add column if not exists discord_publication_mode text not null default 'online_only',
      add column if not exists discord_channel_id text null;

    if not exists (
      select 1
      from pg_constraint
      where conname = 'guild_sales_categories_discord_publication_mode_check'
        and conrelid = 'public.guild_sales_categories'::regclass
    ) then
      alter table public.guild_sales_categories
        add constraint guild_sales_categories_discord_publication_mode_check
        check (discord_publication_mode in ('online_only', 'channel'));
    end if;

    if not exists (
      select 1
      from pg_constraint
      where conname = 'guild_sales_categories_discord_channel_id_check'
        and conrelid = 'public.guild_sales_categories'::regclass
    ) then
      alter table public.guild_sales_categories
        add constraint guild_sales_categories_discord_channel_id_check
        check (discord_channel_id is null or discord_channel_id ~ '^[0-9]{10,25}$');
    end if;

    create index if not exists idx_guild_sales_categories_discord_channel
      on public.guild_sales_categories (guild_id, discord_channel_id)
      where discord_channel_id is not null;
  else
    raise notice 'Skipping missing table: public.guild_sales_categories';
  end if;

  if to_regclass('public.admin_sessions') is not null then
    create unique index if not exists admin_sessions_auth_session_id_key
      on public.admin_sessions (auth_session_id);
  else
    raise notice 'Skipping missing table: public.admin_sessions';
  end if;
end
$$;


-- ============================================================================
-- MIGRATION: 113_guild_sales_product_discord_publication.sql
-- ============================================================================

-- Discord publication fields for sales products.
-- Safe to run more than once.

do $$
begin
  if to_regclass('public.guild_sales_products') is not null then
    alter table public.guild_sales_products
      add column if not exists discord_publication_mode text not null default 'online_only',
      add column if not exists discord_channel_id text null,
      add column if not exists discord_message_id text null,
      add column if not exists discord_last_synced_at timestamptz null,
      add column if not exists discord_sync_status text not null default 'idle',
      add column if not exists discord_sync_error text null;

    if not exists (
      select 1
      from pg_constraint
      where conname = 'guild_sales_products_discord_publication_mode_check'
        and conrelid = 'public.guild_sales_products'::regclass
    ) then
      alter table public.guild_sales_products
        add constraint guild_sales_products_discord_publication_mode_check
        check (discord_publication_mode in ('online_only', 'channel'));
    end if;

    if not exists (
      select 1
      from pg_constraint
      where conname = 'guild_sales_products_discord_channel_id_check'
        and conrelid = 'public.guild_sales_products'::regclass
    ) then
      alter table public.guild_sales_products
        add constraint guild_sales_products_discord_channel_id_check
        check (discord_channel_id is null or discord_channel_id ~ '^[0-9]{10,25}$');
    end if;

    if not exists (
      select 1
      from pg_constraint
      where conname = 'guild_sales_products_discord_message_id_check'
        and conrelid = 'public.guild_sales_products'::regclass
    ) then
      alter table public.guild_sales_products
        add constraint guild_sales_products_discord_message_id_check
        check (discord_message_id is null or discord_message_id ~ '^[0-9]{10,25}$');
    end if;

    if not exists (
      select 1
      from pg_constraint
      where conname = 'guild_sales_products_discord_sync_status_check'
        and conrelid = 'public.guild_sales_products'::regclass
    ) then
      alter table public.guild_sales_products
        add constraint guild_sales_products_discord_sync_status_check
        check (discord_sync_status in ('idle', 'synced', 'failed'));
    end if;

    create index if not exists idx_guild_sales_products_discord_channel
      on public.guild_sales_products (guild_id, discord_channel_id)
      where discord_channel_id is not null;
  else
    raise notice 'Skipping missing table: public.guild_sales_products';
  end if;

  if to_regclass('public.guild_sales_categories') is not null then
    alter table public.guild_sales_categories
      add column if not exists discord_publication_mode text not null default 'online_only',
      add column if not exists discord_channel_id text null;

    if not exists (
      select 1
      from pg_constraint
      where conname = 'guild_sales_categories_discord_publication_mode_check'
        and conrelid = 'public.guild_sales_categories'::regclass
    ) then
      alter table public.guild_sales_categories
        add constraint guild_sales_categories_discord_publication_mode_check
        check (discord_publication_mode in ('online_only', 'channel'));
    end if;

    if not exists (
      select 1
      from pg_constraint
      where conname = 'guild_sales_categories_discord_channel_id_check'
        and conrelid = 'public.guild_sales_categories'::regclass
    ) then
      alter table public.guild_sales_categories
        add constraint guild_sales_categories_discord_channel_id_check
        check (discord_channel_id is null or discord_channel_id ~ '^[0-9]{10,25}$');
    end if;

    create index if not exists idx_guild_sales_categories_discord_channel
      on public.guild_sales_categories (guild_id, discord_channel_id)
      where discord_channel_id is not null;
  else
    raise notice 'Skipping missing table: public.guild_sales_categories';
  end if;
end
$$;


-- ============================================================================
-- MIGRATION: 114_guild_sales_stock_items.sql
-- ============================================================================

-- Digital stock items and delivery metadata for sales products.
-- Safe to run more than once.

create table if not exists public.guild_sales_stock_items (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  product_id uuid not null references public.guild_sales_products(id) on delete cascade,
  product_name text not null default '',
  item_type text not null default 'digital_services',
  delivery_method text not null default 'flowdesk_link',
  status text not null default 'available',
  category text not null default '',
  platform text not null default '',
  provider text not null default '',
  email text not null default '',
  login text not null default '',
  password text not null default '',
  access_type text not null default '',
  recovery text not null default '',
  gift_card_name text not null default '',
  redemption_value text not null default '',
  redemption_code text not null default '',
  access_link text not null default '',
  link_password text not null default '',
  region text not null default '',
  validity text not null default '',
  quantity integer not null default 1,
  server text not null default '',
  buyer_required_id text not null default '',
  delivery_deadline text not null default '',
  service_type text not null default '',
  required_buyer_info text not null default '',
  discord_product_type text not null default '',
  server_or_bot_link text not null default '',
  token_or_key text not null default '',
  required_permissions text not null default '',
  tool_name text not null default '',
  automation_type text not null default '',
  software_name text not null default '',
  software_version text not null default '',
  operating_system text not null default '',
  license_key text not null default '',
  download_link text not null default '',
  subscription_duration text not null default '',
  account_type text not null default '',
  course_name text not null default '',
  item_name text not null default '',
  instructions text not null default '',
  observations text not null default '',
  payload jsonb not null default '{}'::jsonb,
  configured_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_sales_stock_items_guild_id_check
    check (guild_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_stock_items_delivery_method_check
    check (delivery_method in ('email', 'discord_dm', 'flowdesk_link')),
  constraint guild_sales_stock_items_status_check
    check (status in ('available', 'reserved', 'delivered', 'disabled')),
  constraint guild_sales_stock_items_quantity_check
    check (quantity >= 0),
  constraint guild_sales_stock_items_item_type_check
    check (item_type in (
      'accounts_access',
      'emails',
      'gift_cards_codes',
      'virtual_currency',
      'game_items',
      'game_services',
      'premium_subscriptions',
      'artificial_intelligence',
      'discord_bots',
      'social_networks',
      'software_licenses',
      'courses_training',
      'digital_links',
      'digital_services',
      'freelancer',
      'other'
    ))
);

create index if not exists idx_guild_sales_stock_items_product_status
on public.guild_sales_stock_items (guild_id, product_id, status, created_at desc);

create index if not exists idx_guild_sales_stock_items_product_delivery
on public.guild_sales_stock_items (product_id, delivery_method, item_type);

drop trigger if exists tr_guild_sales_stock_items_updated_at on public.guild_sales_stock_items;
create trigger tr_guild_sales_stock_items_updated_at
before update on public.guild_sales_stock_items
for each row
execute function public.set_updated_at();

alter table public.guild_sales_stock_items enable row level security;

drop policy if exists "service_role_all_guild_sales_stock_items" on public.guild_sales_stock_items;
create policy "service_role_all_guild_sales_stock_items"
on public.guild_sales_stock_items
for all
to service_role
using (true)
with check (true);

comment on table public.guild_sales_stock_items is 'Estoque digital por produto com campos separados para entrega automatica.';


-- ============================================================================
-- MIGRATION: 115_guild_sales_checkout_payments.sql
-- ============================================================================

-- Sales payment methods, Discord carts, checkout links and delivery records.
-- Safe to run more than once.

create table if not exists public.guild_sales_payment_methods (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  method_key text not null,
  provider text not null default '',
  payment_rail text not null default '',
  display_name text not null,
  status text not null default 'disabled',
  credentials_configured boolean not null default false,
  environment text not null default 'production',
  public_key_fingerprint text not null default '',
  access_token_fingerprint text not null default '',
  last_health_status text not null default 'unchecked',
  last_health_error text not null default '',
  configured_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_sales_payment_methods_unique_method unique (guild_id, method_key),
  constraint guild_sales_payment_methods_guild_id_check
    check (guild_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_payment_methods_method_key_check
    check (method_key in ('mercado_pago', 'flowpay', 'card', 'boleto', 'paypal', 'nupay')),
  constraint guild_sales_payment_methods_provider_check
    check (provider in ('', 'mercado_pago', 'flowpay', 'stripe', 'paypal', 'nupay')),
  constraint guild_sales_payment_methods_payment_rail_check
    check (payment_rail in ('', 'pix', 'card', 'boleto', 'wallet')),
  constraint guild_sales_payment_methods_status_check
    check (status in ('active', 'disabled')),
  constraint guild_sales_payment_methods_environment_check
    check (environment in ('production', 'test')),
  constraint guild_sales_payment_methods_health_check
    check (last_health_status in ('unchecked', 'ok', 'failed'))
);

create index if not exists idx_guild_sales_payment_methods_guild_status
on public.guild_sales_payment_methods (guild_id, status, method_key);

drop trigger if exists tr_guild_sales_payment_methods_updated_at on public.guild_sales_payment_methods;
create trigger tr_guild_sales_payment_methods_updated_at
before update on public.guild_sales_payment_methods
for each row
execute function public.set_updated_at();

alter table public.guild_sales_payment_methods enable row level security;

drop policy if exists "service_role_all_guild_sales_payment_methods" on public.guild_sales_payment_methods;
create policy "service_role_all_guild_sales_payment_methods"
on public.guild_sales_payment_methods
for all
to service_role
using (true)
with check (true);

create table if not exists public.guild_sales_carts (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  discord_user_id text not null,
  discord_channel_id text null,
  auth_user_id bigint null references public.auth_users(id) on delete set null,
  status text not null default 'link_required',
  currency text not null default 'BRL',
  subtotal_amount numeric(12,2) not null default 0,
  total_amount numeric(12,2) not null default 0,
  selected_payment_method_key text null,
  provider text null,
  provider_payment_id text null,
  provider_external_reference text null,
  provider_status text null,
  provider_status_detail text null,
  provider_qr_code text null,
  provider_qr_base64 text null,
  provider_ticket_url text null,
  provider_payload jsonb not null default '{}'::jsonb,
  payment_expires_at timestamptz null,
  paid_at timestamptz null,
  delivered_at timestamptz null,
  cancelled_at timestamptz null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_sales_carts_guild_id_check
    check (guild_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_carts_discord_user_id_check
    check (discord_user_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_carts_discord_channel_id_check
    check (discord_channel_id is null or discord_channel_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_carts_status_check
    check (status in ('link_required', 'open', 'payment_pending', 'paid', 'delivered', 'delivery_failed', 'rejected', 'cancelled', 'expired')),
  constraint guild_sales_carts_currency_check
    check (currency ~ '^[A-Z]{3}$'),
  constraint guild_sales_carts_amount_check
    check (subtotal_amount >= 0 and total_amount >= 0),
  constraint guild_sales_carts_selected_method_check
    check (selected_payment_method_key is null or selected_payment_method_key in ('mercado_pago', 'flowpay', 'card', 'boleto', 'paypal', 'nupay'))
);

create index if not exists idx_guild_sales_carts_guild_user_status
on public.guild_sales_carts (guild_id, discord_user_id, status, created_at desc);

create index if not exists idx_guild_sales_carts_channel
on public.guild_sales_carts (guild_id, discord_channel_id)
where discord_channel_id is not null;

create unique index if not exists idx_guild_sales_carts_provider_payment_unique
on public.guild_sales_carts (provider, provider_payment_id)
where provider_payment_id is not null;

create unique index if not exists idx_guild_sales_carts_provider_external_ref_unique
on public.guild_sales_carts (provider_external_reference)
where provider_external_reference is not null;

drop trigger if exists tr_guild_sales_carts_updated_at on public.guild_sales_carts;
create trigger tr_guild_sales_carts_updated_at
before update on public.guild_sales_carts
for each row
execute function public.set_updated_at();

alter table public.guild_sales_carts enable row level security;

drop policy if exists "service_role_all_guild_sales_carts" on public.guild_sales_carts;
create policy "service_role_all_guild_sales_carts"
on public.guild_sales_carts
for all
to service_role
using (true)
with check (true);

create table if not exists public.guild_sales_cart_items (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null references public.guild_sales_carts(id) on delete cascade,
  guild_id text not null,
  product_id uuid not null references public.guild_sales_products(id) on delete restrict,
  quantity integer not null default 1,
  unit_price_amount numeric(12,2) not null default 0,
  total_amount numeric(12,2) not null default 0,
  product_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_sales_cart_items_unique_product unique (cart_id, product_id),
  constraint guild_sales_cart_items_guild_id_check
    check (guild_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_cart_items_quantity_check
    check (quantity between 1 and 999),
  constraint guild_sales_cart_items_amount_check
    check (unit_price_amount >= 0 and total_amount >= 0)
);

create index if not exists idx_guild_sales_cart_items_cart
on public.guild_sales_cart_items (cart_id, created_at asc);

drop trigger if exists tr_guild_sales_cart_items_updated_at on public.guild_sales_cart_items;
create trigger tr_guild_sales_cart_items_updated_at
before update on public.guild_sales_cart_items
for each row
execute function public.set_updated_at();

alter table public.guild_sales_cart_items enable row level security;

drop policy if exists "service_role_all_guild_sales_cart_items" on public.guild_sales_cart_items;
create policy "service_role_all_guild_sales_cart_items"
on public.guild_sales_cart_items
for all
to service_role
using (true)
with check (true);

create table if not exists public.guild_sales_checkout_links (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null references public.guild_sales_carts(id) on delete cascade,
  guild_id text not null,
  discord_user_id text not null,
  token_hash text not null unique,
  status text not null default 'pending',
  auth_user_id bigint null references public.auth_users(id) on delete set null,
  expires_at timestamptz not null,
  confirmed_at timestamptz null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_sales_checkout_links_guild_id_check
    check (guild_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_checkout_links_discord_user_id_check
    check (discord_user_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_checkout_links_status_check
    check (status in ('pending', 'confirmed', 'expired', 'revoked'))
);

create index if not exists idx_guild_sales_checkout_links_cart_status
on public.guild_sales_checkout_links (cart_id, status, created_at desc);

drop trigger if exists tr_guild_sales_checkout_links_updated_at on public.guild_sales_checkout_links;
create trigger tr_guild_sales_checkout_links_updated_at
before update on public.guild_sales_checkout_links
for each row
execute function public.set_updated_at();

alter table public.guild_sales_checkout_links enable row level security;

drop policy if exists "service_role_all_guild_sales_checkout_links" on public.guild_sales_checkout_links;
create policy "service_role_all_guild_sales_checkout_links"
on public.guild_sales_checkout_links
for all
to service_role
using (true)
with check (true);

create table if not exists public.guild_sales_order_deliveries (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null references public.guild_sales_carts(id) on delete cascade,
  guild_id text not null,
  auth_user_id bigint not null references public.auth_users(id) on delete cascade,
  discord_user_id text not null,
  product_id uuid not null references public.guild_sales_products(id) on delete restrict,
  stock_item_id uuid null references public.guild_sales_stock_items(id) on delete set null,
  delivery_method text not null,
  status text not null default 'delivered',
  delivery_payload jsonb not null default '{}'::jsonb,
  delivered_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  constraint guild_sales_order_deliveries_guild_id_check
    check (guild_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_order_deliveries_discord_user_id_check
    check (discord_user_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_order_deliveries_delivery_method_check
    check (delivery_method in ('email', 'discord_dm', 'flowdesk_link')),
  constraint guild_sales_order_deliveries_status_check
    check (status in ('delivered', 'failed'))
);

create index if not exists idx_guild_sales_order_deliveries_cart
on public.guild_sales_order_deliveries (cart_id, created_at asc);

create index if not exists idx_guild_sales_order_deliveries_auth_user
on public.guild_sales_order_deliveries (auth_user_id, created_at desc);

alter table public.guild_sales_order_deliveries enable row level security;

drop policy if exists "service_role_all_guild_sales_order_deliveries" on public.guild_sales_order_deliveries;
create policy "service_role_all_guild_sales_order_deliveries"
on public.guild_sales_order_deliveries
for all
to service_role
using (true)
with check (true);

comment on table public.guild_sales_payment_methods is 'Metodos de pagamento por servidor; segredos ficam no cofre cifrado guild_settings_secure_snapshots.';
comment on table public.guild_sales_carts is 'Carrinhos de vendas criados pelo bot Discord e conciliados pelo site.';
comment on table public.guild_sales_checkout_links is 'Tokens efemeros para confirmar que a compra do Discord pertence a uma conta autenticada Flowdesk.';
comment on table public.guild_sales_order_deliveries is 'Entregas liberadas apos pagamento aprovado, visiveis ao comprador autenticado.';


-- ============================================================================
-- MIGRATION: 116_guild_sales_checkout_hardening.sql
-- ============================================================================

-- Hardening for Discord sales checkout, stock claiming, order events and receipts.
-- Safe to run more than once.

alter table public.guild_sales_carts
add column if not exists customer_email text null,
add column if not exists customer_name text null,
add column if not exists delivery_started_at timestamptz null,
add column if not exists delivery_lock_error text not null default '',
add column if not exists receipt_email_sent_at timestamptz null,
add column if not exists receipt_email_error text not null default '',
add column if not exists discord_notification_sent_at timestamptz null,
add column if not exists discord_notification_error text not null default '';

create index if not exists idx_guild_sales_carts_receipt_pending
on public.guild_sales_carts (status, paid_at)
where receipt_email_sent_at is null;

create index if not exists idx_guild_sales_carts_delivery_pending
on public.guild_sales_carts (status, paid_at)
where delivery_started_at is null;

with ranked_open_carts as (
  select
    id,
    row_number() over (
      partition by guild_id, discord_user_id
      order by created_at desc, id desc
    ) as rn
  from public.guild_sales_carts
  where status in ('link_required', 'open')
)
update public.guild_sales_carts cart
set
  status = 'cancelled',
  cancelled_at = coalesce(cart.cancelled_at, timezone('utc', now()))
from ranked_open_carts ranked
where cart.id = ranked.id
  and ranked.rn > 1;

create unique index if not exists idx_guild_sales_carts_one_open_per_user
on public.guild_sales_carts (guild_id, discord_user_id)
where status in ('link_required', 'open');

alter table public.guild_sales_order_deliveries
add column if not exists cart_item_id uuid null references public.guild_sales_cart_items(id) on delete set null,
add column if not exists unit_index integer null,
add column if not exists idempotency_key text not null default '';

create unique index if not exists idx_guild_sales_order_deliveries_idempotency
on public.guild_sales_order_deliveries (idempotency_key)
where idempotency_key <> '';

create table if not exists public.guild_sales_order_events (
  id bigint generated always as identity primary key,
  cart_id uuid not null references public.guild_sales_carts(id) on delete cascade,
  guild_id text not null,
  auth_user_id bigint null references public.auth_users(id) on delete set null,
  discord_user_id text not null,
  event_type text not null,
  event_key text not null default '',
  event_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  constraint guild_sales_order_events_guild_id_check
    check (guild_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_order_events_discord_user_id_check
    check (discord_user_id ~ '^[0-9]{10,25}$')
);

create index if not exists idx_guild_sales_order_events_cart_created
on public.guild_sales_order_events (cart_id, created_at desc);

create index if not exists idx_guild_sales_order_events_guild_created
on public.guild_sales_order_events (guild_id, created_at desc);

create unique index if not exists idx_guild_sales_order_events_cart_event_key
on public.guild_sales_order_events (cart_id, event_key)
where event_key <> '';

alter table public.guild_sales_order_events enable row level security;

drop policy if exists "service_role_all_guild_sales_order_events" on public.guild_sales_order_events;
create policy "service_role_all_guild_sales_order_events"
on public.guild_sales_order_events
for all
to service_role
using (true)
with check (true);

create or replace function public.claim_guild_sales_stock_item(
  p_guild_id text,
  p_product_id uuid,
  p_preferred_delivery_method text default null
)
returns setof public.guild_sales_stock_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.guild_sales_stock_items%rowtype;
begin
  if p_preferred_delivery_method is not null
    and p_preferred_delivery_method not in ('email', 'discord_dm', 'flowdesk_link')
  then
    raise exception 'Metodo de entrega invalido.';
  end if;

  select *
  into v_item
  from public.guild_sales_stock_items
  where guild_id = p_guild_id
    and product_id = p_product_id
    and status = 'available'
    and quantity > 0
    and (
      p_preferred_delivery_method is null
      or delivery_method = p_preferred_delivery_method
    )
  order by created_at asc
  for update skip locked
  limit 1;

  if not found then
    return;
  end if;

  update public.guild_sales_stock_items
  set
    quantity = greatest(0, v_item.quantity - 1),
    status = case when v_item.quantity - 1 > 0 then 'available' else 'delivered' end
  where id = v_item.id;

  update public.guild_sales_products
  set stock_quantity = coalesce(
    (
      select sum(gssi.quantity)::integer
      from public.guild_sales_stock_items gssi
      where gssi.guild_id = p_guild_id
        and gssi.product_id = p_product_id
        and gssi.status = 'available'
    ),
    0
  )
  where guild_id = p_guild_id
    and id = p_product_id;

  return next v_item;
end;
$$;

create or replace function public.sync_guild_sales_product_stock_quantity(
  p_guild_id text,
  p_product_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quantity integer;
begin
  select coalesce(sum(gssi.quantity), 0)::integer
  into v_quantity
  from public.guild_sales_stock_items gssi
  where gssi.guild_id = p_guild_id
    and gssi.product_id = p_product_id
    and gssi.status = 'available';

  update public.guild_sales_products
  set stock_quantity = greatest(0, v_quantity)
  where guild_id = p_guild_id
    and id = p_product_id
    and inventory_tracked is not false;

  return greatest(0, v_quantity);
end;
$$;

create or replace function public.tr_sync_guild_sales_product_stock_quantity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.sync_guild_sales_product_stock_quantity(old.guild_id, old.product_id);
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    perform public.sync_guild_sales_product_stock_quantity(new.guild_id, new.product_id);
  end if;

  return coalesce(new, old);
end;
$$;

create or replace function public.tr_normalize_guild_sales_stock_item_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.quantity > 0 and new.status = 'delivered' then
    new.status = 'available';
  elsif new.quantity = 0 and new.status = 'available' then
    new.status = 'delivered';
  end if;

  return new;
end;
$$;

drop trigger if exists tr_guild_sales_stock_items_normalize_status
on public.guild_sales_stock_items;
create trigger tr_guild_sales_stock_items_normalize_status
before insert or update of quantity, status on public.guild_sales_stock_items
for each row
execute function public.tr_normalize_guild_sales_stock_item_status();

drop trigger if exists tr_guild_sales_stock_items_sync_product_quantity
on public.guild_sales_stock_items;
create trigger tr_guild_sales_stock_items_sync_product_quantity
after insert or update or delete on public.guild_sales_stock_items
for each row
execute function public.tr_sync_guild_sales_product_stock_quantity();

create or replace function public.acquire_guild_sales_cart_delivery_lock(
  p_cart_id uuid
)
returns public.guild_sales_carts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cart public.guild_sales_carts%rowtype;
begin
  update public.guild_sales_carts
  set
    delivery_started_at = timezone('utc', now()),
    delivery_lock_error = ''
  where id = p_cart_id
    and (
      delivery_started_at is null
      or delivery_started_at < timezone('utc', now()) - interval '10 minutes'
    )
    and delivered_at is null
    and status in ('paid', 'payment_pending')
  returning *
  into v_cart;

  if not found then
    return null;
  end if;

  return v_cart;
end;
$$;

select public.sync_guild_sales_product_stock_quantity(product.guild_id, product.product_id)
from (
  select distinct guild_id, product_id
  from public.guild_sales_stock_items
) product;

comment on table public.guild_sales_order_events is 'Auditoria de eventos do pedido de venda Discord: pagamento, entrega, recibo e falhas operacionais.';
comment on function public.claim_guild_sales_stock_item(text, uuid, text) is 'Reserva atomicamente uma unidade disponivel de estoque digital para entrega.';
comment on function public.sync_guild_sales_product_stock_quantity(text, uuid) is 'Recalcula o estoque publicado do produto a partir das unidades digitais disponiveis.';
comment on function public.tr_normalize_guild_sales_stock_item_status() is 'Mantem status e quantidade do estoque digital coerentes antes de recalcular o estoque do produto.';
comment on function public.acquire_guild_sales_cart_delivery_lock(uuid) is 'Adquire trava idempotente para impedir entrega duplicada do mesmo carrinho.';


-- ============================================================================
-- MIGRATION: 117_guild_sales_coupons_gifts.sql
-- ============================================================================

-- Coupons, gift cards and promotions for Discord sales checkout.
-- Safe to run more than once.

alter table public.guild_sales_carts
add column if not exists discount_id uuid null,
add column if not exists discount_code text not null default '',
add column if not exists discount_kind text not null default '',
add column if not exists discount_amount numeric(12,2) not null default 0,
add column if not exists discount_snapshot jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'guild_sales_carts_discount_amount_check'
  ) then
    alter table public.guild_sales_carts
      add constraint guild_sales_carts_discount_amount_check
      check (discount_amount >= 0 and total_amount >= 0 and subtotal_amount >= 0);
  end if;
end
$$;

create table if not exists public.guild_sales_discounts (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  kind text not null default 'coupon',
  code text not null,
  title text not null,
  description text not null default '',
  status text not null default 'active',
  discount_type text not null default 'percent',
  discount_value numeric(12,2) not null default 0,
  initial_amount numeric(12,2) not null default 0,
  remaining_amount numeric(12,2) not null default 0,
  minimum_order_amount numeric(12,2) not null default 0,
  applies_to_all_products boolean not null default true,
  product_ids uuid[] not null default '{}',
  max_redemptions integer null,
  one_per_customer boolean not null default true,
  starts_at timestamptz null,
  expires_at timestamptz null,
  metadata jsonb not null default '{}'::jsonb,
  configured_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_sales_discounts_unique_code unique (guild_id, code),
  constraint guild_sales_discounts_guild_id_check
    check (guild_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_discounts_kind_check
    check (kind in ('coupon', 'gift_card', 'promotion')),
  constraint guild_sales_discounts_code_check
    check (code ~ '^[A-Z0-9][A-Z0-9_-]{1,63}$'),
  constraint guild_sales_discounts_status_check
    check (status in ('draft', 'active', 'paused', 'expired')),
  constraint guild_sales_discounts_type_check
    check (discount_type in ('fixed', 'percent')),
  constraint guild_sales_discounts_value_check
    check (
      discount_value >= 0
      and initial_amount >= 0
      and remaining_amount >= 0
      and minimum_order_amount >= 0
      and (max_redemptions is null or max_redemptions > 0)
    )
);

create index if not exists idx_guild_sales_discounts_guild_status
on public.guild_sales_discounts (guild_id, status, kind, created_at desc);

create index if not exists idx_guild_sales_discounts_product_ids
on public.guild_sales_discounts using gin (product_ids);

drop trigger if exists tr_guild_sales_discounts_updated_at on public.guild_sales_discounts;
create trigger tr_guild_sales_discounts_updated_at
before update on public.guild_sales_discounts
for each row
execute function public.set_updated_at();

alter table public.guild_sales_discounts enable row level security;

drop policy if exists "service_role_all_guild_sales_discounts" on public.guild_sales_discounts;
create policy "service_role_all_guild_sales_discounts"
on public.guild_sales_discounts
for all
to service_role
using (true)
with check (true);

create table if not exists public.guild_sales_discount_redemptions (
  id uuid primary key default gen_random_uuid(),
  discount_id uuid not null references public.guild_sales_discounts(id) on delete cascade,
  cart_id uuid not null references public.guild_sales_carts(id) on delete cascade,
  guild_id text not null,
  auth_user_id bigint null references public.auth_users(id) on delete set null,
  discord_user_id text not null,
  discount_amount numeric(12,2) not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  constraint guild_sales_discount_redemptions_unique_cart unique (discount_id, cart_id),
  constraint guild_sales_discount_redemptions_guild_id_check
    check (guild_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_discount_redemptions_discord_user_id_check
    check (discord_user_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_discount_redemptions_amount_check
    check (discount_amount >= 0)
);

create index if not exists idx_guild_sales_discount_redemptions_discount
on public.guild_sales_discount_redemptions (discount_id, created_at desc);

create index if not exists idx_guild_sales_discount_redemptions_user
on public.guild_sales_discount_redemptions (guild_id, auth_user_id, discount_id)
where auth_user_id is not null;

alter table public.guild_sales_discount_redemptions enable row level security;

drop policy if exists "service_role_all_guild_sales_discount_redemptions" on public.guild_sales_discount_redemptions;
create policy "service_role_all_guild_sales_discount_redemptions"
on public.guild_sales_discount_redemptions
for all
to service_role
using (true)
with check (true);

comment on table public.guild_sales_discounts is 'Cupons, gift cards e promocoes aplicaveis ao checkout de vendas Discord por servidor.';
comment on table public.guild_sales_discount_redemptions is 'Resgates efetivados apos pagamento aprovado para auditar uso e consumir saldo de gift cards.';


-- ============================================================================
-- MIGRATION: 118_guild_ticket_refund_settings.sql
-- ============================================================================

create table if not exists public.guild_ticket_refund_settings (
  guild_id text primary key,
  enabled boolean not null default true,
  refund_limit_days integer not null default 7 check (refund_limit_days >= 0 and refund_limit_days <= 365),
  refund_rules text not null default '',
  auto_process_enabled boolean not null default false,
  manual_approval_required boolean not null default true,
  approval_channel_id text,
  approver_role_ids text[] not null default '{}',
  success_message text not null default '',
  error_message text not null default '',
  configured_by_user_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists guild_ticket_refund_settings_updated_idx
  on public.guild_ticket_refund_settings (updated_at desc);

alter table public.guild_ticket_refund_settings enable row level security;

drop policy if exists "guild_ticket_refund_settings_service_role_all"
  on public.guild_ticket_refund_settings;

create policy "guild_ticket_refund_settings_service_role_all"
  on public.guild_ticket_refund_settings
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create or replace function public.set_guild_ticket_refund_settings_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists guild_ticket_refund_settings_updated_at
  on public.guild_ticket_refund_settings;

create trigger guild_ticket_refund_settings_updated_at
  before update on public.guild_ticket_refund_settings
  for each row
  execute function public.set_guild_ticket_refund_settings_updated_at();


-- ============================================================================
-- MIGRATION: 119_ticket_refund_auth_and_audit.sql
-- ============================================================================

create table if not exists public.ticket_refund_auth_links (
  id uuid primary key default gen_random_uuid(),
  ticket_id bigint not null references public.tickets(id) on delete cascade,
  guild_id text not null,
  channel_id text not null,
  discord_user_id text not null,
  token_hash text not null unique,
  status text not null default 'pending',
  auth_user_id bigint references public.auth_users(id) on delete set null,
  expires_at timestamptz not null,
  confirmed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint ticket_refund_auth_links_status_check
    check (status in ('pending', 'confirmed', 'expired', 'revoked')),
  constraint ticket_refund_auth_links_guild_id_check
    check (guild_id ~ '^[0-9]{10,25}$'),
  constraint ticket_refund_auth_links_channel_id_check
    check (channel_id ~ '^[0-9]{10,25}$'),
  constraint ticket_refund_auth_links_discord_user_id_check
    check (discord_user_id ~ '^[0-9]{10,25}$')
);

create index if not exists idx_ticket_refund_auth_links_ticket_status
  on public.ticket_refund_auth_links (ticket_id, status, created_at desc);

create index if not exists idx_ticket_refund_auth_links_discord_pending
  on public.ticket_refund_auth_links (discord_user_id, status, expires_at desc);

drop trigger if exists tr_ticket_refund_auth_links_updated_at
  on public.ticket_refund_auth_links;

create trigger tr_ticket_refund_auth_links_updated_at
  before update on public.ticket_refund_auth_links
  for each row
  execute function public.set_updated_at();

alter table public.ticket_refund_auth_links enable row level security;

drop policy if exists "service_role_all_ticket_refund_auth_links"
  on public.ticket_refund_auth_links;

create policy "service_role_all_ticket_refund_auth_links"
  on public.ticket_refund_auth_links
  for all
  to service_role
  using (true)
  with check (true);

alter table public.guild_sales_carts
  drop constraint if exists guild_sales_carts_status_check;

alter table public.guild_sales_carts
  add constraint guild_sales_carts_status_check
  check (
    status in (
      'link_required',
      'open',
      'payment_pending',
      'paid',
      'delivered',
      'delivery_failed',
      'rejected',
      'cancelled',
      'expired',
      'refunded',
      'charged_back'
    )
  );

alter table public.payment_orders
  drop constraint if exists payment_orders_status_check;

alter table public.payment_orders
  add constraint payment_orders_status_check
  check (
    status in (
      'pending',
      'approved',
      'rejected',
      'cancelled',
      'expired',
      'failed',
      'refunded',
      'charged_back'
    )
  );

create table if not exists public.ticket_refund_audit_events (
  id bigint generated always as identity primary key,
  ticket_id bigint references public.tickets(id) on delete set null,
  guild_id text,
  channel_id text,
  discord_user_id text,
  auth_user_id bigint references public.auth_users(id) on delete set null,
  event_type text not null,
  outcome text not null default 'recorded',
  order_key text,
  risk_score integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  constraint ticket_refund_audit_events_risk_score_check
    check (risk_score is null or risk_score between 0 and 100)
);

create index if not exists idx_ticket_refund_audit_events_ticket_created
  on public.ticket_refund_audit_events (ticket_id, created_at desc);

create index if not exists idx_ticket_refund_audit_events_guild_created
  on public.ticket_refund_audit_events (guild_id, created_at desc);

create index if not exists idx_ticket_refund_audit_events_user_created
  on public.ticket_refund_audit_events (discord_user_id, created_at desc);

alter table public.ticket_refund_audit_events enable row level security;

drop policy if exists "service_role_all_ticket_refund_audit_events"
  on public.ticket_refund_audit_events;

create policy "service_role_all_ticket_refund_audit_events"
  on public.ticket_refund_audit_events
  for all
  to service_role
  using (true)
  with check (true);


-- ============================================================================
-- MIGRATION: 120_ticket_refund_enterprise_hardening.sql
-- ============================================================================

alter table if exists public.guild_ticket_refund_settings
  add constraint guild_ticket_refund_settings_single_mode_check
  check (
    (auto_process_enabled = true and manual_approval_required = false)
    or
    (auto_process_enabled = false and manual_approval_required = true)
  ) not valid;

create index if not exists idx_guild_ticket_refund_settings_mode_updated
  on public.guild_ticket_refund_settings (guild_id, auto_process_enabled, manual_approval_required, updated_at desc);

create index if not exists idx_ticket_refund_audit_events_protocol
  on public.ticket_refund_audit_events ((metadata->>'protocol'))
  where metadata ? 'protocol';

create index if not exists idx_ticket_dm_queue_refund_pending
  on public.ticket_dm_queue (guild_id, status, next_attempt_at)
  where kind in ('ticket_refund_processed_dm', 'ticket_refund_denied_dm');


-- ============================================================================
-- MIGRATION: 121_guild_sales_stock_reservations.sql
-- ============================================================================

-- Atomic stock reservations for Discord sales checkout.
-- Prevents a cart from generating a payment for stock that can be consumed by another cart before approval.
-- Safe to run more than once.

alter table if exists public.guild_sales_stock_items
  add column if not exists reserved_cart_id uuid null references public.guild_sales_carts(id) on delete set null,
  add column if not exists reserved_cart_item_id uuid null references public.guild_sales_cart_items(id) on delete set null,
  add column if not exists reserved_unit_index integer null,
  add column if not exists reserved_at timestamptz null,
  add column if not exists reservation_expires_at timestamptz null;

create index if not exists idx_guild_sales_stock_items_reserved_cart
  on public.guild_sales_stock_items (reserved_cart_id, status, reservation_expires_at)
  where reserved_cart_id is not null;

create index if not exists idx_guild_sales_stock_items_expired_reservations
  on public.guild_sales_stock_items (reservation_expires_at)
  where status = 'reserved' and reservation_expires_at is not null;

create unique index if not exists idx_guild_sales_stock_items_reserved_unit_unique
  on public.guild_sales_stock_items (reserved_cart_id, reserved_cart_item_id, reserved_unit_index)
  where status = 'reserved'
    and reserved_cart_id is not null
    and reserved_cart_item_id is not null
    and reserved_unit_index is not null;

create or replace function public.release_expired_guild_sales_stock_reservations()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_released integer := 0;
begin
  create temporary table if not exists pg_temp.guild_sales_stock_reservations_to_sync (
    guild_id text not null,
    product_id uuid not null,
    primary key (guild_id, product_id)
  ) on commit drop;

  truncate table pg_temp.guild_sales_stock_reservations_to_sync;

  insert into pg_temp.guild_sales_stock_reservations_to_sync (guild_id, product_id)
  select distinct guild_id, product_id
  from public.guild_sales_stock_items
  where status = 'reserved'
    and reservation_expires_at is not null
    and reservation_expires_at <= timezone('utc', now())
  on conflict do nothing;

  update public.guild_sales_stock_items
  set
    status = 'available',
    reserved_cart_id = null,
    reserved_cart_item_id = null,
    reserved_unit_index = null,
    reserved_at = null,
    reservation_expires_at = null
  where status = 'reserved'
    and reservation_expires_at is not null
    and reservation_expires_at <= timezone('utc', now());

  get diagnostics v_released = row_count;

  perform public.sync_guild_sales_product_stock_quantity(sync.guild_id, sync.product_id)
  from pg_temp.guild_sales_stock_reservations_to_sync sync;

  return v_released;
end;
$$;

create or replace function public.reserve_guild_sales_stock_item(
  p_guild_id text,
  p_product_id uuid,
  p_cart_id uuid,
  p_cart_item_id uuid,
  p_unit_index integer,
  p_reservation_expires_at timestamptz,
  p_preferred_delivery_method text default null
)
returns setof public.guild_sales_stock_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.guild_sales_stock_items%rowtype;
  v_reserved public.guild_sales_stock_items%rowtype;
begin
  if p_preferred_delivery_method is not null
    and p_preferred_delivery_method not in ('email', 'discord_dm', 'flowdesk_link')
  then
    raise exception 'Metodo de entrega invalido.';
  end if;

  perform public.release_expired_guild_sales_stock_reservations();

  select *
  into v_reserved
  from public.guild_sales_stock_items
  where guild_id = p_guild_id
    and product_id = p_product_id
    and reserved_cart_id = p_cart_id
    and reserved_cart_item_id = p_cart_item_id
    and reserved_unit_index = p_unit_index
    and status = 'reserved'
    and quantity > 0
  for update
  limit 1;

  if found then
    update public.guild_sales_stock_items
    set reservation_expires_at = greatest(
      coalesce(reservation_expires_at, p_reservation_expires_at),
      p_reservation_expires_at
    )
    where id = v_reserved.id
    returning *
    into v_reserved;

    return next v_reserved;
    return;
  end if;

  select *
  into v_item
  from public.guild_sales_stock_items
  where guild_id = p_guild_id
    and product_id = p_product_id
    and status = 'available'
    and quantity > 0
    and (
      p_preferred_delivery_method is null
      or delivery_method = p_preferred_delivery_method
    )
  order by created_at asc
  for update skip locked
  limit 1;

  if not found then
    return;
  end if;

  if v_item.quantity > 1 then
    update public.guild_sales_stock_items
    set quantity = greatest(0, v_item.quantity - 1)
    where id = v_item.id;

    insert into public.guild_sales_stock_items (
      guild_id,
      product_id,
      product_name,
      item_type,
      delivery_method,
      status,
      category,
      platform,
      provider,
      email,
      login,
      password,
      access_type,
      recovery,
      gift_card_name,
      redemption_value,
      redemption_code,
      access_link,
      link_password,
      region,
      validity,
      quantity,
      server,
      buyer_required_id,
      delivery_deadline,
      service_type,
      required_buyer_info,
      discord_product_type,
      server_or_bot_link,
      token_or_key,
      required_permissions,
      tool_name,
      automation_type,
      software_name,
      software_version,
      operating_system,
      license_key,
      download_link,
      subscription_duration,
      account_type,
      course_name,
      item_name,
      instructions,
      observations,
      payload,
      configured_by_user_id,
      reserved_cart_id,
      reserved_cart_item_id,
      reserved_unit_index,
      reserved_at,
      reservation_expires_at
    )
    values (
      v_item.guild_id,
      v_item.product_id,
      v_item.product_name,
      v_item.item_type,
      v_item.delivery_method,
      'reserved',
      v_item.category,
      v_item.platform,
      v_item.provider,
      v_item.email,
      v_item.login,
      v_item.password,
      v_item.access_type,
      v_item.recovery,
      v_item.gift_card_name,
      v_item.redemption_value,
      v_item.redemption_code,
      v_item.access_link,
      v_item.link_password,
      v_item.region,
      v_item.validity,
      1,
      v_item.server,
      v_item.buyer_required_id,
      v_item.delivery_deadline,
      v_item.service_type,
      v_item.required_buyer_info,
      v_item.discord_product_type,
      v_item.server_or_bot_link,
      v_item.token_or_key,
      v_item.required_permissions,
      v_item.tool_name,
      v_item.automation_type,
      v_item.software_name,
      v_item.software_version,
      v_item.operating_system,
      v_item.license_key,
      v_item.download_link,
      v_item.subscription_duration,
      v_item.account_type,
      v_item.course_name,
      v_item.item_name,
      v_item.instructions,
      v_item.observations,
      v_item.payload,
      v_item.configured_by_user_id,
      p_cart_id,
      p_cart_item_id,
      p_unit_index,
      timezone('utc', now()),
      p_reservation_expires_at
    )
    returning *
    into v_reserved;
  else
    update public.guild_sales_stock_items
    set
      status = 'reserved',
      reserved_cart_id = p_cart_id,
      reserved_cart_item_id = p_cart_item_id,
      reserved_unit_index = p_unit_index,
      reserved_at = timezone('utc', now()),
      reservation_expires_at = p_reservation_expires_at
    where id = v_item.id
    returning *
    into v_reserved;
  end if;

  perform public.sync_guild_sales_product_stock_quantity(p_guild_id, p_product_id);
  return next v_reserved;
end;
$$;

create or replace function public.claim_reserved_guild_sales_stock_item(
  p_guild_id text,
  p_product_id uuid,
  p_cart_id uuid,
  p_cart_item_id uuid,
  p_unit_index integer
)
returns setof public.guild_sales_stock_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.guild_sales_stock_items%rowtype;
begin
  select *
  into v_item
  from public.guild_sales_stock_items
  where guild_id = p_guild_id
    and product_id = p_product_id
    and reserved_cart_id = p_cart_id
    and reserved_cart_item_id = p_cart_item_id
    and reserved_unit_index = p_unit_index
    and (
      (status = 'reserved' and quantity > 0)
      or status = 'delivered'
    )
  for update
  limit 1;

  if not found then
    return;
  end if;

  if v_item.status = 'delivered' then
    return next v_item;
    return;
  end if;

  update public.guild_sales_stock_items
  set
    quantity = 0,
    status = 'delivered'
  where id = v_item.id;

  perform public.sync_guild_sales_product_stock_quantity(p_guild_id, p_product_id);
  return next v_item;
end;
$$;

create or replace function public.release_guild_sales_stock_reservations(
  p_cart_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_released integer := 0;
begin
  create temporary table if not exists pg_temp.guild_sales_stock_reservations_to_sync (
    guild_id text not null,
    product_id uuid not null,
    primary key (guild_id, product_id)
  ) on commit drop;

  truncate table pg_temp.guild_sales_stock_reservations_to_sync;

  insert into pg_temp.guild_sales_stock_reservations_to_sync (guild_id, product_id)
  select distinct guild_id, product_id
  from public.guild_sales_stock_items
  where reserved_cart_id = p_cart_id
    and status = 'reserved'
    and quantity > 0
  on conflict do nothing;

  update public.guild_sales_stock_items
  set
    status = 'available',
    reserved_cart_id = null,
    reserved_cart_item_id = null,
    reserved_unit_index = null,
    reserved_at = null,
    reservation_expires_at = null
  where reserved_cart_id = p_cart_id
    and status = 'reserved'
    and quantity > 0;

  get diagnostics v_released = row_count;

  perform public.sync_guild_sales_product_stock_quantity(sync.guild_id, sync.product_id)
  from pg_temp.guild_sales_stock_reservations_to_sync sync;

  return v_released;
end;
$$;

create or replace function public.claim_guild_sales_stock_item(
  p_guild_id text,
  p_product_id uuid,
  p_preferred_delivery_method text default null
)
returns setof public.guild_sales_stock_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.guild_sales_stock_items%rowtype;
begin
  if p_preferred_delivery_method is not null
    and p_preferred_delivery_method not in ('email', 'discord_dm', 'flowdesk_link')
  then
    raise exception 'Metodo de entrega invalido.';
  end if;

  perform public.release_expired_guild_sales_stock_reservations();

  select *
  into v_item
  from public.guild_sales_stock_items
  where guild_id = p_guild_id
    and product_id = p_product_id
    and status = 'available'
    and quantity > 0
    and (
      p_preferred_delivery_method is null
      or delivery_method = p_preferred_delivery_method
    )
  order by created_at asc
  for update skip locked
  limit 1;

  if not found then
    return;
  end if;

  update public.guild_sales_stock_items
  set
    quantity = greatest(0, v_item.quantity - 1),
    status = case when v_item.quantity - 1 > 0 then 'available' else 'delivered' end
  where id = v_item.id;

  perform public.sync_guild_sales_product_stock_quantity(p_guild_id, p_product_id);
  return next v_item;
end;
$$;

select public.release_expired_guild_sales_stock_reservations();
select public.sync_guild_sales_product_stock_quantity(stock.guild_id, stock.product_id)
from (
  select distinct guild_id, product_id
  from public.guild_sales_stock_items
) stock;

comment on function public.reserve_guild_sales_stock_item(text, uuid, uuid, uuid, integer, timestamptz, text) is 'Reserves one available digital stock unit for a cart item/unit before payment is created.';
comment on function public.claim_reserved_guild_sales_stock_item(text, uuid, uuid, uuid, integer) is 'Consumes a stock unit previously reserved for a cart item/unit after payment approval.';
comment on function public.release_guild_sales_stock_reservations(uuid) is 'Releases pending stock reservations for an unpaid or failed sales cart.';
comment on function public.release_expired_guild_sales_stock_reservations() is 'Releases expired pending stock reservations and returns the number of released rows.';


-- ============================================================================
-- MIGRATION: 122_ticket_refund_sales_refund_status_reconciliation.sql
-- ============================================================================

-- Reconcile sales carts after provider refunds.
-- Safe to run more than once.

alter table public.guild_sales_carts
  drop constraint if exists guild_sales_carts_status_check;

alter table public.guild_sales_carts
  add constraint guild_sales_carts_status_check
  check (
    status in (
      'link_required',
      'open',
      'payment_pending',
      'paid',
      'delivered',
      'delivery_failed',
      'rejected',
      'cancelled',
      'expired',
      'refunded',
      'charged_back'
    )
  );

update public.guild_sales_carts
set
  status = 'refunded',
  provider_status = coalesce(provider_status, 'refunded'),
  provider_status_detail = coalesce(nullif(provider_status_detail, ''), 'ticket_ai_refund')
where status <> 'refunded'
  and (
    lower(coalesce(provider_status, '')) = 'refunded'
    or lower(coalesce(provider_status_detail, '')) like '%refund%'
    or lower(coalesce(provider_status_detail, '')) like '%reembols%'
  );

update public.guild_sales_carts
set status = 'charged_back'
where status <> 'charged_back'
  and lower(coalesce(provider_status, '')) = 'charged_back';

comment on constraint guild_sales_carts_status_check
on public.guild_sales_carts
is 'Allows paid sales carts to move into explicit refunded and charged_back terminal states instead of being collapsed into cancelled.';


-- ============================================================================
-- MIGRATION: 123_security_definer_execution_hardening.sql
-- ============================================================================

-- Harden every project-owned SECURITY DEFINER function that currently exists in public.
-- Safe to run more than once.

do $$
declare
  fn record;
  has_anon boolean;
  has_authenticated boolean;
  has_service_role boolean;
begin
  select exists(select 1 from pg_roles where rolname = 'anon') into has_anon;
  select exists(select 1 from pg_roles where rolname = 'authenticated') into has_authenticated;
  select exists(select 1 from pg_roles where rolname = 'service_role') into has_service_role;

  for fn in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef = true
      and not exists (
        select 1
        from pg_depend d
        where d.classid = 'pg_proc'::regclass
          and d.objid = p.oid
          and d.deptype = 'e'
      )
  loop
    execute format(
      'alter function %s set search_path = pg_catalog, public',
      fn.signature
    );

    execute format('revoke all on function %s from public', fn.signature);

    if has_anon then
      execute format('revoke all on function %s from anon', fn.signature);
    end if;

    if has_authenticated then
      execute format('revoke all on function %s from authenticated', fn.signature);
    end if;

    if has_service_role then
      execute format('grant execute on function %s to service_role', fn.signature);
    end if;
  end loop;
end
$$;


-- ============================================================================
-- MIGRATION: 124_payment_refund_enterprise_lifecycle.sql
-- ============================================================================

-- Enterprise refund/subscription lifecycle hardening.
-- Safe to run more than once.

alter table public.payment_orders
  drop constraint if exists payment_orders_status_check;

alter table public.payment_orders
  add constraint payment_orders_status_check
  check (
    status in (
      'pending',
      'approved',
      'rejected',
      'cancelled',
      'expired',
      'failed',
      'refunded',
      'partially_refunded',
      'charged_back'
    )
  );

alter table if exists public.payment_checkout_carts
  drop constraint if exists payment_checkout_carts_cart_status_check;

alter table if exists public.payment_checkout_carts
  add constraint payment_checkout_carts_cart_status_check
  check (
    cart_status in (
      'draft',
      'pending',
      'approved',
      'rejected',
      'cancelled',
      'expired',
      'failed',
      'refunded',
      'partially_refunded',
      'charged_back'
    )
  );

alter table if exists public.payment_order_state_history
  drop constraint if exists payment_order_state_history_status_check;

alter table if exists public.payment_order_state_history
  add constraint payment_order_state_history_status_check
  check (
    status in (
      'pending',
      'approved',
      'rejected',
      'cancelled',
      'expired',
      'failed',
      'refunded',
      'partially_refunded',
      'charged_back'
    )
  );

create table if not exists public.payment_refund_records (
  id bigint generated always as identity primary key,
  payment_order_id bigint not null references public.payment_orders(id) on delete cascade,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  guild_id text null,
  refund_key text not null,
  provider_payment_id text null,
  provider_refund_id text null,
  status text not null,
  kind text not null,
  source text not null,
  amount numeric(12,2) not null default 0,
  currency text not null default 'BRL',
  reason text not null default '',
  actor_user_id text null,
  actor_label text null,
  protocol text null,
  access_action text not null default 'revoke_immediately',
  access_until timestamptz null,
  risk_score integer null,
  risk_flags jsonb not null default '[]'::jsonb,
  provider_payload jsonb not null default '{}'::jsonb,
  processed_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint payment_refund_records_refund_key_unique unique (payment_order_id, refund_key),
  constraint payment_refund_records_status_check
    check (status in ('refunded', 'partially_refunded', 'charged_back')),
  constraint payment_refund_records_kind_check
    check (kind in ('full_refund', 'partial_refund', 'chargeback', 'manual_adjustment', 'refund_reversal')),
  constraint payment_refund_records_source_check
    check (source in ('official_support_ticket', 'admin_manual', 'system_auto', 'mercado_pago_webhook', 'provider_reconciliation')),
  constraint payment_refund_records_access_action_check
    check (access_action in ('revoke_immediately', 'keep_until_expiration', 'cancel_renewal_only', 'block_internal', 'none')),
  constraint payment_refund_records_amount_check
    check (amount >= 0),
  constraint payment_refund_records_risk_score_check
    check (risk_score is null or risk_score between 0 and 100),
  constraint payment_refund_records_risk_flags_array_check
    check (jsonb_typeof(risk_flags) = 'array')
);

create index if not exists idx_payment_refund_records_order_processed
  on public.payment_refund_records (payment_order_id, processed_at desc);

create index if not exists idx_payment_refund_records_user_processed
  on public.payment_refund_records (user_id, processed_at desc);

create index if not exists idx_payment_refund_records_guild_processed
  on public.payment_refund_records (guild_id, processed_at desc)
  where guild_id is not null;

drop trigger if exists tr_payment_refund_records_updated_at
  on public.payment_refund_records;

create trigger tr_payment_refund_records_updated_at
  before update on public.payment_refund_records
  for each row
  execute function public.set_updated_at();

alter table public.payment_refund_records enable row level security;

drop policy if exists "service_role_all_payment_refund_records"
  on public.payment_refund_records;

create policy "service_role_all_payment_refund_records"
  on public.payment_refund_records
  for all
  to service_role
  using (true)
  with check (true);

create table if not exists public.payment_risk_flags (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  guild_id text null,
  payment_order_id bigint references public.payment_orders(id) on delete set null,
  flag_key text not null,
  severity text not null default 'medium',
  status text not null default 'active',
  reason text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint payment_risk_flags_unique unique (user_id, flag_key, payment_order_id),
  constraint payment_risk_flags_severity_check
    check (severity in ('low', 'medium', 'high', 'critical')),
  constraint payment_risk_flags_status_check
    check (status in ('active', 'reviewed', 'dismissed', 'expired'))
);

create index if not exists idx_payment_risk_flags_user_status
  on public.payment_risk_flags (user_id, status, created_at desc);

create index if not exists idx_payment_risk_flags_order
  on public.payment_risk_flags (payment_order_id)
  where payment_order_id is not null;

drop trigger if exists tr_payment_risk_flags_updated_at
  on public.payment_risk_flags;

create trigger tr_payment_risk_flags_updated_at
  before update on public.payment_risk_flags
  for each row
  execute function public.set_updated_at();

alter table public.payment_risk_flags enable row level security;

drop policy if exists "service_role_all_payment_risk_flags"
  on public.payment_risk_flags;

create policy "service_role_all_payment_risk_flags"
  on public.payment_risk_flags
  for all
  to service_role
  using (true)
  with check (true);

create table if not exists public.payment_refund_policy_rules (
  id bigint generated always as identity primary key,
  plan_family text not null,
  refund_window_days integer not null default 7,
  default_access_action text not null default 'revoke_immediately',
  outside_window_action text not null default 'manual_review',
  allow_partial_proration boolean not null default true,
  anti_abuse_refund_count_threshold integer not null default 2,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint payment_refund_policy_rules_plan_family_unique unique (plan_family),
  constraint payment_refund_policy_rules_plan_family_check
    check (plan_family in ('trial', 'monthly', 'quarterly', 'semiannual', 'annual', 'lifetime', 'custom')),
  constraint payment_refund_policy_rules_access_action_check
    check (default_access_action in ('revoke_immediately', 'keep_until_expiration', 'cancel_renewal_only', 'block_internal', 'none')),
  constraint payment_refund_policy_rules_outside_window_action_check
    check (outside_window_action in ('manual_review', 'partial_proration', 'deny', 'keep_until_expiration')),
  constraint payment_refund_policy_rules_window_check
    check (refund_window_days between 0 and 365),
  constraint payment_refund_policy_rules_abuse_threshold_check
    check (anti_abuse_refund_count_threshold between 1 and 20)
);

insert into public.payment_refund_policy_rules (
  plan_family,
  refund_window_days,
  default_access_action,
  outside_window_action,
  allow_partial_proration,
  anti_abuse_refund_count_threshold,
  metadata
)
values
  ('trial', 0, 'revoke_immediately', 'deny', false, 1, '{"description":"Teste gratuito sem estorno financeiro."}'::jsonb),
  ('monthly', 7, 'revoke_immediately', 'partial_proration', true, 2, '{"description":"Janela padrao SaaS mensal."}'::jsonb),
  ('quarterly', 7, 'revoke_immediately', 'partial_proration', true, 2, '{"description":"Ciclo trimestral com reembolso proporcional apos a janela."}'::jsonb),
  ('semiannual', 10, 'revoke_immediately', 'partial_proration', true, 2, '{"description":"Ciclo semestral com politica proporcional."}'::jsonb),
  ('annual', 14, 'revoke_immediately', 'partial_proration', true, 2, '{"description":"Ciclo anual com janela estendida."}'::jsonb),
  ('lifetime', 14, 'revoke_immediately', 'manual_review', false, 1, '{"description":"Plano vitalicio exige revisao manual depois da janela."}'::jsonb),
  ('custom', 7, 'revoke_immediately', 'manual_review', true, 2, '{"description":"Fallback para ciclos personalizados."}'::jsonb)
on conflict (plan_family) do nothing;

drop trigger if exists tr_payment_refund_policy_rules_updated_at
  on public.payment_refund_policy_rules;

create trigger tr_payment_refund_policy_rules_updated_at
  before update on public.payment_refund_policy_rules
  for each row
  execute function public.set_updated_at();

alter table public.payment_refund_policy_rules enable row level security;

drop policy if exists "service_role_all_payment_refund_policy_rules"
  on public.payment_refund_policy_rules;

create policy "service_role_all_payment_refund_policy_rules"
  on public.payment_refund_policy_rules
  for all
  to service_role
  using (true)
  with check (true);

update public.payment_orders
set status = 'refunded'
where status = 'cancelled'
  and (
    lower(coalesce(provider_status, '')) = 'refunded'
    or lower(coalesce(provider_status_detail, '')) like '%refund%'
    or lower(coalesce(provider_status_detail, '')) like '%reembols%'
  );

update public.payment_orders
set status = 'charged_back'
where status <> 'charged_back'
  and lower(coalesce(provider_status, '')) in ('charged_back', 'chargeback');

comment on table public.payment_refund_records
is 'Normalized immutable refund ledger for account payment history, support decisions, provider reconciliation and admin audit.';

comment on table public.payment_refund_policy_rules
is 'Configurable refund/access policy defaults by plan billing family.';


-- ============================================================================
-- MIGRATION: 125_hosting_projects.sql
-- ============================================================================

begin;

create table if not exists public.hosting_projects (
  id bigint generated always as identity primary key,
  vps_code uuid not null default gen_random_uuid(),
  user_id bigint not null references public.auth_users(id) on delete restrict,
  payment_order_id bigint references public.payment_orders(id) on delete set null,
  hosting_kind text not null check (hosting_kind in ('site', 'bot', 'cdn')),
  hosting_plan_id text not null,
  hosting_region_id text not null,
  github_owner text not null,
  github_repo text not null,
  github_repo_id text,
  github_branch text not null default 'main',
  status text not null default 'pending_provision'
    check (status in ('pending_payment', 'pending_provision', 'provisioning', 'active', 'failed', 'suspended', 'cancelled')),
  windows_runtime text not null default 'windows-vps',
  provisioning_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists idx_hosting_projects_vps_code_unique
on public.hosting_projects (vps_code);

create unique index if not exists idx_hosting_projects_payment_order_unique
on public.hosting_projects (payment_order_id)
where payment_order_id is not null;

create index if not exists idx_hosting_projects_user_created_at
on public.hosting_projects (user_id, created_at desc);

create index if not exists idx_hosting_projects_status_created_at
on public.hosting_projects (status, created_at desc);

drop trigger if exists tr_hosting_projects_updated_at on public.hosting_projects;
create trigger tr_hosting_projects_updated_at
before update on public.hosting_projects
for each row execute function public.set_updated_at();

alter table public.hosting_projects enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    drop policy if exists hosting_projects_service_role_all on public.hosting_projects;
    create policy hosting_projects_service_role_all
      on public.hosting_projects
      for all
      to service_role
      using (true)
      with check (true);
  end if;
end
$$;

commit;


-- ============================================================================
-- MIGRATION: 126_hosting_vps_management.sql
-- ============================================================================

begin;

alter table public.hosting_projects
  add column if not exists runtime_status text not null default 'offline'
    check (runtime_status in ('online', 'offline', 'restarting', 'deploying', 'crashed', 'suspended', 'unknown')),
  add column if not exists runtime_status_payload jsonb not null default '{}'::jsonb,
  add column if not exists runtime_last_seen_at timestamptz,
  add column if not exists active_deployment_id bigint,
  add column if not exists billing_status text not null default 'active'
    check (billing_status in ('active', 'past_due', 'refunded', 'charged_back', 'cancelled', 'expired')),
  add column if not exists access_expires_at timestamptz,
  add column if not exists refund_access_until timestamptz,
  add column if not exists refunded_at timestamptz,
  add column if not exists suspended_at timestamptz,
  add column if not exists suspension_reason text;

create index if not exists idx_hosting_projects_user_billing_access
on public.hosting_projects (user_id, billing_status, access_expires_at desc);

create table if not exists public.hosting_github_connections (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  github_login text,
  github_account_type text,
  github_avatar_url text,
  encrypted_token text not null,
  token_status text not null default 'active'
    check (token_status in ('active', 'invalid', 'revoked')),
  last_validated_at timestamptz,
  last_error text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id)
);

create index if not exists idx_hosting_github_connections_user_status
on public.hosting_github_connections (user_id, token_status);

create table if not exists public.hosting_vps_action_events (
  id bigint generated always as identity primary key,
  hosting_project_id bigint not null references public.hosting_projects(id) on delete cascade,
  actor_user_id bigint references public.auth_users(id) on delete set null,
  action text not null check (action in ('start', 'stop', 'restart', 'deploy', 'rollback', 'sync', 'env_update', 'file_write')),
  status text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed')),
  message text,
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default timezone('utc', now()),
  finished_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_hosting_vps_action_events_project_created
on public.hosting_vps_action_events (hosting_project_id, created_at desc);

create table if not exists public.hosting_vps_metrics (
  id bigint generated always as identity primary key,
  hosting_project_id bigint not null references public.hosting_projects(id) on delete cascade,
  cpu_percent numeric(6,2) not null default 0,
  ram_percent numeric(6,2) not null default 0,
  disk_percent numeric(6,2) not null default 0,
  network_rx_kbps numeric(12,2) not null default 0,
  network_tx_kbps numeric(12,2) not null default 0,
  process_count integer not null default 0,
  uptime_seconds bigint not null default 0,
  temperature_c numeric(6,2),
  app_cpu_percent numeric(6,2),
  app_ram_mb numeric(12,2),
  payload jsonb not null default '{}'::jsonb,
  sampled_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_hosting_vps_metrics_project_sampled
on public.hosting_vps_metrics (hosting_project_id, sampled_at desc);

create table if not exists public.hosting_vps_logs (
  id bigint generated always as identity primary key,
  hosting_project_id bigint not null references public.hosting_projects(id) on delete cascade,
  level text not null default 'info' check (level in ('debug', 'info', 'warn', 'error', 'success')),
  source text not null default 'runtime',
  message text not null,
  metadata jsonb not null default '{}'::jsonb,
  emitted_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_hosting_vps_logs_project_emitted
on public.hosting_vps_logs (hosting_project_id, emitted_at desc);

create table if not exists public.hosting_vps_deployments (
  id bigint generated always as identity primary key,
  hosting_project_id bigint not null references public.hosting_projects(id) on delete cascade,
  environment text not null default 'production' check (environment in ('development', 'preview', 'production')),
  status text not null default 'queued'
    check (status in ('pending', 'queued', 'building', 'preparing', 'deploying', 'preview', 'production', 'ready', 'failed', 'cancelled')),
  branch text not null,
  commit_sha text,
  commit_author text,
  commit_message text,
  build_started_at timestamptz,
  build_finished_at timestamptz,
  deployed_at timestamptz,
  duration_ms integer,
  logs jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_hosting_vps_deployments_project_created
on public.hosting_vps_deployments (hosting_project_id, created_at desc);

create table if not exists public.hosting_vps_env_vars (
  id bigint generated always as identity primary key,
  hosting_project_id bigint not null references public.hosting_projects(id) on delete cascade,
  environment text not null check (environment in ('development', 'preview', 'production')),
  key text not null,
  encrypted_value text not null,
  value_preview text,
  visible_value text,
  note text,
  sensitive boolean not null default true,
  version integer not null default 1,
  updated_by_user_id bigint references public.auth_users(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (hosting_project_id, environment, key)
);

alter table public.hosting_vps_env_vars
  add column if not exists visible_value text,
  add column if not exists note text,
  add column if not exists sensitive boolean not null default true;

create index if not exists idx_hosting_vps_env_vars_project_env
on public.hosting_vps_env_vars (hosting_project_id, environment, key);

drop trigger if exists tr_hosting_vps_deployments_updated_at on public.hosting_vps_deployments;
create trigger tr_hosting_vps_deployments_updated_at
before update on public.hosting_vps_deployments
for each row execute function public.set_updated_at();

drop trigger if exists tr_hosting_vps_env_vars_updated_at on public.hosting_vps_env_vars;
create trigger tr_hosting_vps_env_vars_updated_at
before update on public.hosting_vps_env_vars
for each row execute function public.set_updated_at();

drop trigger if exists tr_hosting_github_connections_updated_at on public.hosting_github_connections;
create trigger tr_hosting_github_connections_updated_at
before update on public.hosting_github_connections
for each row execute function public.set_updated_at();

alter table public.hosting_github_connections enable row level security;
alter table public.hosting_vps_action_events enable row level security;
alter table public.hosting_vps_metrics enable row level security;
alter table public.hosting_vps_logs enable row level security;
alter table public.hosting_vps_deployments enable row level security;
alter table public.hosting_vps_env_vars enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    drop policy if exists hosting_github_connections_service_role_all on public.hosting_github_connections;
    create policy hosting_github_connections_service_role_all
      on public.hosting_github_connections for all to service_role
      using (true) with check (true);

    drop policy if exists hosting_vps_action_events_service_role_all on public.hosting_vps_action_events;
    create policy hosting_vps_action_events_service_role_all
      on public.hosting_vps_action_events for all to service_role
      using (true) with check (true);

    drop policy if exists hosting_vps_metrics_service_role_all on public.hosting_vps_metrics;
    create policy hosting_vps_metrics_service_role_all
      on public.hosting_vps_metrics for all to service_role
      using (true) with check (true);

    drop policy if exists hosting_vps_logs_service_role_all on public.hosting_vps_logs;
    create policy hosting_vps_logs_service_role_all
      on public.hosting_vps_logs for all to service_role
      using (true) with check (true);

    drop policy if exists hosting_vps_deployments_service_role_all on public.hosting_vps_deployments;
    create policy hosting_vps_deployments_service_role_all
      on public.hosting_vps_deployments for all to service_role
      using (true) with check (true);

    drop policy if exists hosting_vps_env_vars_service_role_all on public.hosting_vps_env_vars;
    create policy hosting_vps_env_vars_service_role_all
      on public.hosting_vps_env_vars for all to service_role
      using (true) with check (true);
  end if;
end
$$;

commit;


-- ============================================================================
-- MIGRATION: 127_hosting_vps_flow_chat_history.sql
-- ============================================================================

begin;

create table if not exists public.hosting_vps_flow_chats (
  id bigint generated always as identity primary key,
  hosting_project_id bigint not null references public.hosting_projects(id) on delete cascade,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  title text not null default 'Novo chat',
  model text not null default 'gpt-4o-mini',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_hosting_vps_flow_chats_project_user_updated
on public.hosting_vps_flow_chats (hosting_project_id, user_id, updated_at desc);

create table if not exists public.hosting_vps_flow_chat_messages (
  id bigint generated always as identity primary key,
  chat_id bigint not null references public.hosting_vps_flow_chats(id) on delete cascade,
  hosting_project_id bigint not null references public.hosting_projects(id) on delete cascade,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  model text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_hosting_vps_flow_chat_messages_chat_created
on public.hosting_vps_flow_chat_messages (chat_id, created_at asc);

drop trigger if exists tr_hosting_vps_flow_chats_updated_at on public.hosting_vps_flow_chats;
create trigger tr_hosting_vps_flow_chats_updated_at
before update on public.hosting_vps_flow_chats
for each row execute function public.set_updated_at();

alter table public.hosting_vps_flow_chats enable row level security;
alter table public.hosting_vps_flow_chat_messages enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    drop policy if exists hosting_vps_flow_chats_service_role_all on public.hosting_vps_flow_chats;
    create policy hosting_vps_flow_chats_service_role_all
      on public.hosting_vps_flow_chats for all to service_role
      using (true) with check (true);

    drop policy if exists hosting_vps_flow_chat_messages_service_role_all on public.hosting_vps_flow_chat_messages;
    create policy hosting_vps_flow_chat_messages_service_role_all
      on public.hosting_vps_flow_chat_messages for all to service_role
      using (true) with check (true);
  end if;
end
$$;

commit;


-- ============================================================================
-- MIGRATION: 128_hosting_vps_flow_ai_daily_quota.sql
-- ============================================================================

begin;

create table if not exists public.hosting_vps_flow_ai_daily_usage (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  usage_date date not null default (timezone('utc', now())::date),
  tokens_used integer not null default 0,
  request_count integer not null default 0,
  blocked_until timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, usage_date)
);

create index if not exists idx_hosting_vps_flow_ai_daily_usage_user_date
on public.hosting_vps_flow_ai_daily_usage (user_id, usage_date desc);

drop trigger if exists tr_hosting_vps_flow_ai_daily_usage_updated_at on public.hosting_vps_flow_ai_daily_usage;
create trigger tr_hosting_vps_flow_ai_daily_usage_updated_at
before update on public.hosting_vps_flow_ai_daily_usage
for each row execute function public.set_updated_at();

alter table public.hosting_vps_flow_ai_daily_usage enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    drop policy if exists hosting_vps_flow_ai_daily_usage_service_role_all on public.hosting_vps_flow_ai_daily_usage;
    create policy hosting_vps_flow_ai_daily_usage_service_role_all
      on public.hosting_vps_flow_ai_daily_usage for all to service_role
      using (true) with check (true);
  end if;
end
$$;

commit;


-- ============================================================================
-- MIGRATION: 129_hosting_github_persistent_tokens.sql
-- ============================================================================

begin;

create table if not exists public.hosting_github_connections (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  github_login text,
  github_account_type text,
  github_avatar_url text,
  encrypted_token text not null,
  token_status text not null default 'active'
    check (token_status in ('active', 'invalid', 'revoked')),
  last_validated_at timestamptz,
  last_error text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id)
);

alter table public.hosting_github_connections
  add column if not exists encrypted_refresh_token text,
  add column if not exists access_token_expires_at timestamptz,
  add column if not exists refresh_token_expires_at timestamptz,
  add column if not exists scopes text,
  add column if not exists token_type text,
  add column if not exists refreshed_at timestamptz;

create index if not exists idx_hosting_github_connections_token_expiry
on public.hosting_github_connections (user_id, token_status, access_token_expires_at);

drop trigger if exists tr_hosting_github_connections_updated_at on public.hosting_github_connections;
create trigger tr_hosting_github_connections_updated_at
before update on public.hosting_github_connections
for each row execute function public.set_updated_at();

alter table public.hosting_github_connections enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    drop policy if exists hosting_github_connections_service_role_all on public.hosting_github_connections;
    create policy hosting_github_connections_service_role_all
      on public.hosting_github_connections for all to service_role
      using (true) with check (true);
  end if;
end
$$;

commit;


-- ============================================================================
-- MIGRATION: 130_account_identity_and_two_factor.sql
-- ============================================================================

begin;

create extension if not exists pgcrypto;

alter table public.auth_users
  add column if not exists profile_avatar_url text,
  add column if not exists profile_avatar_source text,
  add column if not exists profile_avatar_updated_at timestamptz;

update public.auth_users
set
  profile_avatar_url =
    'https://cdn.discordapp.com/avatars/' || discord_user_id || '/' || avatar ||
    case when avatar like 'a\_%' escape '\' then '.gif?size=512' else '.png?size=512' end,
  profile_avatar_source = 'discord',
  profile_avatar_updated_at = coalesce(updated_at, timezone('utc', now()))
where profile_avatar_url is null
  and discord_user_id is not null
  and avatar is not null;

alter table public.auth_email_otp_challenges
  drop constraint if exists auth_email_otp_challenges_purpose_check;

alter table public.auth_email_otp_challenges
  add constraint auth_email_otp_challenges_purpose_check
  check (purpose in (
    'login',
    'email_registration',
    'email_change_current',
    'email_change_new'
  ));

create table if not exists public.auth_account_email_changes (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.auth_users(id) on delete cascade,
  current_email text,
  new_email text not null,
  new_email_normalized text not null,
  current_challenge_id uuid references public.auth_email_otp_challenges(id) on delete set null,
  new_challenge_id uuid references public.auth_email_otp_challenges(id) on delete set null,
  current_verified_at timestamptz,
  new_verified_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.auth_user_provider_profiles (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  provider text not null check (provider in ('discord', 'google', 'microsoft', 'github')),
  provider_user_id text not null,
  provider_email text,
  provider_display_name text,
  provider_avatar_url text,
  linked_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, provider),
  unique (provider, provider_user_id)
);

create index if not exists idx_auth_user_provider_profiles_user
on public.auth_user_provider_profiles (user_id, provider);

create unique index if not exists idx_auth_account_email_changes_active_user
on public.auth_account_email_changes (user_id)
where completed_at is null and cancelled_at is null;

create unique index if not exists idx_auth_account_email_changes_active_email
on public.auth_account_email_changes (new_email_normalized)
where completed_at is null and cancelled_at is null;

create index if not exists idx_auth_account_email_changes_expires_at
on public.auth_account_email_changes (expires_at);

create table if not exists public.auth_user_totp (
  user_id bigint primary key references public.auth_users(id) on delete cascade,
  secret_encrypted text not null,
  enabled boolean not null default false,
  verified_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.auth_user_passkeys (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.auth_users(id) on delete cascade,
  credential_id text not null unique,
  public_key text not null,
  counter bigint not null default 0,
  transports text[] not null default '{}'::text[],
  device_type text,
  backed_up boolean not null default false,
  name text not null default 'Passkey',
  last_used_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_auth_user_passkeys_user_created_at
on public.auth_user_passkeys (user_id, created_at desc);

create table if not exists public.auth_security_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.auth_users(id) on delete cascade,
  kind text not null check (kind in ('passkey_registration', 'passkey_authentication', 'two_factor_login', 'sensitive_action')),
  challenge text not null,
  metadata jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

alter table public.auth_security_challenges
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.auth_security_challenges
  drop constraint if exists auth_security_challenges_kind_check;

alter table public.auth_security_challenges
  add constraint auth_security_challenges_kind_check
  check (kind in ('passkey_registration', 'passkey_authentication', 'two_factor_login', 'sensitive_action'));

create index if not exists idx_auth_security_challenges_active
on public.auth_security_challenges (user_id, kind, expires_at desc)
where consumed_at is null;

drop trigger if exists tr_auth_account_email_changes_updated_at on public.auth_account_email_changes;
create trigger tr_auth_account_email_changes_updated_at
before update on public.auth_account_email_changes
for each row execute function public.set_updated_at();

drop trigger if exists tr_auth_user_provider_profiles_updated_at on public.auth_user_provider_profiles;
create trigger tr_auth_user_provider_profiles_updated_at
before update on public.auth_user_provider_profiles
for each row execute function public.set_updated_at();

drop trigger if exists tr_auth_user_totp_updated_at on public.auth_user_totp;
create trigger tr_auth_user_totp_updated_at
before update on public.auth_user_totp
for each row execute function public.set_updated_at();

drop trigger if exists tr_auth_user_passkeys_updated_at on public.auth_user_passkeys;
create trigger tr_auth_user_passkeys_updated_at
before update on public.auth_user_passkeys
for each row execute function public.set_updated_at();

alter table public.auth_account_email_changes enable row level security;
alter table public.auth_user_provider_profiles enable row level security;
alter table public.auth_user_totp enable row level security;
alter table public.auth_user_passkeys enable row level security;
alter table public.auth_security_challenges enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    drop policy if exists auth_account_email_changes_service_role_all on public.auth_account_email_changes;
    create policy auth_account_email_changes_service_role_all
      on public.auth_account_email_changes for all to service_role
      using (true) with check (true);

    drop policy if exists auth_user_provider_profiles_service_role_all on public.auth_user_provider_profiles;
    create policy auth_user_provider_profiles_service_role_all
      on public.auth_user_provider_profiles for all to service_role
      using (true) with check (true);

    drop policy if exists auth_user_totp_service_role_all on public.auth_user_totp;
    create policy auth_user_totp_service_role_all
      on public.auth_user_totp for all to service_role
      using (true) with check (true);

    drop policy if exists auth_user_passkeys_service_role_all on public.auth_user_passkeys;
    create policy auth_user_passkeys_service_role_all
      on public.auth_user_passkeys for all to service_role
      using (true) with check (true);

    drop policy if exists auth_security_challenges_service_role_all on public.auth_security_challenges;
    create policy auth_security_challenges_service_role_all
      on public.auth_security_challenges for all to service_role
      using (true) with check (true);
  end if;
end
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'account-avatars',
  'account-avatars',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

commit;


-- ============================================================================
-- MIGRATION: 131_sensitive_account_actions.sql
-- ============================================================================

begin;

alter table public.auth_security_challenges
  drop constraint if exists auth_security_challenges_kind_check;

alter table public.auth_security_challenges
  add constraint auth_security_challenges_kind_check
  check (kind in (
    'passkey_registration',
    'passkey_authentication',
    'two_factor_login',
    'sensitive_action'
  ));

create index if not exists idx_auth_security_challenges_sensitive_action
on public.auth_security_challenges (user_id, expires_at desc)
where kind = 'sensitive_action' and consumed_at is null;

commit;


-- ============================================================================
-- MIGRATION: 132_account_sessions_management.sql
-- ============================================================================

begin;

alter table public.auth_sessions
  add column if not exists last_seen_at timestamptz;

update public.auth_sessions
set last_seen_at = coalesce(created_at, timezone('utc', now()))
where last_seen_at is null;

alter table public.auth_sessions
  alter column last_seen_at set default timezone('utc', now());

create index if not exists idx_auth_sessions_user_activity
on public.auth_sessions (user_id, revoked_at, last_seen_at desc);

commit;


-- ============================================================================
-- MIGRATION: 133_domain_multi_provider_platform.sql
-- ============================================================================

-- Flowdesk domains: Openprovider -> Spaceship -> Hover/OpenSRS + Cloudflare DNS.
-- Apply after site/sql/admin/004_domains.sql.
-- Safe to run before the optional domains schema exists.

do $$
begin
  if to_regclass('public.domain_contacts') is not null then
    alter table public.domain_contacts
      add column if not exists document_encrypted text;

    alter table public.domain_contacts
      alter column provider set default 'openprovider';
  end if;

  if to_regclass('public.domain_quotes') is not null then
    alter table public.domain_quotes
      add column if not exists provider text not null default 'openprovider',
      add column if not exists provider_cost numeric(12,4),
      add column if not exists provider_currency text not null default 'USD',
      add column if not exists exchange_rate_to_brl numeric(12,6),
      add column if not exists provider_attempts jsonb not null default '[]'::jsonb;

    if exists (
      select 1 from information_schema.columns
       where table_schema = 'public'
         and table_name = 'domain_quotes'
         and column_name = 'provider_cost_usd'
    ) and exists (
      select 1 from information_schema.columns
       where table_schema = 'public'
         and table_name = 'domain_quotes'
         and column_name = 'exchange_rate_usd_brl'
    ) then
      update public.domain_quotes
      set provider_cost = coalesce(provider_cost, provider_cost_usd),
          exchange_rate_to_brl = coalesce(exchange_rate_to_brl, exchange_rate_usd_brl)
      where provider_cost is null or exchange_rate_to_brl is null;
    end if;

    create index if not exists idx_domain_quotes_provider_created_at
      on public.domain_quotes (provider, created_at desc);
  end if;

  if to_regclass('public.domains') is not null then
    alter table public.domains
      add column if not exists quote_id uuid references public.domain_quotes(id) on delete set null,
      add column if not exists provider_cost numeric(12,4),
      add column if not exists provider_currency text,
      add column if not exists provider_attempts jsonb not null default '[]'::jsonb,
      add column if not exists cloudflare_zone_id text,
      add column if not exists cloudflare_zone_status text,
      add column if not exists cloudflare_dnssec jsonb;

    alter table public.domains
      alter column provider set default 'openprovider',
      alter column markup_percent set default 20;

    create unique index if not exists idx_domains_cloudflare_zone_id
      on public.domains (cloudflare_zone_id)
      where cloudflare_zone_id is not null;

    update public.domains set markup_percent = 20 where markup_percent = 22.5;
  end if;

  if to_regclass('public.domain_transfers') is not null then
    alter table public.domain_transfers
      add column if not exists provider text,
      add column if not exists contact_id uuid references public.domain_contacts(id) on delete set null,
      add column if not exists auth_code_encrypted text,
      add column if not exists provider_attempts jsonb not null default '[]'::jsonb;

    create index if not exists idx_domain_transfers_provider_status
      on public.domain_transfers (provider, status, updated_at);
  end if;

  if to_regclass('public.domain_dns_records') is not null then
    alter table public.domain_dns_records
      add column if not exists proxied boolean not null default false;

    alter table public.domain_dns_records
      alter column dns_provider set default 'cloudflare';
  end if;

  if to_regclass('public.domain_ledger') is not null then
    alter table public.domain_ledger
      add column if not exists provider_cost numeric(12,4),
      add column if not exists provider_currency text,
      add column if not exists exchange_rate_to_brl numeric(12,6);
  end if;
end
$$;


-- ============================================================================
-- MIGRATION: 134_platform_performance_hotpath_indexes.sql
-- ============================================================================

-- Performance hotpaths for the Next.js dashboard, checkout, hosting and public landing APIs.
-- Safe to run repeatedly. Optional tables are skipped to keep dev/staging schemas portable.

do $$
begin
  if to_regclass('public.discord_cdn_cache') is not null then
    create index if not exists idx_discord_cdn_cache_featured_updated
      on public.discord_cdn_cache (is_featured, last_updated_at desc)
      where is_featured = true;
  end if;

  if to_regclass('public.hosting_projects') is not null then
    create index if not exists idx_hosting_projects_user_status_billing_created
      on public.hosting_projects (user_id, status, billing_status, created_at desc);

    create index if not exists idx_hosting_projects_user_runtime_seen
      on public.hosting_projects (user_id, runtime_status, runtime_last_seen_at desc)
      where status <> 'cancelled';

    create index if not exists idx_hosting_projects_payment_billing
      on public.hosting_projects (payment_order_id, billing_status)
      where payment_order_id is not null;
  end if;

  if to_regclass('public.hosting_vps_deployments') is not null then
    create index if not exists idx_hosting_vps_deployments_project_status_created
      on public.hosting_vps_deployments (hosting_project_id, status, created_at desc);
  end if;

  if to_regclass('public.hosting_vps_action_events') is not null then
    create index if not exists idx_hosting_vps_action_events_project_status_created
      on public.hosting_vps_action_events (hosting_project_id, status, created_at desc);
  end if;

  if to_regclass('public.hosting_vps_logs') is not null then
    create index if not exists idx_hosting_vps_logs_project_source_emitted
      on public.hosting_vps_logs (hosting_project_id, source, emitted_at desc);
  end if;

  if to_regclass('public.auth_user_plan_state') is not null then
    create index if not exists idx_auth_user_plan_state_user_status_expires
      on public.auth_user_plan_state (user_id, status, expires_at desc);

    create index if not exists idx_auth_user_plan_state_last_payment_order
      on public.auth_user_plan_state (last_payment_order_id)
      where last_payment_order_id is not null;
  end if;

  if to_regclass('public.auth_user_plan_guilds') is not null then
    create index if not exists idx_auth_user_plan_guilds_user_guild_activated
      on public.auth_user_plan_guilds (user_id, guild_id, activated_at desc);

    create index if not exists idx_auth_user_plan_guilds_guild_activated
      on public.auth_user_plan_guilds (guild_id, activated_at desc);
  end if;

  if to_regclass('public.domain_quotes') is not null and exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'domain_quotes'
       and column_name = 'fqdn'
  ) then
    create index if not exists idx_domain_quotes_fqdn_provider_created
      on public.domain_quotes (fqdn, provider, created_at desc);
  end if;

  if to_regclass('public.domain_transfers') is not null and exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'domain_transfers'
       and column_name = 'contact_id'
  ) then
    create index if not exists idx_domain_transfers_contact_status_updated
      on public.domain_transfers (contact_id, status, updated_at desc)
      where contact_id is not null;
  end if;
end
$$;


-- ============================================================================
-- MIGRATION: 135_guild_security_log_queue.sql
-- ============================================================================

create table if not exists public.guild_security_log_queue (
  id bigint generated always as identity primary key,
  queue_key text not null unique,
  guild_id text not null,
  channel_id text not null,
  event_key text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  max_attempts integer not null default 48,
  next_attempt_at timestamptz not null default timezone('utc', now()),
  last_error text null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_security_log_queue_status_check
    check (status in ('pending', 'processing', 'failed'))
);

create index if not exists idx_guild_security_log_queue_status_next_attempt
on public.guild_security_log_queue (status, next_attempt_at, created_at);

create index if not exists idx_guild_security_log_queue_guild_event
on public.guild_security_log_queue (guild_id, event_key, created_at desc);

drop trigger if exists tr_guild_security_log_queue_updated_at on public.guild_security_log_queue;
create trigger tr_guild_security_log_queue_updated_at
before update on public.guild_security_log_queue
for each row
execute function public.set_updated_at();

alter table public.guild_security_log_queue enable row level security;

drop policy if exists "service_role_all_guild_security_log_queue" on public.guild_security_log_queue;
create policy "service_role_all_guild_security_log_queue"
on public.guild_security_log_queue
for all
to service_role
using (true)
with check (true);


-- ============================================================================
-- MIGRATION: 136_hosting_minecraft_control_plane.sql
-- ============================================================================

-- Flowdesk hosting: Minecraft control-plane persistence.
-- Stores the Minecraft choices made during onboarding and the worlds created later.

alter table if exists public.hosting_projects
  drop constraint if exists hosting_projects_hosting_kind_check;

alter table if exists public.hosting_projects
  add constraint hosting_projects_hosting_kind_check
  check (hosting_kind in ('site', 'bot', 'cdn', 'minecraft'));

create table if not exists public.hosting_minecraft_servers (
  id bigserial primary key,
  hosting_project_id bigint not null references public.hosting_projects(id) on delete cascade,
  payment_order_id bigint references public.payment_orders(id) on delete set null,
  user_id bigint not null,
  server_name text not null,
  server_slug text not null,
  minecraft_version text not null,
  server_type text not null,
  primary_domain text not null,
  fixed_domain text,
  cloudflare_status text not null default 'pending',
  cloudflare_payload jsonb not null default '{}'::jsonb,
  limits jsonb not null default '{}'::jsonb,
  status text not null default 'created',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hosting_minecraft_servers_type_check
    check (server_type in ('paper', 'purpur', 'fabric', 'forge', 'neoforge', 'vanilla')),
  constraint hosting_minecraft_servers_slug_check
    check (server_slug ~ '^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$')
);

create unique index if not exists idx_hosting_minecraft_servers_project
  on public.hosting_minecraft_servers (hosting_project_id);

create unique index if not exists idx_hosting_minecraft_servers_primary_domain
  on public.hosting_minecraft_servers (lower(primary_domain));

create index if not exists idx_hosting_minecraft_servers_user_created
  on public.hosting_minecraft_servers (user_id, created_at desc);

create table if not exists public.hosting_minecraft_worlds (
  id bigserial primary key,
  minecraft_server_id bigint not null references public.hosting_minecraft_servers(id) on delete cascade,
  hosting_project_id bigint not null references public.hosting_projects(id) on delete cascade,
  world_slug text not null,
  world_name text not null,
  status text not null default 'created',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hosting_minecraft_worlds_slug_check
    check (world_slug ~ '^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$')
);

create unique index if not exists idx_hosting_minecraft_worlds_server_slug
  on public.hosting_minecraft_worlds (minecraft_server_id, world_slug);

create index if not exists idx_hosting_minecraft_worlds_project_created
  on public.hosting_minecraft_worlds (hosting_project_id, created_at desc);

drop trigger if exists tr_hosting_minecraft_servers_updated_at on public.hosting_minecraft_servers;
create trigger tr_hosting_minecraft_servers_updated_at
before update on public.hosting_minecraft_servers
for each row execute function public.set_updated_at();

drop trigger if exists tr_hosting_minecraft_worlds_updated_at on public.hosting_minecraft_worlds;
create trigger tr_hosting_minecraft_worlds_updated_at
before update on public.hosting_minecraft_worlds
for each row execute function public.set_updated_at();

alter table public.hosting_minecraft_servers enable row level security;
alter table public.hosting_minecraft_worlds enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    drop policy if exists hosting_minecraft_servers_service_role_all on public.hosting_minecraft_servers;
    create policy hosting_minecraft_servers_service_role_all
      on public.hosting_minecraft_servers for all to service_role
      using (true) with check (true);

    drop policy if exists hosting_minecraft_worlds_service_role_all on public.hosting_minecraft_worlds;
    create policy hosting_minecraft_worlds_service_role_all
      on public.hosting_minecraft_worlds for all to service_role
      using (true) with check (true);
  end if;
end
$$;


-- ============================================================================
-- MIGRATION: 137_hosting_runtime_starting_status.sql
-- ============================================================================

begin;

alter table if exists public.hosting_projects
  drop constraint if exists hosting_projects_runtime_status_check;

alter table if exists public.hosting_projects
  add constraint hosting_projects_runtime_status_check
  check (runtime_status in ('online', 'offline', 'starting', 'restarting', 'deploying', 'crashed', 'suspended', 'unknown'));

commit;


-- ============================================================================
-- MIGRATION: 138_hosting_minecraft_server_ports.sql
-- ============================================================================

begin;

alter table if exists public.hosting_minecraft_servers
  add column if not exists server_port integer,
  add column if not exists rcon_port integer;

update public.hosting_minecraft_servers
set
  server_port = coalesce(server_port, 25565),
  rcon_port = coalesce(rcon_port, 30000)
where server_port is null
   or rcon_port is null;

alter table if exists public.hosting_minecraft_servers
  drop constraint if exists hosting_minecraft_servers_server_port_check,
  add constraint hosting_minecraft_servers_server_port_check
    check (server_port between 25565 and 29999);

alter table if exists public.hosting_minecraft_servers
  drop constraint if exists hosting_minecraft_servers_rcon_port_check,
  add constraint hosting_minecraft_servers_rcon_port_check
    check (rcon_port between 30000 and 34999);

create unique index if not exists idx_hosting_minecraft_servers_server_port
  on public.hosting_minecraft_servers (server_port)
  where server_port is not null;

create unique index if not exists idx_hosting_minecraft_servers_rcon_port
  on public.hosting_minecraft_servers (rcon_port)
  where rcon_port is not null;

commit;


-- ============================================================================
-- MIGRATION: 139_hosting_minecraft_nullable_primary_domain.sql
-- ============================================================================

begin;

alter table if exists public.hosting_minecraft_servers
  alter column primary_domain drop not null;

commit;


-- ============================================================================
-- FINAL AUTH / LOGIN / AVATAR REPAIR
-- ============================================================================

begin;

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.auth_users (
  id bigint generated always as identity primary key,
  discord_user_id text unique,
  google_user_id text,
  microsoft_user_id text,
  username text not null,
  global_name text,
  display_name text not null,
  avatar text,
  profile_avatar_url text,
  profile_avatar_source text,
  profile_avatar_updated_at timestamptz,
  email text,
  email_normalized text,
  email_verified_at timestamptz,
  locale text,
  raw_user jsonb not null default '{}'::jsonb,
  last_login_at timestamptz,
  last_auth_method text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.auth_users
  add column if not exists discord_user_id text,
  add column if not exists google_user_id text,
  add column if not exists microsoft_user_id text,
  add column if not exists username text,
  add column if not exists global_name text,
  add column if not exists display_name text,
  add column if not exists avatar text,
  add column if not exists profile_avatar_url text,
  add column if not exists profile_avatar_source text,
  add column if not exists profile_avatar_updated_at timestamptz,
  add column if not exists email text,
  add column if not exists email_normalized text,
  add column if not exists email_verified_at timestamptz,
  add column if not exists locale text,
  add column if not exists raw_user jsonb not null default '{}'::jsonb,
  add column if not exists last_login_at timestamptz,
  add column if not exists last_auth_method text,
  add column if not exists created_at timestamptz not null default timezone('utc', now()),
  add column if not exists updated_at timestamptz not null default timezone('utc', now());

alter table public.auth_users
  alter column discord_user_id drop not null;

update public.auth_users
set
  email = nullif(lower(trim(email)), ''),
  email_normalized = nullif(lower(trim(email)), '')
where email is not null
  and (
    email is distinct from nullif(lower(trim(email)), '')
    or email_normalized is distinct from nullif(lower(trim(email)), '')
  );

update public.auth_users
set
  username = left(
    coalesce(
      nullif(
        regexp_replace(
          regexp_replace(
            regexp_replace(lower(trim(coalesce(username, display_name, email, 'flowdesk-user'))), '[^a-z0-9._-]+', '-', 'g'),
            '-{2,}',
            '-',
            'g'
          ),
          '^[-._]+|[-._]+$',
          '',
          'g'
        ),
        ''
      ),
      'flowdesk-user'
    ),
    32
  )
where username is null or btrim(username) = '';

update public.auth_users
set display_name = coalesce(nullif(btrim(display_name), ''), username, 'Flowdesk User')
where display_name is null or btrim(display_name) = '';

do $$
declare
  duplicate_record record;
  base_username text;
  candidate_username text;
  suffix_number integer;
begin
  for duplicate_record in
    select id, username
    from (
      select
        id,
        username,
        row_number() over (
          partition by username
          order by id
        ) as duplicate_rank
      from public.auth_users
      where username is not null
    ) duplicated
    where duplicate_rank > 1
    order by id
  loop
    base_username := lower(trim(coalesce(duplicate_record.username, 'flowdesk-user')));
    base_username := regexp_replace(base_username, '[^a-z0-9._-]+', '-', 'g');
    base_username := regexp_replace(base_username, '-{2,}', '-', 'g');
    base_username := regexp_replace(base_username, '^[-._]+|[-._]+$', '', 'g');
    base_username := left(nullif(base_username, ''), 32);

    if base_username is null then
      base_username := 'flowdesk-user';
    end if;

    candidate_username := base_username;
    suffix_number := 2;

    while exists (
      select 1
      from public.auth_users
      where username = candidate_username
        and id <> duplicate_record.id
    ) loop
      candidate_username :=
        left(
          base_username,
          greatest(1, 32 - char_length('-' || suffix_number::text))
        ) || '-' || suffix_number::text;
      suffix_number := suffix_number + 1;
    end loop;

    update public.auth_users
    set username = candidate_username
    where id = duplicate_record.id;
  end loop;
end
$$;

update public.auth_users
set
  profile_avatar_url =
    'https://cdn.discordapp.com/avatars/' || discord_user_id || '/' || avatar ||
    case when avatar like 'a\_%' escape '\' then '.gif?size=512' else '.png?size=512' end,
  profile_avatar_source = 'discord',
  profile_avatar_updated_at = coalesce(updated_at, timezone('utc', now()))
where profile_avatar_url is null
  and discord_user_id is not null
  and avatar is not null;

create unique index if not exists idx_auth_users_username_unique
on public.auth_users (username);

create unique index if not exists idx_auth_users_email_normalized_unique
on public.auth_users (email_normalized)
where email_normalized is not null;

create index if not exists idx_auth_users_discord_user_id_not_null
on public.auth_users (discord_user_id)
where discord_user_id is not null;

create unique index if not exists idx_auth_users_google_user_id_unique
on public.auth_users (google_user_id)
where google_user_id is not null;

create unique index if not exists idx_auth_users_microsoft_user_id_unique
on public.auth_users (microsoft_user_id)
where microsoft_user_id is not null;

drop trigger if exists tr_auth_users_updated_at on public.auth_users;
create trigger tr_auth_users_updated_at
before update on public.auth_users
for each row execute function public.set_updated_at();

create table if not exists public.auth_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.auth_users(id) on delete cascade,
  session_token_hash text not null unique,
  ip_address text,
  user_agent text,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  discord_access_token text,
  discord_refresh_token text,
  discord_token_expires_at timestamptz,
  auth_method text not null default 'email',
  otp_verified_at timestamptz,
  remembered_until timestamptz,
  active_guild_id text,
  discord_guilds_cache jsonb,
  discord_guilds_cached_at timestamptz,
  config_current_step integer,
  config_draft jsonb,
  config_context_updated_at timestamptz,
  last_seen_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now())
);

alter table public.auth_sessions
  add column if not exists discord_access_token text,
  add column if not exists discord_refresh_token text,
  add column if not exists discord_token_expires_at timestamptz,
  add column if not exists auth_method text,
  add column if not exists otp_verified_at timestamptz,
  add column if not exists remembered_until timestamptz,
  add column if not exists active_guild_id text,
  add column if not exists discord_guilds_cache jsonb,
  add column if not exists discord_guilds_cached_at timestamptz,
  add column if not exists config_current_step integer,
  add column if not exists config_draft jsonb,
  add column if not exists config_context_updated_at timestamptz,
  add column if not exists last_seen_at timestamptz;

update public.auth_sessions s
set auth_method = coalesce(
  s.auth_method,
  case
    when s.discord_access_token is not null then 'discord'
    when u.google_user_id is not null and u.discord_user_id is null then 'google'
    when u.microsoft_user_id is not null and u.discord_user_id is null then 'microsoft'
    else 'email'
  end
)
from public.auth_users u
where u.id = s.user_id
  and s.auth_method is null;

update public.auth_sessions
set
  auth_method = coalesce(auth_method, 'email'),
  last_seen_at = coalesce(last_seen_at, created_at, timezone('utc', now()))
where auth_method is null
  or last_seen_at is null;

alter table public.auth_sessions
  alter column auth_method set default 'email',
  alter column last_seen_at set default timezone('utc', now());

alter table public.auth_sessions
  drop constraint if exists auth_sessions_auth_method_check;

alter table public.auth_sessions
  add constraint auth_sessions_auth_method_check
  check (auth_method in ('email', 'discord', 'google', 'microsoft'));

alter table public.auth_sessions
  drop constraint if exists auth_sessions_config_current_step_check;

alter table public.auth_sessions
  add constraint auth_sessions_config_current_step_check
  check (config_current_step is null or config_current_step between 1 and 4);

create index if not exists idx_auth_sessions_user_id
on public.auth_sessions (user_id);

create index if not exists idx_auth_sessions_expires_at
on public.auth_sessions (expires_at);

create index if not exists idx_auth_sessions_revoked_at
on public.auth_sessions (revoked_at);

create index if not exists idx_auth_sessions_discord_token_expires_at
on public.auth_sessions (discord_token_expires_at);

create index if not exists idx_auth_sessions_active_guild_id
on public.auth_sessions (active_guild_id);

create index if not exists idx_auth_sessions_discord_guilds_cached_at
on public.auth_sessions (discord_guilds_cached_at);

create index if not exists idx_auth_sessions_config_current_step
on public.auth_sessions (config_current_step);

create index if not exists idx_auth_sessions_config_context_updated_at
on public.auth_sessions (config_context_updated_at);

create index if not exists idx_auth_sessions_auth_method_expires_at
on public.auth_sessions (auth_method, expires_at desc);

create index if not exists idx_auth_sessions_remembered_until
on public.auth_sessions (remembered_until)
where remembered_until is not null;

create index if not exists idx_auth_sessions_user_activity
on public.auth_sessions (user_id, revoked_at, last_seen_at desc);

create table if not exists public.auth_user_credentials (
  user_id bigint primary key references public.auth_users(id) on delete cascade,
  password_hash text not null,
  password_version integer not null default 1,
  password_set_at timestamptz not null default timezone('utc', now()),
  last_password_login_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_user_credentials_password_hash_length_check
    check (char_length(password_hash) >= 32)
);

drop trigger if exists tr_auth_user_credentials_updated_at on public.auth_user_credentials;
create trigger tr_auth_user_credentials_updated_at
before update on public.auth_user_credentials
for each row execute function public.set_updated_at();

create table if not exists public.auth_email_otp_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.auth_users(id) on delete cascade,
  email text not null,
  email_normalized text not null,
  purpose text not null default 'login',
  code_hash text not null,
  ip_address text,
  user_agent text,
  attempts integer not null default 0,
  max_attempts integer not null default 6,
  resend_count integer not null default 0,
  last_sent_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_email_otp_challenges_attempts_check
    check (attempts >= 0 and attempts <= 50),
  constraint auth_email_otp_challenges_resend_count_check
    check (resend_count >= 0 and resend_count <= 20)
);

alter table public.auth_email_otp_challenges
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.auth_email_otp_challenges
  drop constraint if exists auth_email_otp_challenges_purpose_check;

alter table public.auth_email_otp_challenges
  add constraint auth_email_otp_challenges_purpose_check
  check (purpose in (
    'login',
    'email_registration',
    'email_change_current',
    'email_change_new'
  ));

drop trigger if exists tr_auth_email_otp_challenges_updated_at on public.auth_email_otp_challenges;
create trigger tr_auth_email_otp_challenges_updated_at
before update on public.auth_email_otp_challenges
for each row execute function public.set_updated_at();

create index if not exists idx_auth_email_otp_challenges_user_created_at
on public.auth_email_otp_challenges (user_id, created_at desc);

create index if not exists idx_auth_email_otp_challenges_email_created_at
on public.auth_email_otp_challenges (email_normalized, created_at desc);

create index if not exists idx_auth_email_otp_challenges_expires_at
on public.auth_email_otp_challenges (expires_at);

create index if not exists idx_auth_email_otp_challenges_active
on public.auth_email_otp_challenges (email_normalized, expires_at desc)
where consumed_at is null;

create index if not exists idx_auth_email_otp_challenges_active_user_purpose
on public.auth_email_otp_challenges (user_id, purpose, expires_at desc)
where consumed_at is null;

create table if not exists public.auth_user_trusted_devices (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.auth_users(id) on delete cascade,
  token_hash text not null unique,
  user_agent_hash text,
  last_used_at timestamptz,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_user_trusted_devices_token_hash_length_check
    check (char_length(token_hash) >= 32)
);

alter table public.auth_user_trusted_devices
  add column if not exists user_agent_hash text,
  add column if not exists last_used_at timestamptz,
  add column if not exists revoked_at timestamptz;

drop trigger if exists tr_auth_user_trusted_devices_updated_at on public.auth_user_trusted_devices;
create trigger tr_auth_user_trusted_devices_updated_at
before update on public.auth_user_trusted_devices
for each row execute function public.set_updated_at();

create index if not exists idx_auth_user_trusted_devices_user_expires_at
on public.auth_user_trusted_devices (user_id, expires_at desc);

create index if not exists idx_auth_user_trusted_devices_active
on public.auth_user_trusted_devices (user_id, expires_at desc)
where revoked_at is null;

create table if not exists public.auth_account_email_changes (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.auth_users(id) on delete cascade,
  current_email text,
  new_email text not null,
  new_email_normalized text not null,
  current_challenge_id uuid references public.auth_email_otp_challenges(id) on delete set null,
  new_challenge_id uuid references public.auth_email_otp_challenges(id) on delete set null,
  current_verified_at timestamptz,
  new_verified_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists tr_auth_account_email_changes_updated_at on public.auth_account_email_changes;
create trigger tr_auth_account_email_changes_updated_at
before update on public.auth_account_email_changes
for each row execute function public.set_updated_at();

create unique index if not exists idx_auth_account_email_changes_active_user
on public.auth_account_email_changes (user_id)
where completed_at is null and cancelled_at is null;

create unique index if not exists idx_auth_account_email_changes_active_email
on public.auth_account_email_changes (new_email_normalized)
where completed_at is null and cancelled_at is null;

create index if not exists idx_auth_account_email_changes_expires_at
on public.auth_account_email_changes (expires_at);

create table if not exists public.auth_user_provider_profiles (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  provider text not null check (provider in ('discord', 'google', 'microsoft', 'github')),
  provider_user_id text not null,
  provider_email text,
  provider_display_name text,
  provider_avatar_url text,
  linked_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, provider),
  unique (provider, provider_user_id)
);

drop trigger if exists tr_auth_user_provider_profiles_updated_at on public.auth_user_provider_profiles;
create trigger tr_auth_user_provider_profiles_updated_at
before update on public.auth_user_provider_profiles
for each row execute function public.set_updated_at();

create index if not exists idx_auth_user_provider_profiles_user
on public.auth_user_provider_profiles (user_id, provider);

create table if not exists public.auth_user_totp (
  user_id bigint primary key references public.auth_users(id) on delete cascade,
  secret_encrypted text not null,
  enabled boolean not null default false,
  verified_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists tr_auth_user_totp_updated_at on public.auth_user_totp;
create trigger tr_auth_user_totp_updated_at
before update on public.auth_user_totp
for each row execute function public.set_updated_at();

create table if not exists public.auth_user_passkeys (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.auth_users(id) on delete cascade,
  credential_id text not null unique,
  public_key text not null,
  counter bigint not null default 0,
  transports text[] not null default '{}'::text[],
  device_type text,
  backed_up boolean not null default false,
  name text not null default 'Passkey',
  last_used_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists tr_auth_user_passkeys_updated_at on public.auth_user_passkeys;
create trigger tr_auth_user_passkeys_updated_at
before update on public.auth_user_passkeys
for each row execute function public.set_updated_at();

create index if not exists idx_auth_user_passkeys_user_created_at
on public.auth_user_passkeys (user_id, created_at desc);

create table if not exists public.auth_security_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.auth_users(id) on delete cascade,
  kind text not null,
  challenge text not null,
  metadata jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

alter table public.auth_security_challenges
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.auth_security_challenges
  drop constraint if exists auth_security_challenges_kind_check;

alter table public.auth_security_challenges
  add constraint auth_security_challenges_kind_check
  check (kind in (
    'passkey_registration',
    'passkey_authentication',
    'two_factor_login',
    'sensitive_action'
  ));

create index if not exists idx_auth_security_challenges_active
on public.auth_security_challenges (user_id, kind, expires_at desc)
where consumed_at is null;

create index if not exists idx_auth_security_challenges_sensitive_action
on public.auth_security_challenges (user_id, expires_at desc)
where kind = 'sensitive_action' and consumed_at is null;

alter table public.auth_users enable row level security;
alter table public.auth_sessions enable row level security;
alter table public.auth_user_credentials enable row level security;
alter table public.auth_email_otp_challenges enable row level security;
alter table public.auth_user_trusted_devices enable row level security;
alter table public.auth_account_email_changes enable row level security;
alter table public.auth_user_provider_profiles enable row level security;
alter table public.auth_user_totp enable row level security;
alter table public.auth_user_passkeys enable row level security;
alter table public.auth_security_challenges enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    drop policy if exists "service_role_all_auth_users" on public.auth_users;
    create policy "service_role_all_auth_users"
      on public.auth_users for all to service_role
      using (true) with check (true);

    drop policy if exists "service_role_all_auth_sessions" on public.auth_sessions;
    create policy "service_role_all_auth_sessions"
      on public.auth_sessions for all to service_role
      using (true) with check (true);

    drop policy if exists "service_role_all_auth_user_credentials" on public.auth_user_credentials;
    create policy "service_role_all_auth_user_credentials"
      on public.auth_user_credentials for all to service_role
      using (true) with check (true);

    drop policy if exists "service_role_all_auth_email_otp_challenges" on public.auth_email_otp_challenges;
    create policy "service_role_all_auth_email_otp_challenges"
      on public.auth_email_otp_challenges for all to service_role
      using (true) with check (true);

    drop policy if exists "service_role_all_auth_user_trusted_devices" on public.auth_user_trusted_devices;
    create policy "service_role_all_auth_user_trusted_devices"
      on public.auth_user_trusted_devices for all to service_role
      using (true) with check (true);

    drop policy if exists auth_account_email_changes_service_role_all on public.auth_account_email_changes;
    create policy auth_account_email_changes_service_role_all
      on public.auth_account_email_changes for all to service_role
      using (true) with check (true);

    drop policy if exists auth_user_provider_profiles_service_role_all on public.auth_user_provider_profiles;
    create policy auth_user_provider_profiles_service_role_all
      on public.auth_user_provider_profiles for all to service_role
      using (true) with check (true);

    drop policy if exists auth_user_totp_service_role_all on public.auth_user_totp;
    create policy auth_user_totp_service_role_all
      on public.auth_user_totp for all to service_role
      using (true) with check (true);

    drop policy if exists auth_user_passkeys_service_role_all on public.auth_user_passkeys;
    create policy auth_user_passkeys_service_role_all
      on public.auth_user_passkeys for all to service_role
      using (true) with check (true);

    drop policy if exists auth_security_challenges_service_role_all on public.auth_security_challenges;
    create policy auth_security_challenges_service_role_all
      on public.auth_security_challenges for all to service_role
      using (true) with check (true);
  end if;
end
$$;

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'account-avatars',
      'account-avatars',
      true,
      5242880,
      array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
    )
    on conflict (id) do update
    set
      public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
  end if;
end
$$;

commit;


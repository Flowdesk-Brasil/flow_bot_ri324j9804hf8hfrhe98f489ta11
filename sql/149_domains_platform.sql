-- Flowdesk — Sistema completo de domínios
-- Dependência: public.auth_users
-- As APIs usam supabaseAdmin (service_role). Não use auth.uid() nestas tabelas.
--
-- Como aplicar (Supabase SQL Editor):
--   1. Cole e execute este arquivo inteiro
--   2. Aguarde ~10s para o schema cache atualizar (ou Settings > API > Reload schema)
--
-- Ordem histórica substituída por este arquivo:
--   site/sql/admin/004_domains.sql
--   site/sql/admin/005_domain_multi_provider.sql
--   sql/133_domain_multi_provider_platform.sql

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

do $$
begin
  if to_regclass('public.auth_users') is null then
    raise exception 'Pre-requisito ausente: public.auth_users.';
  end if;
end
$$;

-- ─── 1. Contatos do titular ───────────────────────────────────────────────────
create table if not exists public.domain_contacts (
  id                   uuid primary key default gen_random_uuid(),
  auth_user_id         bigint not null references public.auth_users(id) on delete cascade,
  full_name            text not null,
  email                text not null,
  phone                text not null,
  street               text not null,
  city                 text not null,
  state                text not null,
  postal_code          text not null,
  country              text not null default 'BR',
  document_type        text not null check (document_type in ('cpf', 'cnpj', 'passport', 'none')),
  document_hash        text,
  document_last4       text,
  document_encrypted   text,
  provider             text not null default 'openprovider',
  provider_contact_id  text,
  verification_status  text not null default 'pending'
                         check (verification_status in ('pending', 'verified', 'failed')),
  created_at           timestamptz not null default timezone('utc', now()),
  updated_at           timestamptz not null default timezone('utc', now())
);

alter table public.domain_contacts add column if not exists document_encrypted text;
alter table public.domain_contacts alter column provider set default 'openprovider';

-- ─── 2. Cotações ──────────────────────────────────────────────────────────────
create table if not exists public.domain_quotes (
  id                    uuid primary key default gen_random_uuid(),
  auth_user_id          bigint not null references public.auth_users(id) on delete cascade,
  fqdn                  text not null,
  tld                   text not null,
  operation             text not null check (operation in ('register', 'renew', 'transfer', 'restore')),
  period_years          smallint not null default 1,
  provider              text not null default 'openprovider',
  provider_cost         numeric(12,4),
  provider_currency     text not null default 'USD',
  exchange_rate_to_brl  numeric(12,6),
  provider_cost_usd     numeric(10,4) not null,
  exchange_rate_usd_brl numeric(10,4) not null,
  markup_percent        numeric(5,2) not null,
  subtotal_brl          numeric(10,2) not null,
  total_brl             numeric(10,2) not null,
  is_premium            boolean not null default false,
  is_accepted           boolean not null default false,
  provider_attempts     jsonb not null default '[]'::jsonb,
  accepted_at           timestamptz,
  expires_at            timestamptz not null default (timezone('utc', now()) + interval '20 minutes'),
  created_at            timestamptz not null default timezone('utc', now())
);

alter table public.domain_quotes add column if not exists provider text;
alter table public.domain_quotes add column if not exists provider_cost numeric(12,4);
alter table public.domain_quotes add column if not exists provider_currency text;
alter table public.domain_quotes add column if not exists exchange_rate_to_brl numeric(12,6);
alter table public.domain_quotes add column if not exists provider_attempts jsonb;

update public.domain_quotes
set
  provider = coalesce(nullif(trim(provider), ''), 'openprovider'),
  provider_currency = coalesce(nullif(trim(provider_currency), ''), 'USD'),
  provider_cost = coalesce(provider_cost, provider_cost_usd),
  exchange_rate_to_brl = coalesce(exchange_rate_to_brl, exchange_rate_usd_brl),
  provider_attempts = coalesce(provider_attempts, '[]'::jsonb)
where provider is null
   or provider_cost is null
   or exchange_rate_to_brl is null
   or provider_attempts is null;

alter table public.domain_quotes alter column provider set default 'openprovider';
alter table public.domain_quotes alter column provider_currency set default 'USD';

-- ─── 3. Domínios ──────────────────────────────────────────────────────────────
create table if not exists public.domains (
  id                    uuid primary key default gen_random_uuid(),
  auth_user_id          bigint not null references public.auth_users(id) on delete cascade,
  fqdn                  text not null,
  sld                   text not null,
  tld                   text not null,
  provider              text not null default 'openprovider',
  provider_domain_id    text,
  registrant_contact_id uuid references public.domain_contacts(id) on delete set null,
  quote_id              uuid references public.domain_quotes(id) on delete set null,
  status                text not null default 'draft'
                          check (status in (
                            'draft', 'quote_created', 'payment_pending',
                            'registration_requested', 'registration_pending',
                            'active', 'action_required', 'suspended',
                            'client_hold', 'server_hold', 'expired',
                            'redemption', 'pending_delete',
                            'transfer_in_pending', 'transfer_out_pending',
                            'failed', 'cancelled'
                          )),
  registration_period   smallint not null default 1,
  auto_renew            boolean not null default true,
  transfer_lock         boolean not null default true,
  privacy_enabled       boolean not null default false,
  dnssec_enabled        boolean not null default false,
  registered_at         timestamptz,
  expiration_date       timestamptz,
  nameservers           text[],
  flowdesk_managed_dns  boolean not null default false,
  current_dns_provider  text,
  purchase_price_brl    numeric(10,2),
  renewal_price_brl     numeric(10,2),
  provider_cost         numeric(12,4),
  provider_currency     text,
  provider_cost_usd     numeric(10,4),
  markup_percent        numeric(5,2) not null default 20,
  provider_attempts     jsonb not null default '[]'::jsonb,
  cloudflare_zone_id    text,
  cloudflare_zone_status text,
  cloudflare_dnssec     jsonb,
  domain_type           text not null default 'registered'
                          check (domain_type in ('registered', 'transferred', 'external', 'pending')),
  payment_order_id      bigint,
  idempotency_key       text unique,
  last_synced_at        timestamptz,
  created_at            timestamptz not null default timezone('utc', now()),
  updated_at            timestamptz not null default timezone('utc', now()),
  unique (auth_user_id, fqdn)
);

alter table public.domains add column if not exists quote_id uuid;
alter table public.domains add column if not exists provider_cost numeric(12,4);
alter table public.domains add column if not exists provider_currency text;
alter table public.domains add column if not exists provider_attempts jsonb;
alter table public.domains add column if not exists cloudflare_zone_id text;
alter table public.domains add column if not exists cloudflare_zone_status text;
alter table public.domains add column if not exists cloudflare_dnssec jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'domains_quote_id_fkey'
      and conrelid = 'public.domains'::regclass
  ) then
    alter table public.domains
      add constraint domains_quote_id_fkey
      foreign key (quote_id) references public.domain_quotes(id) on delete set null;
  end if;
end
$$;

alter table public.domains alter column provider set default 'openprovider';
alter table public.domains alter column markup_percent set default 20;
update public.domains set markup_percent = 20 where markup_percent = 22.5;

-- ─── 4. Eventos ───────────────────────────────────────────────────────────────
create table if not exists public.domain_events (
  id            uuid primary key default gen_random_uuid(),
  domain_id     uuid references public.domains(id) on delete cascade,
  auth_user_id  bigint references public.auth_users(id) on delete set null,
  event_type    text not null,
  payload       jsonb not null default '{}'::jsonb,
  provider_ref  text,
  created_at    timestamptz not null default timezone('utc', now())
);

-- ─── 5. Transferências ────────────────────────────────────────────────────────
create table if not exists public.domain_transfers (
  id                   uuid primary key default gen_random_uuid(),
  domain_id            uuid references public.domains(id) on delete set null,
  auth_user_id         bigint not null references public.auth_users(id) on delete cascade,
  fqdn                 text not null,
  direction            text not null check (direction in ('in', 'out')),
  status               text not null default 'initiated'
                         check (status in (
                           'initiated', 'waiting_auth_code', 'waiting_unlock',
                           'waiting_payment', 'submitted_to_provider',
                           'waiting_previous_registrar', 'action_required',
                           'completed', 'failed', 'cancelled'
                         )),
  provider             text,
  contact_id           uuid references public.domain_contacts(id) on delete set null,
  auth_code_hash       text,
  auth_code_encrypted  text,
  provider_ref         text,
  quote_id             uuid references public.domain_quotes(id) on delete set null,
  payment_order_id     bigint,
  idempotency_key      text unique,
  provider_attempts    jsonb not null default '[]'::jsonb,
  error_message        text,
  initiated_at         timestamptz not null default timezone('utc', now()),
  completed_at         timestamptz,
  updated_at           timestamptz not null default timezone('utc', now())
);

alter table public.domain_transfers add column if not exists provider text;
alter table public.domain_transfers add column if not exists contact_id uuid;
alter table public.domain_transfers add column if not exists auth_code_encrypted text;
alter table public.domain_transfers add column if not exists provider_attempts jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'domain_transfers_contact_id_fkey'
      and conrelid = 'public.domain_transfers'::regclass
  ) then
    alter table public.domain_transfers
      add constraint domain_transfers_contact_id_fkey
      foreign key (contact_id) references public.domain_contacts(id) on delete set null;
  end if;
end
$$;

-- ─── 6. DNS ───────────────────────────────────────────────────────────────────
create table if not exists public.domain_dns_records (
  id               uuid primary key default gen_random_uuid(),
  domain_id        uuid not null references public.domains(id) on delete cascade,
  auth_user_id     bigint not null references public.auth_users(id) on delete cascade,
  record_type      text not null check (record_type in ('A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA', 'PTR')),
  name             text not null,
  value            text not null,
  ttl              integer not null default 3600,
  priority         integer,
  proxied          boolean not null default false,
  provider_dns_id  text,
  dns_provider     text not null default 'cloudflare',
  created_at       timestamptz not null default timezone('utc', now()),
  updated_at       timestamptz not null default timezone('utc', now())
);

alter table public.domain_dns_records add column if not exists proxied boolean;
update public.domain_dns_records set proxied = false where proxied is null;
alter table public.domain_dns_records alter column dns_provider set default 'cloudflare';

-- ─── 7. Ledger ────────────────────────────────────────────────────────────────
create table if not exists public.domain_ledger (
  id                    uuid primary key default gen_random_uuid(),
  domain_id             uuid references public.domains(id) on delete set null,
  auth_user_id          bigint not null references public.auth_users(id) on delete cascade,
  event_type            text not null
                          check (event_type in (
                            'registration', 'renewal', 'transfer_in', 'transfer_out',
                            'restore', 'privacy', 'refund', 'chargeback',
                            'failed_payment', 'credit'
                          )),
  fqdn                  text not null,
  provider_cost         numeric(12,4),
  provider_currency     text,
  exchange_rate_to_brl  numeric(12,6),
  provider_cost_usd     numeric(10,4),
  exchange_rate_usd_brl numeric(10,4),
  markup_percent        numeric(5,2),
  amount_brl            numeric(10,2) not null,
  payment_order_id      bigint,
  quote_id              uuid references public.domain_quotes(id) on delete set null,
  status                text not null default 'pending'
                          check (status in ('pending', 'confirmed', 'refunded', 'cancelled')),
  notes                 text,
  created_at            timestamptz not null default timezone('utc', now())
);

alter table public.domain_ledger add column if not exists provider_cost numeric(12,4);
alter table public.domain_ledger add column if not exists provider_currency text;
alter table public.domain_ledger add column if not exists exchange_rate_to_brl numeric(12,6);

-- ─── 8. Alertas de expiração ──────────────────────────────────────────────────
create table if not exists public.domain_expiration_alerts (
  id            uuid primary key default gen_random_uuid(),
  domain_id     uuid not null references public.domains(id) on delete cascade,
  auth_user_id  bigint not null references public.auth_users(id) on delete cascade,
  alert_type    text not null check (alert_type in ('30d', '14d', '7d', '3d', '1d', 'expired')),
  sent_at       timestamptz not null default timezone('utc', now()),
  channel       text not null default 'email' check (channel in ('email', 'in_app', 'webhook')),
  unique (domain_id, alert_type, channel)
);

-- ─── 9. Índices ───────────────────────────────────────────────────────────────
create index if not exists idx_domain_contacts_auth_user_id
  on public.domain_contacts (auth_user_id);

create index if not exists idx_domain_quotes_auth_user_id
  on public.domain_quotes (auth_user_id, created_at desc);

create index if not exists idx_domain_quotes_fqdn
  on public.domain_quotes (fqdn, created_at desc);

create index if not exists idx_domain_quotes_provider_created_at
  on public.domain_quotes (provider, created_at desc);

create index if not exists idx_domain_quotes_fqdn_provider_created
  on public.domain_quotes (fqdn, provider, created_at desc);

create index if not exists idx_domains_auth_user_id
  on public.domains (auth_user_id, created_at desc);

create index if not exists idx_domains_fqdn
  on public.domains (fqdn);

create index if not exists idx_domains_status
  on public.domains (status, expiration_date);

create index if not exists idx_domains_expiration
  on public.domains (expiration_date asc)
  where status = 'active';

create index if not exists idx_domains_idempotency_key
  on public.domains (idempotency_key)
  where idempotency_key is not null;

create unique index if not exists idx_domains_cloudflare_zone_id
  on public.domains (cloudflare_zone_id)
  where cloudflare_zone_id is not null;

create index if not exists idx_domain_events_domain_id
  on public.domain_events (domain_id, created_at desc);

create index if not exists idx_domain_events_auth_user_id
  on public.domain_events (auth_user_id, created_at desc);

create index if not exists idx_domain_transfers_auth_user_id
  on public.domain_transfers (auth_user_id, initiated_at desc);

create index if not exists idx_domain_transfers_domain_id
  on public.domain_transfers (domain_id, direction, status);

create index if not exists idx_domain_transfers_provider_status
  on public.domain_transfers (provider, status, updated_at);

create index if not exists idx_domain_transfers_contact_status_updated
  on public.domain_transfers (contact_id, status, updated_at desc)
  where contact_id is not null;

create index if not exists idx_domain_dns_records_domain_id
  on public.domain_dns_records (domain_id);

create index if not exists idx_domain_ledger_auth_user_id
  on public.domain_ledger (auth_user_id, created_at desc);

create index if not exists idx_domain_ledger_domain_id
  on public.domain_ledger (domain_id, created_at desc);

-- ─── 10. Triggers ─────────────────────────────────────────────────────────────
drop trigger if exists tr_domain_contacts_updated_at on public.domain_contacts;
create trigger tr_domain_contacts_updated_at
before update on public.domain_contacts
for each row execute function public.set_updated_at();

drop trigger if exists tr_domains_updated_at on public.domains;
create trigger tr_domains_updated_at
before update on public.domains
for each row execute function public.set_updated_at();

drop trigger if exists tr_domain_transfers_updated_at on public.domain_transfers;
create trigger tr_domain_transfers_updated_at
before update on public.domain_transfers
for each row execute function public.set_updated_at();

drop trigger if exists tr_domain_dns_records_updated_at on public.domain_dns_records;
create trigger tr_domain_dns_records_updated_at
before update on public.domain_dns_records
for each row execute function public.set_updated_at();

-- ─── 11. RLS + grants (somente service_role) ──────────────────────────────────
alter table public.domain_contacts enable row level security;
alter table public.domain_quotes enable row level security;
alter table public.domains enable row level security;
alter table public.domain_events enable row level security;
alter table public.domain_transfers enable row level security;
alter table public.domain_dns_records enable row level security;
alter table public.domain_ledger enable row level security;
alter table public.domain_expiration_alerts enable row level security;

drop policy if exists service_role_all_domain_contacts on public.domain_contacts;
create policy service_role_all_domain_contacts
on public.domain_contacts for all to service_role using (true) with check (true);

drop policy if exists service_role_all_domain_quotes on public.domain_quotes;
create policy service_role_all_domain_quotes
on public.domain_quotes for all to service_role using (true) with check (true);

drop policy if exists service_role_all_domains on public.domains;
create policy service_role_all_domains
on public.domains for all to service_role using (true) with check (true);

drop policy if exists service_role_all_domain_events on public.domain_events;
create policy service_role_all_domain_events
on public.domain_events for all to service_role using (true) with check (true);

drop policy if exists service_role_all_domain_transfers on public.domain_transfers;
create policy service_role_all_domain_transfers
on public.domain_transfers for all to service_role using (true) with check (true);

drop policy if exists service_role_all_domain_dns_records on public.domain_dns_records;
create policy service_role_all_domain_dns_records
on public.domain_dns_records for all to service_role using (true) with check (true);

drop policy if exists service_role_all_domain_ledger on public.domain_ledger;
create policy service_role_all_domain_ledger
on public.domain_ledger for all to service_role using (true) with check (true);

drop policy if exists service_role_all_domain_expiration_alerts on public.domain_expiration_alerts;
create policy service_role_all_domain_expiration_alerts
on public.domain_expiration_alerts for all to service_role using (true) with check (true);

revoke all on table public.domain_contacts from public, anon, authenticated;
revoke all on table public.domain_quotes from public, anon, authenticated;
revoke all on table public.domains from public, anon, authenticated;
revoke all on table public.domain_events from public, anon, authenticated;
revoke all on table public.domain_transfers from public, anon, authenticated;
revoke all on table public.domain_dns_records from public, anon, authenticated;
revoke all on table public.domain_ledger from public, anon, authenticated;
revoke all on table public.domain_expiration_alerts from public, anon, authenticated;

grant all on table public.domain_contacts to service_role;
grant all on table public.domain_quotes to service_role;
grant all on table public.domains to service_role;
grant all on table public.domain_events to service_role;
grant all on table public.domain_transfers to service_role;
grant all on table public.domain_dns_records to service_role;
grant all on table public.domain_ledger to service_role;
grant all on table public.domain_expiration_alerts to service_role;

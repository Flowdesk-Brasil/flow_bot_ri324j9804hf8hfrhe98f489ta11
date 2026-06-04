-- Flowdesk domains: Openprovider -> Spaceship -> Hover/OpenSRS + Cloudflare DNS.
-- Apply after site/sql/admin/004_domains.sql.

alter table public.domain_contacts
  add column if not exists document_encrypted text;

alter table public.domain_contacts
  alter column provider set default 'openprovider';

alter table public.domain_quotes
  add column if not exists provider text not null default 'openprovider',
  add column if not exists provider_cost numeric(12,4),
  add column if not exists provider_currency text not null default 'USD',
  add column if not exists exchange_rate_to_brl numeric(12,6),
  add column if not exists provider_attempts jsonb not null default '[]'::jsonb;

update public.domain_quotes
set provider_cost = coalesce(provider_cost, provider_cost_usd),
    exchange_rate_to_brl = coalesce(exchange_rate_to_brl, exchange_rate_usd_brl)
where provider_cost is null or exchange_rate_to_brl is null;

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

alter table public.domain_transfers
  add column if not exists provider text,
  add column if not exists contact_id uuid references public.domain_contacts(id) on delete set null,
  add column if not exists auth_code_encrypted text,
  add column if not exists provider_attempts jsonb not null default '[]'::jsonb;

alter table public.domain_dns_records
  add column if not exists proxied boolean not null default false;

alter table public.domain_dns_records
  alter column dns_provider set default 'cloudflare';

alter table public.domain_ledger
  add column if not exists provider_cost numeric(12,4),
  add column if not exists provider_currency text,
  add column if not exists exchange_rate_to_brl numeric(12,6);

create unique index if not exists idx_domains_cloudflare_zone_id
  on public.domains (cloudflare_zone_id)
  where cloudflare_zone_id is not null;

create index if not exists idx_domain_transfers_provider_status
  on public.domain_transfers (provider, status, updated_at);

create index if not exists idx_domain_quotes_provider_created_at
  on public.domain_quotes (provider, created_at desc);

update public.domains set markup_percent = 20 where markup_percent = 22.5;

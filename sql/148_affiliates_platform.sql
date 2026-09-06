-- Sistema de afiliados Flowdesk
-- Dependencia: public.auth_users ja precisa existir.
-- As APIs usam supabaseAdmin (service_role). Nao use auth.uid() nestas tabelas.

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

-- 1. Perfil do afiliado
create table if not exists public.affiliates (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.auth_users(id) on delete cascade,
  affiliate_id text not null,
  level text not null default 'bronze',
  balance_available numeric(12, 2) not null default 0.00,
  balance_pending numeric(12, 2) not null default 0.00,
  total_earned numeric(12, 2) not null default 0.00,
  coupon_code text,
  whatsapp_group_url text,
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint affiliates_affiliate_id_key unique (affiliate_id),
  constraint affiliates_user_id_key unique (user_id),
  constraint affiliates_coupon_code_key unique (coupon_code),
  constraint affiliates_level_check
    check (level in ('bronze', 'silver', 'gold', 'diamond')),
  constraint affiliates_balance_available_check check (balance_available >= 0),
  constraint affiliates_balance_pending_check check (balance_pending >= 0),
  constraint affiliates_total_earned_check check (total_earned >= 0)
);

alter table public.affiliates add column if not exists user_id bigint;
alter table public.affiliates add column if not exists affiliate_id text;
alter table public.affiliates add column if not exists level text;
alter table public.affiliates add column if not exists balance_available numeric(12, 2);
alter table public.affiliates add column if not exists balance_pending numeric(12, 2);
alter table public.affiliates add column if not exists total_earned numeric(12, 2);
alter table public.affiliates add column if not exists coupon_code text;
alter table public.affiliates add column if not exists whatsapp_group_url text;
alter table public.affiliates add column if not exists is_active boolean;
alter table public.affiliates add column if not exists created_at timestamptz;
alter table public.affiliates add column if not exists updated_at timestamptz;

update public.affiliates
set
  level = coalesce(nullif(trim(level), ''), 'bronze'),
  balance_available = coalesce(balance_available, 0),
  balance_pending = coalesce(balance_pending, 0),
  total_earned = coalesce(total_earned, 0),
  is_active = coalesce(is_active, true),
  created_at = coalesce(created_at, timezone('utc', now())),
  updated_at = coalesce(updated_at, timezone('utc', now()));

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'affiliates_user_id_fkey'
      and conrelid = 'public.affiliates'::regclass
  ) then
    alter table public.affiliates
      add constraint affiliates_user_id_fkey
      foreign key (user_id) references public.auth_users(id) on delete cascade;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'affiliates_user_id_key'
      and conrelid = 'public.affiliates'::regclass
  ) then
    alter table public.affiliates
      add constraint affiliates_user_id_key unique (user_id);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'affiliates_affiliate_id_key'
      and conrelid = 'public.affiliates'::regclass
  ) then
    alter table public.affiliates
      add constraint affiliates_affiliate_id_key unique (affiliate_id);
  end if;
end
$$;

-- 2. Links
create table if not exists public.affiliate_links (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates(id) on delete cascade,
  plan_slug text not null,
  period text not null,
  short_url text not null,
  target_url text not null,
  clicks_count integer not null default 0,
  conversions_count integer not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  constraint affiliate_links_short_url_key unique (short_url),
  constraint affiliate_links_plan_period_key unique (affiliate_id, plan_slug, period),
  constraint affiliate_links_plan_slug_check
    check (plan_slug in ('basic', 'pro', 'enterprise')),
  constraint affiliate_links_period_check
    check (period in ('monthly', 'annual')),
  constraint affiliate_links_clicks_count_check check (clicks_count >= 0),
  constraint affiliate_links_conversions_count_check check (conversions_count >= 0)
);

alter table public.affiliate_links add column if not exists affiliate_id uuid;
alter table public.affiliate_links add column if not exists plan_slug text;
alter table public.affiliate_links add column if not exists period text;
alter table public.affiliate_links add column if not exists short_url text;
alter table public.affiliate_links add column if not exists target_url text;
alter table public.affiliate_links add column if not exists clicks_count integer;
alter table public.affiliate_links add column if not exists conversions_count integer;
alter table public.affiliate_links add column if not exists created_at timestamptz;

update public.affiliate_links
set
  clicks_count = coalesce(clicks_count, 0),
  conversions_count = coalesce(conversions_count, 0),
  created_at = coalesce(created_at, timezone('utc', now()));

-- 3. Conversoes / comissoes
create table if not exists public.affiliate_conversions (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates(id) on delete cascade,
  link_id uuid references public.affiliate_links(id) on delete set null,
  customer_email text,
  order_id text,
  plan_slug text not null,
  amount_total numeric(12, 2) not null,
  commission_amount numeric(12, 2) not null,
  status text not null default 'pending',
  conversion_date timestamptz not null default timezone('utc', now()),
  payout_date timestamptz,
  constraint affiliate_conversions_order_id_key unique (order_id),
  constraint affiliate_conversions_status_check
    check (status in ('pending', 'approved', 'cancelled')),
  constraint affiliate_conversions_amount_total_check check (amount_total >= 0),
  constraint affiliate_conversions_commission_amount_check check (commission_amount >= 0)
);

alter table public.affiliate_conversions add column if not exists affiliate_id uuid;
alter table public.affiliate_conversions add column if not exists link_id uuid;
alter table public.affiliate_conversions add column if not exists customer_email text;
alter table public.affiliate_conversions add column if not exists order_id text;
alter table public.affiliate_conversions add column if not exists plan_slug text;
alter table public.affiliate_conversions add column if not exists amount_total numeric(12, 2);
alter table public.affiliate_conversions add column if not exists commission_amount numeric(12, 2);
alter table public.affiliate_conversions add column if not exists status text;
alter table public.affiliate_conversions add column if not exists conversion_date timestamptz;
alter table public.affiliate_conversions add column if not exists payout_date timestamptz;

update public.affiliate_conversions
set
  status = coalesce(nullif(trim(status), ''), 'pending'),
  conversion_date = coalesce(conversion_date, timezone('utc', now()));

-- 4. Saques
create table if not exists public.affiliate_withdrawals (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates(id) on delete cascade,
  amount numeric(12, 2) not null,
  pix_key text not null,
  status text not null default 'pending',
  notes text,
  processed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  constraint affiliate_withdrawals_status_check
    check (status in ('pending', 'processing', 'processed', 'paid', 'rejected')),
  constraint affiliate_withdrawals_amount_check check (amount > 0)
);

alter table public.affiliate_withdrawals add column if not exists affiliate_id uuid;
alter table public.affiliate_withdrawals add column if not exists amount numeric(12, 2);
alter table public.affiliate_withdrawals add column if not exists pix_key text;
alter table public.affiliate_withdrawals add column if not exists status text;
alter table public.affiliate_withdrawals add column if not exists notes text;
alter table public.affiliate_withdrawals add column if not exists processed_at timestamptz;
alter table public.affiliate_withdrawals add column if not exists created_at timestamptz;

update public.affiliate_withdrawals
set
  status = coalesce(nullif(trim(status), ''), 'pending'),
  created_at = coalesce(created_at, timezone('utc', now()));

-- 5. Notificacoes / webhook
create table if not exists public.affiliate_settings (
  affiliate_id uuid primary key references public.affiliates(id) on delete cascade,
  webhook_url text,
  notify_email boolean not null default true,
  notify_sms boolean not null default false,
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.affiliate_settings add column if not exists webhook_url text;
alter table public.affiliate_settings add column if not exists notify_email boolean;
alter table public.affiliate_settings add column if not exists notify_sms boolean;
alter table public.affiliate_settings add column if not exists updated_at timestamptz;

update public.affiliate_settings
set
  notify_email = coalesce(notify_email, true),
  notify_sms = coalesce(notify_sms, false),
  updated_at = coalesce(updated_at, timezone('utc', now()));

-- 6. Indices das queries reais
create index if not exists idx_affiliates_user_id
  on public.affiliates (user_id);

create index if not exists idx_affiliates_is_active
  on public.affiliates (is_active);

create index if not exists idx_affiliate_links_affiliate_id
  on public.affiliate_links (affiliate_id, created_at desc);

create index if not exists idx_affiliate_conversions_affiliate_id
  on public.affiliate_conversions (affiliate_id, conversion_date desc);

create index if not exists idx_affiliate_conversions_status_date
  on public.affiliate_conversions (status, conversion_date desc);

create index if not exists idx_affiliate_conversions_link_id
  on public.affiliate_conversions (link_id);

create index if not exists idx_affiliate_withdrawals_affiliate_id
  on public.affiliate_withdrawals (affiliate_id, created_at desc);

create index if not exists idx_affiliate_withdrawals_status
  on public.affiliate_withdrawals (status);

-- 7. updated_at
drop trigger if exists tr_affiliates_updated_at on public.affiliates;
create trigger tr_affiliates_updated_at
before update on public.affiliates
for each row
execute function public.set_updated_at();

drop trigger if exists tr_affiliate_settings_updated_at on public.affiliate_settings;
create trigger tr_affiliate_settings_updated_at
before update on public.affiliate_settings
for each row
execute function public.set_updated_at();

-- 8. RLS: so service_role (supabaseAdmin)
alter table public.affiliates enable row level security;
alter table public.affiliate_links enable row level security;
alter table public.affiliate_conversions enable row level security;
alter table public.affiliate_withdrawals enable row level security;
alter table public.affiliate_settings enable row level security;

drop policy if exists "Afiliados podem ver seu próprio perfil" on public.affiliates;
drop policy if exists "Afiliados podem ver seus próprios links" on public.affiliate_links;
drop policy if exists "Afiliados podem ver suas conversões" on public.affiliate_conversions;
drop policy if exists "Afiliados podem ver seus saques" on public.affiliate_withdrawals;
drop policy if exists "Afiliados podem gerenciar seu webhook" on public.affiliate_settings;

drop policy if exists service_role_all_affiliates on public.affiliates;
create policy service_role_all_affiliates
on public.affiliates
for all
to service_role
using (true)
with check (true);

drop policy if exists service_role_all_affiliate_links on public.affiliate_links;
create policy service_role_all_affiliate_links
on public.affiliate_links
for all
to service_role
using (true)
with check (true);

drop policy if exists service_role_all_affiliate_conversions on public.affiliate_conversions;
create policy service_role_all_affiliate_conversions
on public.affiliate_conversions
for all
to service_role
using (true)
with check (true);

drop policy if exists service_role_all_affiliate_withdrawals on public.affiliate_withdrawals;
create policy service_role_all_affiliate_withdrawals
on public.affiliate_withdrawals
for all
to service_role
using (true)
with check (true);

drop policy if exists service_role_all_affiliate_settings on public.affiliate_settings;
create policy service_role_all_affiliate_settings
on public.affiliate_settings
for all
to service_role
using (true)
with check (true);

-- 9. Grants
revoke all on table public.affiliates from public, anon, authenticated;
revoke all on table public.affiliate_links from public, anon, authenticated;
revoke all on table public.affiliate_conversions from public, anon, authenticated;
revoke all on table public.affiliate_withdrawals from public, anon, authenticated;
revoke all on table public.affiliate_settings from public, anon, authenticated;

grant all on table public.affiliates to service_role;
grant all on table public.affiliate_links to service_role;
grant all on table public.affiliate_conversions to service_role;
grant all on table public.affiliate_withdrawals to service_role;
grant all on table public.affiliate_settings to service_role;

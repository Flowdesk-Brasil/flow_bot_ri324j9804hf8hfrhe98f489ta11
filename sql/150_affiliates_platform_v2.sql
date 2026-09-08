-- Sistema de afiliados Flowdesk - v2
--
-- Depende de: 148_affiliates_platform.sql (tabelas base) e public.payment_orders.
-- Assim como a v1, todo acesso e via supabaseAdmin (service_role).
--
-- O que esta migracao acrescenta:
--   1. Corrige planos e periodos para os valores reais do produto
--      (basic/pro/ultra/master, mensal/trimestral/semestral/anual). A v1
--      aceitava "enterprise", que nao existe, e ignorava ultra e master.
--   2. affiliate_clicks       - rastreio real de cliques, base do antifraude
--   3. affiliate_ledger       - razao contabil imutavel; saldo passa a ser
--                               derivado, nao um campo mutavel sem historico
--   4. affiliate_terms_acceptances - registro de aceite (LGPD / contrato)
--   5. Colunas novas em affiliates, conversions, withdrawals e settings
--   6. Funcao de recalculo de saldo a partir do ledger
--   7. Remove os checks de saldo >= 0 da v1, que impediam a divida gerada por
--      reembolso posterior ao saque

create extension if not exists pgcrypto;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Planos e periodos corretos
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.affiliate_links
  drop constraint if exists affiliate_links_plan_slug_check;

alter table public.affiliate_links
  add constraint affiliate_links_plan_slug_check
  check (plan_slug in ('basic', 'pro', 'ultra', 'master'));

alter table public.affiliate_links
  drop constraint if exists affiliate_links_period_check;

alter table public.affiliate_links
  add constraint affiliate_links_period_check
  check (period in ('monthly', 'quarterly', 'semiannual', 'annual'));

-- Conversoes nasciam sem periodo; ele era inferido do link, o que se perde
-- quando o link e apagado.
alter table public.affiliate_conversions
  add column if not exists period text;

alter table public.affiliate_conversions
  drop constraint if exists affiliate_conversions_plan_slug_check;

alter table public.affiliate_conversions
  add constraint affiliate_conversions_plan_slug_check
  check (plan_slug in ('basic', 'pro', 'ultra', 'master'));

alter table public.affiliate_conversions
  drop constraint if exists affiliate_conversions_period_check;

alter table public.affiliate_conversions
  add constraint affiliate_conversions_period_check
  check (period is null or period in ('monthly', 'quarterly', 'semiannual', 'annual'));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Ciclo de vida do afiliado
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.affiliates
  add column if not exists enrolled_at timestamptz,
  add column if not exists terms_version text,
  add column if not exists terms_accepted_at timestamptz,
  add column if not exists suspended_at timestamptz,
  add column if not exists suspension_reason text,
  add column if not exists level_evaluated_at timestamptz,
  add column if not exists highest_level text;

-- Perfis criados pela v1 (sem adesao explicita) ficam marcados como legado:
-- entraram sem aceitar termos e precisam aceitar antes de operar.
update public.affiliates
set enrolled_at = coalesce(enrolled_at, created_at)
where enrolled_at is null;

update public.affiliates
set highest_level = coalesce(highest_level, level)
where highest_level is null;

alter table public.affiliates
  drop constraint if exists affiliates_highest_level_check;

alter table public.affiliates
  add constraint affiliates_highest_level_check
  check (highest_level is null or highest_level in ('bronze', 'silver', 'gold', 'diamond'));

-- Saldo negativo passa a ser permitido.
--
-- A v1 exigia balance_available >= 0 e balance_pending >= 0. Isso quebra o caso
-- em que um reembolso chega depois de o afiliado ja ter sacado a comissao: o
-- valor precisa virar divida, abatida pelas proximas comissoes. Com o check em
-- vigor, affiliate_recompute_balances() falharia com violacao de constraint
-- justamente nesse cenario, e como o lancamento de estorno ja estaria gravado
-- (o ledger e imutavel), o saldo do afiliado ficaria congelado: todo recalculo
-- seguinte quebraria.
--
-- Quem impede saque com saldo negativo e requestWithdrawal, na aplicacao.
alter table public.affiliates
  drop constraint if exists affiliates_balance_available_check;

alter table public.affiliates
  drop constraint if exists affiliates_balance_pending_check;

-- total_earned continua nao-negativo: a funcao de recalculo aplica greatest(x, 0)
-- antes de gravar, porque e uma metrica de vida, nao um saldo.

create table if not exists public.affiliate_terms_acceptances (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates(id) on delete cascade,
  terms_version text not null,
  accepted_at timestamptz not null default timezone('utc', now()),
  ip_fingerprint text,
  user_agent text,
  constraint affiliate_terms_acceptances_version_key
    unique (affiliate_id, terms_version)
);

create index if not exists idx_affiliate_terms_acceptances_affiliate
  on public.affiliate_terms_acceptances (affiliate_id, accepted_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Cliques
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.affiliate_clicks (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates(id) on delete cascade,
  link_id uuid references public.affiliate_links(id) on delete set null,
  visitor_id text not null,
  ip_fingerprint text,
  user_agent text,
  referer text,
  country text,
  is_counted boolean not null default true,
  reject_reason text,
  clicked_at timestamptz not null default timezone('utc', now())
);

-- Consulta quente: cliques de hoje e do mes por afiliado.
create index if not exists idx_affiliate_clicks_affiliate_date
  on public.affiliate_clicks (affiliate_id, clicked_at desc);

create index if not exists idx_affiliate_clicks_link_date
  on public.affiliate_clicks (link_id, clicked_at desc);

-- Usado pela deduplicacao: mesmo visitante, mesmo link, janela recente.
create index if not exists idx_affiliate_clicks_dedupe
  on public.affiliate_clicks (link_id, visitor_id, clicked_at desc);

create index if not exists idx_affiliate_clicks_counted
  on public.affiliate_clicks (affiliate_id, is_counted, clicked_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Razao contabil
-- ─────────────────────────────────────────────────────────────────────────────
-- Lancamentos sao imutaveis: corrigir um erro significa lancar o inverso, nunca
-- editar a linha. balance_pending e balance_available em public.affiliates
-- passam a ser cache do somatorio destas colunas.

create table if not exists public.affiliate_ledger (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates(id) on delete cascade,
  entry_type text not null,
  pending_delta numeric(12, 2) not null default 0,
  available_delta numeric(12, 2) not null default 0,
  earned_delta numeric(12, 2) not null default 0,
  conversion_id uuid references public.affiliate_conversions(id) on delete set null,
  withdrawal_id uuid references public.affiliate_withdrawals(id) on delete set null,
  description text,
  created_by text,
  idempotency_key text,
  created_at timestamptz not null default timezone('utc', now()),
  constraint affiliate_ledger_entry_type_check check (
    entry_type in (
      'commission_accrued',
      'commission_matured',
      'commission_reversed',
      'withdrawal_requested',
      'withdrawal_paid',
      'withdrawal_refunded',
      'adjustment'
    )
  ),
  constraint affiliate_ledger_idempotency_key
    unique (idempotency_key)
);

create index if not exists idx_affiliate_ledger_affiliate
  on public.affiliate_ledger (affiliate_id, created_at desc);

create index if not exists idx_affiliate_ledger_conversion
  on public.affiliate_ledger (conversion_id);

create index if not exists idx_affiliate_ledger_withdrawal
  on public.affiliate_ledger (withdrawal_id);

-- Lancamentos nao sao editaveis nem apagaveis.
create or replace function public.affiliate_ledger_is_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'affiliate_ledger e append-only: lance a entrada inversa em vez de alterar %', tg_op;
end;
$$;

drop trigger if exists tr_affiliate_ledger_no_update on public.affiliate_ledger;
create trigger tr_affiliate_ledger_no_update
before update or delete on public.affiliate_ledger
for each row
execute function public.affiliate_ledger_is_append_only();

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Conversoes: rastreabilidade da comissao
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.affiliate_conversions
  add column if not exists matured_at timestamptz,
  add column if not exists payment_order_id bigint,
  add column if not exists commission_pct numeric(6, 2),
  add column if not exists level_at_conversion text,
  add column if not exists rank_bonus_pct numeric(6, 2) not null default 0,
  add column if not exists available_at timestamptz,
  add column if not exists reversed_at timestamptz,
  add column if not exists reversal_reason text,
  add column if not exists charge_sequence integer not null default 1,
  add column if not exists customer_user_id bigint;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'affiliate_conversions_payment_order_fkey'
      and conrelid = 'public.affiliate_conversions'::regclass
  ) then
    alter table public.affiliate_conversions
      add constraint affiliate_conversions_payment_order_fkey
      foreign key (payment_order_id) references public.payment_orders(id) on delete set null;
  end if;
end
$$;

-- Uma cobranca so pode virar comissao uma vez.
create unique index if not exists idx_affiliate_conversions_payment_order_unique
  on public.affiliate_conversions (payment_order_id)
  where payment_order_id is not null;

-- Indice da fila de maturacao. Filtrar por matured_at is null e o que faz a
-- fila encolher: sem isso, a rotina reprocessa toda conversao ja madura e,
-- passado o limite por execucao, as novas nunca chegam a ser processadas.
create index if not exists idx_affiliate_conversions_maturation_queue
  on public.affiliate_conversions (available_at)
  where status = 'approved' and reversed_at is null and matured_at is null;

create index if not exists idx_affiliate_conversions_customer
  on public.affiliate_conversions (customer_user_id, conversion_date desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Saques
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.affiliate_withdrawals
  add column if not exists pix_key_type text,
  add column if not exists fee_amount numeric(12, 2) not null default 0,
  add column if not exists net_amount numeric(12, 2),
  add column if not exists receipt_url text,
  add column if not exists reviewed_by text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists rejection_reason text;

alter table public.affiliate_withdrawals
  drop constraint if exists affiliate_withdrawals_pix_key_type_check;

alter table public.affiliate_withdrawals
  add constraint affiliate_withdrawals_pix_key_type_check
  check (
    pix_key_type is null
    or pix_key_type in ('cpf', 'cnpj', 'email', 'phone', 'random')
  );

update public.affiliate_withdrawals
set net_amount = coalesce(net_amount, amount - coalesce(fee_amount, 0))
where net_amount is null;

-- Um afiliado nao pode ter duas solicitacoes abertas ao mesmo tempo.
create unique index if not exists idx_affiliate_withdrawals_single_open
  on public.affiliate_withdrawals (affiliate_id)
  where status in ('pending', 'processing');

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Notificacoes
-- ─────────────────────────────────────────────────────────────────────────────
-- Os tipos do front ja prometiam estes campos; eles nao existiam no banco.

alter table public.affiliate_settings
  add column if not exists webhook_secret text,
  add column if not exists webhook_events text[] not null default array['approved']::text[],
  add column if not exists webhook_enabled boolean not null default false,
  add column if not exists notify_push boolean not null default false,
  add column if not exists email_address text,
  add column if not exists sms_phone text;

update public.affiliate_settings
set webhook_enabled = coalesce(webhook_enabled, false)
where webhook_enabled is null;

-- Fila de entrega de webhook, com retry.
create table if not exists public.affiliate_webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  target_url text not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  last_error text,
  last_status_code integer,
  next_attempt_at timestamptz not null default timezone('utc', now()),
  delivered_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  constraint affiliate_webhook_deliveries_status_check
    check (status in ('pending', 'delivered', 'failed', 'abandoned'))
);

create index if not exists idx_affiliate_webhook_deliveries_queue
  on public.affiliate_webhook_deliveries (status, next_attempt_at)
  where status = 'pending';

create index if not exists idx_affiliate_webhook_deliveries_affiliate
  on public.affiliate_webhook_deliveries (affiliate_id, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Recalculo de saldo a partir do ledger
-- ─────────────────────────────────────────────────────────────────────────────
-- Fonte da verdade e o ledger. Esta funcao reescreve o cache em affiliates e
-- pode ser chamada a qualquer momento para reconciliar.

create or replace function public.affiliate_recompute_balances(target_affiliate_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  sum_pending numeric(12, 2);
  sum_available numeric(12, 2);
  sum_earned numeric(12, 2);
begin
  select
    coalesce(sum(pending_delta), 0),
    coalesce(sum(available_delta), 0),
    coalesce(sum(earned_delta), 0)
  into sum_pending, sum_available, sum_earned
  from public.affiliate_ledger
  where affiliate_id = target_affiliate_id;

  -- Saldo negativo e legitimo: acontece quando um reembolso chega depois de o
  -- afiliado ja ter sacado a comissao. O valor vira divida, abatida pelas
  -- proximas comissoes, e requestWithdrawal bloqueia saque enquanto isso.
  --
  -- Lancar excecao aqui congelava o afiliado: o lancamento ja estava gravado
  -- (o ledger e imutavel) e todo recalculo seguinte falhava.
  if sum_pending < 0 or sum_available < 0 then
    raise warning
      'Saldo negativo para o afiliado % (pendente %, disponivel %): divida a compensar.',
      target_affiliate_id, sum_pending, sum_available;
  end if;

  update public.affiliates
  set
    balance_pending = sum_pending,
    balance_available = sum_available,
    total_earned = greatest(sum_earned, 0)
  where id = target_affiliate_id;
end;
$$;

-- Ranking mensal agregado no banco.
--
-- Sem isto, tanto o painel quanto o calculo do bonus de podio carregavam todas
-- as conversoes aprovadas do mes para somar em memoria. O painel fazia isso a
-- cada abertura; o bonus, a cada liquidacao de pedido, ou seja, dentro do
-- caminho de pagamento. Agregar no banco e devolver so o topo mantem o custo
-- constante conforme affiliate_conversions cresce.
create or replace function public.affiliate_monthly_ranking(
  month_start timestamptz,
  max_rows integer default 10
)
returns table (
  affiliate_row_id uuid,
  sales_count bigint,
  commission_total numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.affiliate_id,
    count(*)::bigint,
    coalesce(sum(c.commission_amount), 0)
  from public.affiliate_conversions c
  where c.status = 'approved'
    and c.reversed_at is null
    and c.conversion_date >= month_start
  group by c.affiliate_id
  order by
    coalesce(sum(c.commission_amount), 0) desc,
    count(*) desc,
    c.affiliate_id
  limit greatest(coalesce(max_rows, 10), 1);
$$;

-- Indice que sustenta a agregacao acima.
create index if not exists idx_affiliate_conversions_monthly_ranking
  on public.affiliate_conversions (conversion_date desc, affiliate_id)
  where status = 'approved' and reversed_at is null;

-- Reconcilia todos os afiliados de uma vez (uso operacional/auditoria).
create or replace function public.affiliate_recompute_all_balances()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer := 0;
  row_id uuid;
begin
  for row_id in select id from public.affiliates loop
    perform public.affiliate_recompute_balances(row_id);
    affected := affected + 1;
  end loop;

  return affected;
end;
$$;

-- Backfill: perfis da v1 tinham saldo zerado e nenhum lancamento. Se algum
-- saldo foi ajustado a mao, vira um lancamento de ajuste para nao se perder.
insert into public.affiliate_ledger (
  affiliate_id, entry_type, pending_delta, available_delta, earned_delta,
  description, created_by, idempotency_key
)
select
  a.id,
  'adjustment',
  coalesce(a.balance_pending, 0),
  coalesce(a.balance_available, 0),
  coalesce(a.total_earned, 0),
  'Saldo herdado da v1 antes da criacao do ledger',
  'migration:150',
  'migration-150-opening-' || a.id::text
from public.affiliates a
where (
  coalesce(a.balance_pending, 0) <> 0
  or coalesce(a.balance_available, 0) <> 0
  or coalesce(a.total_earned, 0) <> 0
)
on conflict (idempotency_key) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. RLS e grants das tabelas novas
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.affiliate_clicks enable row level security;
alter table public.affiliate_ledger enable row level security;
alter table public.affiliate_terms_acceptances enable row level security;
alter table public.affiliate_webhook_deliveries enable row level security;

drop policy if exists service_role_all_affiliate_clicks on public.affiliate_clicks;
create policy service_role_all_affiliate_clicks
on public.affiliate_clicks for all to service_role using (true) with check (true);

drop policy if exists service_role_all_affiliate_ledger on public.affiliate_ledger;
create policy service_role_all_affiliate_ledger
on public.affiliate_ledger for all to service_role using (true) with check (true);

drop policy if exists service_role_all_affiliate_terms on public.affiliate_terms_acceptances;
create policy service_role_all_affiliate_terms
on public.affiliate_terms_acceptances for all to service_role using (true) with check (true);

drop policy if exists service_role_all_affiliate_webhooks on public.affiliate_webhook_deliveries;
create policy service_role_all_affiliate_webhooks
on public.affiliate_webhook_deliveries for all to service_role using (true) with check (true);

revoke all on table public.affiliate_clicks from public, anon, authenticated;
revoke all on table public.affiliate_ledger from public, anon, authenticated;
revoke all on table public.affiliate_terms_acceptances from public, anon, authenticated;
revoke all on table public.affiliate_webhook_deliveries from public, anon, authenticated;

grant all on table public.affiliate_clicks to service_role;
grant all on table public.affiliate_ledger to service_role;
grant all on table public.affiliate_terms_acceptances to service_role;
grant all on table public.affiliate_webhook_deliveries to service_role;

revoke all on function public.affiliate_recompute_balances(uuid) from public, anon, authenticated;
revoke all on function public.affiliate_recompute_all_balances() from public, anon, authenticated;
grant execute on function public.affiliate_recompute_balances(uuid) to service_role;
grant execute on function public.affiliate_recompute_all_balances() to service_role;

revoke all on function public.affiliate_monthly_ranking(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.affiliate_monthly_ranking(timestamptz, integer) to service_role;

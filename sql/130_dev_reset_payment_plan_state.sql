-- DEV ONLY - DESTRUCTIVE RESET
-- Reseta pagamentos, historico financeiro, estado de assinatura Flow,
-- vinculos de servidores licenciados, metodos de pagamento e FlowPoints.
-- Nao apaga auth_users, servidores, configuracoes dos servidores, dominios ou VPS.
--
-- Use apenas em ambiente local/dev. Em producao, prefira uma migracao de reparo
-- por usuario/pedido para manter trilha financeira auditavel.

begin;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    -- Projecoes/historico derivado de payment_orders.
    'payment_order_state_history',
    'payment_checkout_carts',
    'payment_order_events',
    'payment_refund_records',
    'payment_risk_flags',

    -- Beneficios e carteira ligados a compras de plano.
    'payment_coupon_redemptions',
    'payment_gift_card_redemptions',
    'auth_user_plan_flow_point_events',
    'auth_user_plan_flow_points',
    'auth_user_plan_scheduled_changes',
    'auth_user_plan_downgrade_enforcements',

    -- Estado materializado que estava exibindo compra avulsa como plano Flow.
    'auth_user_plan_guilds',
    'guild_plan_settings',
    'auth_user_plan_state',

    -- Metodos salvos/ocultos e verificacoes de pagamento do usuario.
    'auth_user_hidden_payment_methods',
    'auth_user_payment_method_verifications',
    'auth_user_payment_methods',

    -- Pedidos financeiros. FKs com on delete set null preservam VPS/dominios.
    'payment_orders'
  ]
  loop
    if to_regclass('public.' || table_name) is not null then
      execute format('delete from public.%I', table_name);
    end if;
  end loop;

  -- Tabelas de dominio usam payment_order_id como referencia logica em alguns
  -- ambientes; limpe sem depender de FK.
  if to_regclass('public.domain_registrations') is not null then
    update public.domain_registrations set payment_order_id = null;
  end if;

  if to_regclass('public.domain_transfers') is not null then
    update public.domain_transfers set payment_order_id = null;
  end if;

  if to_regclass('public.domain_renewals') is not null then
    update public.domain_renewals set payment_order_id = null;
  end if;

  if to_regclass('public.hosting_projects') is not null then
    update public.hosting_projects
       set payment_order_id = null;

    if exists (
      select 1
        from information_schema.columns
       where table_schema = 'public'
         and table_name = 'hosting_projects'
         and column_name = 'billing_status'
    ) then
      update public.hosting_projects
         set billing_status = 'unpaid';
    end if;
  end if;
end $$;

commit;

select
  (select count(*) from public.payment_orders) as payment_orders_count,
  (select count(*) from public.payment_order_events) as payment_order_events_count,
  (select count(*) from public.auth_user_plan_state) as auth_user_plan_state_count,
  (select count(*) from public.auth_user_plan_guilds) as auth_user_plan_guilds_count,
  (select count(*) from public.auth_user_plan_flow_points) as auth_user_plan_flow_points_count,
  (select count(*) from public.auth_user_payment_methods) as auth_user_payment_methods_count;

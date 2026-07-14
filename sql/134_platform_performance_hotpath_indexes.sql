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

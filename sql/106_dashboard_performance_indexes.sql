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

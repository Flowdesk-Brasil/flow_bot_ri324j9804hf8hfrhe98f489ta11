-- Agent/Bridge da whitelist: last-seen, IP observado e sincronizacao Discord.

alter table public.guild_whitelist_settings
  add column if not exists agent_last_seen_at timestamptz null;

alter table public.guild_whitelist_settings
  add column if not exists agent_public_ip text null;

create unique index if not exists idx_guild_whitelist_settings_agent_public_id
  on public.guild_whitelist_settings (agent_public_id)
  where agent_public_id is not null;

alter table public.guild_whitelist_agent_jobs
  add column if not exists discord_synced boolean not null default false;

create index if not exists idx_guild_whitelist_agent_jobs_discord_sync
  on public.guild_whitelist_agent_jobs (discord_synced, status)
  where discord_synced = false;

alter table public.guild_bate_ponto_settings
  add column if not exists require_voice_channel boolean not null default false,
  add column if not exists required_voice_channel_ids text[] not null default '{}'::text[];

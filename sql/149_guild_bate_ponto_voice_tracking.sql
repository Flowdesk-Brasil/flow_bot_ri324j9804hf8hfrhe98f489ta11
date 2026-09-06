alter table public.guild_bate_ponto_sessions
  add column if not exists voice_channel_id text null,
  add column if not exists voice_left_at timestamptz null,
  add column if not exists voice_warning_sent_at timestamptz null;

create index if not exists idx_guild_bate_ponto_sessions_voice_left
  on public.guild_bate_ponto_sessions (voice_left_at)
  where voice_left_at is not null and status in ('active', 'on_break');

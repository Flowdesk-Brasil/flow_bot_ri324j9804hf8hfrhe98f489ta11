create table if not exists public.guild_bate_ponto_settings (
  id bigint generated always as identity primary key,
  guild_id text not null unique,
  enabled boolean not null default false,
  panel_channel_id text null,
  logs_channel_id text null,
  panel_layout jsonb not null default '[]'::jsonb,
  panel_title text not null default '',
  panel_description text not null default '',
  panel_button_label text not null default '',
  panel_message_id text null,
  log_layout jsonb not null default '[]'::jsonb,
  allowed_role_ids text[] not null default '{}'::text[],
  hour_bank_enabled boolean not null default true,
  daily_target_minutes integer not null default 480,
  timezone text not null default 'America/Sao_Paulo',
  auto_finish_open_sessions boolean not null default false,
  max_open_hours integer not null default 12,
  configured_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_bate_ponto_settings_daily_target_minutes_check
    check (daily_target_minutes >= 60 and daily_target_minutes <= 1440),
  constraint guild_bate_ponto_settings_max_open_hours_check
    check (max_open_hours >= 1 and max_open_hours <= 24)
);

create table if not exists public.guild_bate_ponto_sessions (
  id bigint generated always as identity primary key,
  guild_id text not null,
  user_id text not null,
  status text not null default 'active',
  started_at timestamptz not null default timezone('utc', now()),
  ended_at timestamptz null,
  last_action_at timestamptz not null default timezone('utc', now()),
  worked_seconds bigint not null default 0,
  break_seconds bigint not null default 0,
  break_started_at timestamptz null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_bate_ponto_sessions_status_check
    check (status in ('active', 'on_break', 'finished'))
);

create table if not exists public.guild_bate_ponto_events (
  id bigint generated always as identity primary key,
  guild_id text not null,
  user_id text not null,
  session_id bigint null references public.guild_bate_ponto_sessions(id) on delete set null,
  action text not null,
  worked_seconds bigint not null default 0,
  break_seconds bigint not null default 0,
  hour_bank_delta_seconds bigint not null default 0,
  note text null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint guild_bate_ponto_events_action_check
    check (action in ('start', 'pause', 'resume', 'finish'))
);

create table if not exists public.guild_bate_ponto_hour_bank (
  id bigint generated always as identity primary key,
  guild_id text not null,
  user_id text not null,
  balance_seconds bigint not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_bate_ponto_hour_bank_unique_member unique (guild_id, user_id)
);

create index if not exists idx_guild_bate_ponto_sessions_guild_id
  on public.guild_bate_ponto_sessions (guild_id);

create index if not exists idx_guild_bate_ponto_sessions_guild_user_status
  on public.guild_bate_ponto_sessions (guild_id, user_id, status);

create index if not exists idx_guild_bate_ponto_sessions_guild_status
  on public.guild_bate_ponto_sessions (guild_id, status);

create index if not exists idx_guild_bate_ponto_events_guild_id
  on public.guild_bate_ponto_events (guild_id);

create index if not exists idx_guild_bate_ponto_events_guild_user
  on public.guild_bate_ponto_events (guild_id, user_id, created_at desc);

create index if not exists idx_guild_bate_ponto_events_session_id
  on public.guild_bate_ponto_events (session_id);

create index if not exists idx_guild_bate_ponto_hour_bank_guild_id
  on public.guild_bate_ponto_hour_bank (guild_id);

drop trigger if exists tr_guild_bate_ponto_settings_updated_at on public.guild_bate_ponto_settings;
create trigger tr_guild_bate_ponto_settings_updated_at
before update on public.guild_bate_ponto_settings
for each row
execute function public.set_updated_at();

drop trigger if exists tr_guild_bate_ponto_sessions_updated_at on public.guild_bate_ponto_sessions;
create trigger tr_guild_bate_ponto_sessions_updated_at
before update on public.guild_bate_ponto_sessions
for each row
execute function public.set_updated_at();

drop trigger if exists tr_guild_bate_ponto_hour_bank_updated_at on public.guild_bate_ponto_hour_bank;
create trigger tr_guild_bate_ponto_hour_bank_updated_at
before update on public.guild_bate_ponto_hour_bank
for each row
execute function public.set_updated_at();

alter table public.guild_bate_ponto_settings enable row level security;
alter table public.guild_bate_ponto_sessions enable row level security;
alter table public.guild_bate_ponto_events enable row level security;
alter table public.guild_bate_ponto_hour_bank enable row level security;

drop policy if exists "service_role_all_guild_bate_ponto_settings" on public.guild_bate_ponto_settings;
create policy "service_role_all_guild_bate_ponto_settings"
on public.guild_bate_ponto_settings
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_guild_bate_ponto_sessions" on public.guild_bate_ponto_sessions;
create policy "service_role_all_guild_bate_ponto_sessions"
on public.guild_bate_ponto_sessions
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_guild_bate_ponto_events" on public.guild_bate_ponto_events;
create policy "service_role_all_guild_bate_ponto_events"
on public.guild_bate_ponto_events
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_guild_bate_ponto_hour_bank" on public.guild_bate_ponto_hour_bank;
create policy "service_role_all_guild_bate_ponto_hour_bank"
on public.guild_bate_ponto_hour_bank
for all
to service_role
using (true)
with check (true);

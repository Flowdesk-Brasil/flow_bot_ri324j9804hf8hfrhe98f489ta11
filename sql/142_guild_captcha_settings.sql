create table if not exists public.guild_captcha_settings (
  id bigint generated always as identity primary key,
  guild_id text not null unique,
  enabled boolean not null default false,
  panel_channel_id text null,
  logs_channel_id text null,
  verified_role_ids text[] not null default '{}'::text[],
  bypass_role_ids text[] not null default '{}'::text[],
  panel_layout jsonb not null default '[]'::jsonb,
  panel_title text not null default '',
  panel_description text not null default '',
  panel_button_label text not null default '',
  panel_message_id text null,
  challenge_title text not null default 'Verificacao de seguranca',
  challenge_description text not null default 'Selecione o codigo que aparece na imagem acima.',
  max_attempts integer not null default 3,
  timeout_seconds integer not null default 120,
  kick_on_fail boolean not null default false,
  success_message text not null default 'Verificacao concluida com sucesso. Bem-vindo ao servidor!',
  configured_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_captcha_settings_max_attempts_check
    check (max_attempts >= 1 and max_attempts <= 10),
  constraint guild_captcha_settings_timeout_seconds_check
    check (timeout_seconds >= 30 and timeout_seconds <= 600)
);

create table if not exists public.guild_captcha_sessions (
  id bigint generated always as identity primary key,
  guild_id text not null,
  user_id text not null,
  correct_code text not null,
  option_codes jsonb not null default '[]'::jsonb,
  attempts_remaining integer not null default 3,
  expires_at timestamptz not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_captcha_sessions_unique_member unique (guild_id, user_id)
);

create index if not exists idx_guild_captcha_sessions_expires_at
  on public.guild_captcha_sessions (expires_at);

drop trigger if exists tr_guild_captcha_settings_updated_at on public.guild_captcha_settings;
create trigger tr_guild_captcha_settings_updated_at
before update on public.guild_captcha_settings
for each row
execute function public.set_updated_at();

drop trigger if exists tr_guild_captcha_sessions_updated_at on public.guild_captcha_sessions;
create trigger tr_guild_captcha_sessions_updated_at
before update on public.guild_captcha_sessions
for each row
execute function public.set_updated_at();

alter table public.guild_captcha_settings enable row level security;
alter table public.guild_captcha_sessions enable row level security;

drop policy if exists "service_role_all_guild_captcha_settings" on public.guild_captcha_settings;
create policy "service_role_all_guild_captcha_settings"
on public.guild_captcha_settings
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_guild_captcha_sessions" on public.guild_captcha_sessions;
create policy "service_role_all_guild_captcha_sessions"
on public.guild_captcha_sessions
for all
to service_role
using (true)
with check (true);

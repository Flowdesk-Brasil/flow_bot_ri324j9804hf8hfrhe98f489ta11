-- Configuracoes de sorteios por servidor (dashboard + bot)

create table if not exists public.guild_sorteio_settings (
  id bigint generated always as identity primary key,
  guild_id text not null unique,
  enabled boolean not null default false,
  logs_channel_id text null,
  create_role_ids text[] not null default '{}',
  reroll_role_ids text[] not null default '{}',
  active_layout jsonb not null default '[]'::jsonb,
  ended_layout jsonb not null default '[]'::jsonb,
  panel_title text not null default '',
  panel_description text not null default '',
  default_winner_count integer not null default 1,
  default_duration_minutes integer not null default 60,
  configured_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_sorteio_settings_winner_count_check
    check (default_winner_count >= 1 and default_winner_count <= 25),
  constraint guild_sorteio_settings_duration_check
    check (default_duration_minutes >= 1 and default_duration_minutes <= 43200)
);

drop trigger if exists tr_guild_sorteio_settings_updated_at on public.guild_sorteio_settings;
create trigger tr_guild_sorteio_settings_updated_at
before update on public.guild_sorteio_settings
for each row
execute function public.set_updated_at();

alter table public.guild_sorteio_settings enable row level security;

drop policy if exists "service_role_all_guild_sorteio_settings" on public.guild_sorteio_settings;
create policy "service_role_all_guild_sorteio_settings"
on public.guild_sorteio_settings
for all
to service_role
using (true)
with check (true);

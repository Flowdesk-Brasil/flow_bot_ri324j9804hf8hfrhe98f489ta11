-- Sorteios / giveaways (bot Discord)

create table if not exists public.guild_sorteios (
  id bigint generated always as identity primary key,
  guild_id text not null,
  host_user_id text not null,
  channel_id text not null,
  message_id text null,
  title text not null,
  description text not null default '',
  status text not null default 'active',
  winner_count integer not null default 1,
  required_role_ids text[] not null default '{}',
  min_server_days integer not null default 0,
  min_account_age_days integer not null default 0,
  ends_at timestamptz not null,
  ended_at timestamptz null,
  winner_user_ids text[] not null default '{}',
  reroll_count integer not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_sorteios_status_check
    check (status in ('active', 'ended', 'cancelled')),
  constraint guild_sorteios_winner_count_check
    check (winner_count >= 1 and winner_count <= 25)
);

create table if not exists public.guild_sorteio_entries (
  id bigint generated always as identity primary key,
  sorteio_id bigint not null references public.guild_sorteios(id) on delete cascade,
  guild_id text not null,
  user_id text not null,
  joined_at timestamptz not null default timezone('utc', now()),
  constraint guild_sorteio_entries_unique_member unique (sorteio_id, user_id)
);

create table if not exists public.guild_sorteio_blacklist (
  id bigint generated always as identity primary key,
  sorteio_id bigint not null references public.guild_sorteios(id) on delete cascade,
  guild_id text not null,
  user_id text not null,
  created_by text not null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint guild_sorteio_blacklist_unique_member unique (sorteio_id, user_id)
);

create index if not exists idx_guild_sorteios_guild_status
  on public.guild_sorteios (guild_id, status);

create index if not exists idx_guild_sorteios_active_ends_at
  on public.guild_sorteios (status, ends_at)
  where status = 'active';

create index if not exists idx_guild_sorteio_entries_sorteio_id
  on public.guild_sorteio_entries (sorteio_id);

create index if not exists idx_guild_sorteio_blacklist_sorteio_id
  on public.guild_sorteio_blacklist (sorteio_id);

drop trigger if exists tr_guild_sorteios_updated_at on public.guild_sorteios;
create trigger tr_guild_sorteios_updated_at
before update on public.guild_sorteios
for each row
execute function public.set_updated_at();

alter table public.guild_sorteios enable row level security;
alter table public.guild_sorteio_entries enable row level security;
alter table public.guild_sorteio_blacklist enable row level security;

drop policy if exists "service_role_all_guild_sorteios" on public.guild_sorteios;
create policy "service_role_all_guild_sorteios"
on public.guild_sorteios
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_guild_sorteio_entries" on public.guild_sorteio_entries;
create policy "service_role_all_guild_sorteio_entries"
on public.guild_sorteio_entries
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_guild_sorteio_blacklist" on public.guild_sorteio_blacklist;
create policy "service_role_all_guild_sorteio_blacklist"
on public.guild_sorteio_blacklist
for all
to service_role
using (true)
with check (true);

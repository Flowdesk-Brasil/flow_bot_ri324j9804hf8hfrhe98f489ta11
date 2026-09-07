-- Flowdesk Launcher: login de dispositivo, sessao persistente e vinculo da maquina.

create table if not exists public.launcher_login_attempts (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'pending',
  attempt_token_hash text not null unique,
  poll_token_hash text not null unique,
  login_code text not null,
  device_label text not null default '',
  hostname text not null default '',
  platform text not null default '',
  install_id_hash text not null default '',
  app_version text not null default '',
  completed_payload_cipher text null,
  auth_user_id bigint null references public.auth_users(id) on delete set null,
  device_id uuid null,
  expires_at timestamptz not null,
  completed_at timestamptz null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint launcher_login_attempts_status_check
    check (status in ('pending', 'completed', 'expired', 'revoked'))
);

create table if not exists public.launcher_devices (
  id uuid primary key default gen_random_uuid(),
  auth_user_id bigint not null references public.auth_users(id) on delete cascade,
  guild_id text null,
  device_public_id text not null unique,
  install_id_hash text not null,
  hostname text not null default '',
  platform text not null default '',
  app_version text not null default '',
  label text not null default 'Flowdesk Launcher',
  connection_status text not null default 'authenticating',
  last_seen_at timestamptz null,
  last_error text null,
  observed_ip text null,
  servers_cache jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint launcher_devices_status_check
    check (connection_status in (
      'authenticating', 'online', 'offline', 'error', 'awaiting_server'
    ))
);

create unique index if not exists idx_launcher_devices_user_install
  on public.launcher_devices (auth_user_id, install_id_hash);

create index if not exists idx_launcher_devices_guild
  on public.launcher_devices (guild_id)
  where guild_id is not null;

create table if not exists public.launcher_tokens (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.launcher_devices(id) on delete cascade,
  auth_user_id bigint not null references public.auth_users(id) on delete cascade,
  access_token_hash text not null unique,
  refresh_token_hash text not null unique,
  access_expires_at timestamptz not null,
  refresh_expires_at timestamptz not null,
  revoked_at timestamptz null,
  last_used_at timestamptz null,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_launcher_tokens_device
  on public.launcher_tokens (device_id, revoked_at);

alter table public.launcher_login_attempts enable row level security;
alter table public.launcher_devices enable row level security;
alter table public.launcher_tokens enable row level security;

drop policy if exists "service_role_all_launcher_login_attempts" on public.launcher_login_attempts;
create policy "service_role_all_launcher_login_attempts"
on public.launcher_login_attempts for all to service_role using (true) with check (true);

drop policy if exists "service_role_all_launcher_devices" on public.launcher_devices;
create policy "service_role_all_launcher_devices"
on public.launcher_devices for all to service_role using (true) with check (true);

drop policy if exists "service_role_all_launcher_tokens" on public.launcher_tokens;
create policy "service_role_all_launcher_tokens"
on public.launcher_tokens for all to service_role using (true) with check (true);

drop trigger if exists tr_launcher_devices_updated_at on public.launcher_devices;
create trigger tr_launcher_devices_updated_at
before update on public.launcher_devices
for each row
execute function public.set_updated_at();

create table if not exists public.guild_security_log_queue (
  id bigint generated always as identity primary key,
  queue_key text not null unique,
  guild_id text not null,
  channel_id text not null,
  event_key text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  max_attempts integer not null default 48,
  next_attempt_at timestamptz not null default timezone('utc', now()),
  last_error text null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_security_log_queue_status_check
    check (status in ('pending', 'processing', 'failed'))
);

create index if not exists idx_guild_security_log_queue_status_next_attempt
on public.guild_security_log_queue (status, next_attempt_at, created_at);

create index if not exists idx_guild_security_log_queue_guild_event
on public.guild_security_log_queue (guild_id, event_key, created_at desc);

drop trigger if exists tr_guild_security_log_queue_updated_at on public.guild_security_log_queue;
create trigger tr_guild_security_log_queue_updated_at
before update on public.guild_security_log_queue
for each row
execute function public.set_updated_at();

alter table public.guild_security_log_queue enable row level security;

drop policy if exists "service_role_all_guild_security_log_queue" on public.guild_security_log_queue;
create policy "service_role_all_guild_security_log_queue"
on public.guild_security_log_queue
for all
to service_role
using (true)
with check (true);

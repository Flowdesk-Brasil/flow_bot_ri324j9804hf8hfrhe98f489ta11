begin;

alter table public.auth_sessions
  add column if not exists last_seen_at timestamptz;

update public.auth_sessions
set last_seen_at = coalesce(created_at, timezone('utc', now()))
where last_seen_at is null;

alter table public.auth_sessions
  alter column last_seen_at set default timezone('utc', now());

create index if not exists idx_auth_sessions_user_activity
on public.auth_sessions (user_id, revoked_at, last_seen_at desc);

commit;

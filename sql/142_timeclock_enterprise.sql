-- Flowdesk enterprise timeclock module.
-- Stores settings, schedules, immutable events, sessions, intervals, hour bank,
-- adjustments and approvals for Discord + dashboard.

create extension if not exists pgcrypto;

do $$ begin
  create type timeclock_session_status as enum (
    'NOT_STARTED',
    'WORKING',
    'PAUSED',
    'FINISHED',
    'INCOMPLETE',
    'ADJUSTED'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type timeclock_approval_status as enum (
    'NONE',
    'PENDING_APPROVAL',
    'APPROVED',
    'REJECTED'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type timeclock_interval_type as enum ('WORK', 'BREAK');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type timeclock_event_type as enum (
    'CLOCK_STARTED',
    'BREAK_STARTED',
    'BREAK_ENDED',
    'CLOCK_FINISHED',
    'CLOCK_ADJUSTED',
    'CLOCK_APPROVED',
    'CLOCK_REJECTED',
    'SCHEDULE_CHANGED',
    'TIMECLOCK_CONFIG_UPDATED',
    'TIMECLOCK_SCHEDULE_UPDATED'
  );
exception when duplicate_object then null;
end $$;

create table if not exists guild_timeclock_settings (
  guild_id text primary key,
  enabled boolean not null default false,
  main_channel_id text,
  log_channel_id text,
  panel_message_id text,
  panel_layout jsonb not null default '[]'::jsonb,
  timezone text not null default 'America/Sao_Paulo',
  employee_role_ids text[] not null default '{}',
  view_history_role_ids text[] not null default '{}',
  edit_timeclock_role_ids text[] not null default '{}',
  approve_hours_role_ids text[] not null default '{}',
  admin_role_ids text[] not null default '{}',
  hour_bank_enabled boolean not null default true,
  early_start_policy text not null default 'count',
  late_finish_policy text not null default 'count',
  overtime_approval_enabled boolean not null default false,
  ranking_public boolean not null default false,
  max_session_seconds integer not null default 50400,
  alerts_enabled boolean not null default true,
  configured_by_user_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint guild_timeclock_settings_guild_id_digits check (guild_id ~ '^[0-9]{10,25}$'),
  constraint guild_timeclock_settings_max_session check (max_session_seconds between 3600 and 172800),
  constraint guild_timeclock_settings_early_policy check (early_start_policy in ('count', 'ignore', 'approval', 'limit')),
  constraint guild_timeclock_settings_late_policy check (late_finish_policy in ('count', 'ignore', 'approval', 'limit'))
);

create table if not exists timeclock_schedule_days (
  guild_id text not null references guild_timeclock_settings(guild_id) on delete cascade,
  weekday integer not null,
  enabled boolean not null default true,
  start_time time not null default '09:00',
  end_time time not null default '18:00',
  expected_work_seconds integer not null default 28800,
  expected_break_seconds integer not null default 3600,
  min_break_seconds integer not null default 0,
  max_break_seconds integer not null default 7200,
  entry_tolerance_seconds integer not null default 300,
  exit_tolerance_seconds integer not null default 300,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (guild_id, weekday),
  constraint timeclock_schedule_days_weekday check (weekday between 0 and 6),
  constraint timeclock_schedule_days_seconds check (
    expected_work_seconds between 0 and 86400
    and expected_break_seconds between 0 and 43200
    and min_break_seconds between 0 and 43200
    and max_break_seconds between 0 and 43200
    and entry_tolerance_seconds between 0 and 10800
    and exit_tolerance_seconds between 0 and 10800
  )
);

create table if not exists timeclock_user_schedule_overrides (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null references guild_timeclock_settings(guild_id) on delete cascade,
  user_id text not null,
  schedule_days jsonb not null default '[]'::jsonb,
  reason text,
  active_from date,
  active_until date,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint timeclock_user_schedule_overrides_user_id_digits check (user_id ~ '^[0-9]{10,25}$')
);

create table if not exists timeclock_exceptions (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null references guild_timeclock_settings(guild_id) on delete cascade,
  user_id text,
  date date not null,
  exception_type text not null,
  expected_work_seconds integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_by text,
  created_at timestamptz not null default now(),
  constraint timeclock_exceptions_type check (
    exception_type in ('day_off', 'holiday', 'vacation', 'leave', 'special_shift', 'custom')
  )
);

create table if not exists timeclock_sessions (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null references guild_timeclock_settings(guild_id) on delete cascade,
  user_id text not null,
  workday date not null,
  timezone text not null default 'America/Sao_Paulo',
  status timeclock_session_status not null default 'WORKING',
  approval_status timeclock_approval_status not null default 'NONE',
  started_at timestamptz,
  ended_at timestamptz,
  active_interval_started_at timestamptz,
  total_worked_seconds integer not null default 0,
  total_paused_seconds integer not null default 0,
  expected_work_seconds integer not null default 0,
  balance_seconds integer not null default 0,
  overtime_seconds integer not null default 0,
  missing_seconds integer not null default 0,
  early_start_seconds integer not null default 0,
  late_start_seconds integer not null default 0,
  early_leave_seconds integer not null default 0,
  late_leave_seconds integer not null default 0,
  source text not null default 'discord',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint timeclock_sessions_user_id_digits check (user_id ~ '^[0-9]{10,25}$'),
  constraint timeclock_sessions_non_negative check (
    total_worked_seconds >= 0
    and total_paused_seconds >= 0
    and expected_work_seconds >= 0
  )
);

create unique index if not exists timeclock_sessions_one_workday_per_user
  on timeclock_sessions(guild_id, user_id, workday);

create index if not exists idx_timeclock_sessions_guild_status_started
  on timeclock_sessions(guild_id, status, started_at desc);

create index if not exists idx_timeclock_sessions_guild_user_workday
  on timeclock_sessions(guild_id, user_id, workday desc);

create index if not exists idx_timeclock_sessions_guild_ended
  on timeclock_sessions(guild_id, ended_at desc);

create index if not exists idx_timeclock_sessions_guild_workday_status_started
  on timeclock_sessions(guild_id, workday desc, status, started_at desc);

create table if not exists timeclock_intervals (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references timeclock_sessions(id) on delete cascade,
  guild_id text not null,
  user_id text not null,
  interval_type timeclock_interval_type not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  duration_seconds integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint timeclock_intervals_duration check (duration_seconds is null or duration_seconds >= 0),
  constraint timeclock_intervals_end_after_start check (ended_at is null or ended_at >= started_at)
);

create unique index if not exists timeclock_intervals_one_open_per_session
  on timeclock_intervals(session_id)
  where ended_at is null;

create index if not exists idx_timeclock_intervals_session_started
  on timeclock_intervals(session_id, started_at);

create table if not exists timeclock_events (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  user_id text not null,
  session_id uuid references timeclock_sessions(id) on delete set null,
  event_type timeclock_event_type not null,
  timestamp timestamptz not null,
  timezone text not null default 'America/Sao_Paulo',
  source text not null,
  actor_id text,
  previous_state text,
  new_state text,
  interaction_id text,
  idempotency_key text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists timeclock_events_idempotency_key_unique
  on timeclock_events(guild_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists idx_timeclock_events_guild_type_timestamp
  on timeclock_events(guild_id, event_type, timestamp desc);

create index if not exists idx_timeclock_events_session_timestamp
  on timeclock_events(session_id, timestamp);

create index if not exists idx_timeclock_events_guild_timestamp
  on timeclock_events(guild_id, timestamp desc);

create table if not exists timeclock_adjustments (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  session_id uuid not null references timeclock_sessions(id) on delete cascade,
  adjusted_by text not null,
  reason text not null,
  field_key text not null,
  old_value jsonb,
  new_value jsonb,
  event_id uuid references timeclock_events(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint timeclock_adjustments_reason_required check (length(trim(reason)) >= 3)
);

create table if not exists timeclock_hour_bank (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  user_id text not null,
  session_id uuid references timeclock_sessions(id) on delete set null,
  workday date not null,
  delta_seconds integer not null,
  approved_seconds integer,
  discarded_seconds integer not null default 0,
  balance_after_seconds integer not null default 0,
  approval_status timeclock_approval_status not null default 'NONE',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_timeclock_hour_bank_guild_user_workday
  on timeclock_hour_bank(guild_id, user_id, workday desc);

create index if not exists idx_timeclock_hour_bank_guild_workday
  on timeclock_hour_bank(guild_id, workday desc);

create table if not exists timeclock_approvals (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  session_id uuid not null references timeclock_sessions(id) on delete cascade,
  user_id text not null,
  detected_seconds integer not null default 0,
  approved_seconds integer,
  discarded_seconds integer,
  status timeclock_approval_status not null default 'PENDING_APPROVAL',
  decided_by text,
  decided_at timestamptz,
  reason text,
  event_id uuid references timeclock_events(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_timeclock_approvals_guild_status
  on timeclock_approvals(guild_id, status, created_at desc);

create or replace function touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists guild_timeclock_settings_touch on guild_timeclock_settings;
create trigger guild_timeclock_settings_touch
before update on guild_timeclock_settings
for each row execute function touch_updated_at();

drop trigger if exists timeclock_schedule_days_touch on timeclock_schedule_days;
create trigger timeclock_schedule_days_touch
before update on timeclock_schedule_days
for each row execute function touch_updated_at();

drop trigger if exists timeclock_sessions_touch on timeclock_sessions;
create trigger timeclock_sessions_touch
before update on timeclock_sessions
for each row execute function touch_updated_at();

create or replace function get_timeclock_ranking(
  p_guild_id text,
  p_from date,
  p_to date,
  p_limit integer default 25,
  p_offset integer default 0
)
returns table (
  user_id text,
  total_worked_seconds bigint,
  total_paused_seconds bigint,
  session_count bigint,
  average_daily_seconds bigint,
  bank_seconds bigint
)
language sql
stable
as $$
  with sessions as (
    select ts.*
    from timeclock_sessions ts
    where ts.guild_id = p_guild_id
      and ts.workday >= p_from
      and ts.workday <= p_to
      and ts.status in ('FINISHED', 'ADJUSTED', 'INCOMPLETE')
  ),
  bank as (
    select hb.user_id, coalesce(sum(hb.delta_seconds), 0)::bigint as bank_seconds
    from timeclock_hour_bank hb
    where hb.guild_id = p_guild_id
      and hb.workday <= p_to
    group by hb.user_id
  )
  select
    s.user_id,
    coalesce(sum(s.total_worked_seconds), 0)::bigint as total_worked_seconds,
    coalesce(sum(s.total_paused_seconds), 0)::bigint as total_paused_seconds,
    count(*)::bigint as session_count,
    case when count(*) = 0 then 0 else (sum(s.total_worked_seconds) / count(*))::bigint end as average_daily_seconds,
    coalesce(max(b.bank_seconds), 0)::bigint as bank_seconds
  from sessions s
  left join bank b on b.user_id = s.user_id
  group by s.user_id
  order by coalesce(sum(s.total_worked_seconds), 0) desc, count(*) desc, s.user_id asc
  limit greatest(1, least(coalesce(p_limit, 25), 100))
  offset greatest(0, coalesce(p_offset, 0));
$$;

create or replace function get_timeclock_dashboard_totals(
  p_guild_id text,
  p_workday date
)
returns table (
  working_count bigint,
  paused_count bigint,
  finished_count bigint,
  worked_seconds bigint,
  paused_seconds bigint,
  overtime_seconds bigint,
  bank_seconds bigint
)
language sql
stable
as $$
  select
    count(*) filter (where ts.status = 'WORKING')::bigint as working_count,
    count(*) filter (where ts.status = 'PAUSED')::bigint as paused_count,
    count(*) filter (where ts.status in ('FINISHED', 'ADJUSTED'))::bigint as finished_count,
    coalesce(sum(ts.total_worked_seconds), 0)::bigint as worked_seconds,
    coalesce(sum(ts.total_paused_seconds), 0)::bigint as paused_seconds,
    coalesce(sum(ts.overtime_seconds), 0)::bigint as overtime_seconds,
    coalesce((
      select sum(hb.delta_seconds)
      from timeclock_hour_bank hb
      where hb.guild_id = p_guild_id
    ), 0)::bigint as bank_seconds
  from timeclock_sessions ts
  where ts.guild_id = p_guild_id
    and ts.workday = p_workday;
$$;

alter table guild_timeclock_settings enable row level security;
alter table timeclock_schedule_days enable row level security;
alter table timeclock_user_schedule_overrides enable row level security;
alter table timeclock_exceptions enable row level security;
alter table timeclock_sessions enable row level security;
alter table timeclock_intervals enable row level security;
alter table timeclock_events enable row level security;
alter table timeclock_adjustments enable row level security;
alter table timeclock_hour_bank enable row level security;
alter table timeclock_approvals enable row level security;

do $$ begin
  alter publication supabase_realtime add table timeclock_events;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

do $$ begin
  alter publication supabase_realtime add table timeclock_sessions;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

-- Hardens Bate Ponto dashboard queries for environments that already ran 142.

create index if not exists idx_timeclock_sessions_guild_workday_status_started
  on timeclock_sessions(guild_id, workday desc, status, started_at desc);

create index if not exists idx_timeclock_events_guild_timestamp
  on timeclock_events(guild_id, timestamp desc);

create index if not exists idx_timeclock_hour_bank_guild_workday
  on timeclock_hour_bank(guild_id, workday desc);

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

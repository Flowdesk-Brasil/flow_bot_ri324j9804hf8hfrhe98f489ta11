-- Removes the discontinued Flowdesk timeclock module from existing databases.

drop function if exists public.get_timeclock_dashboard_totals(text, date);
drop function if exists public.get_timeclock_ranking(text, date, date, integer, integer);

drop table if exists public.timeclock_approvals cascade;
drop table if exists public.timeclock_hour_bank cascade;
drop table if exists public.timeclock_adjustments cascade;
drop table if exists public.timeclock_events cascade;
drop table if exists public.timeclock_intervals cascade;
drop table if exists public.timeclock_sessions cascade;
drop table if exists public.timeclock_exceptions cascade;
drop table if exists public.timeclock_user_schedule_overrides cascade;
drop table if exists public.timeclock_schedule_days cascade;
drop table if exists public.guild_timeclock_settings cascade;

drop type if exists public.timeclock_event_type cascade;
drop type if exists public.timeclock_interval_type cascade;
drop type if exists public.timeclock_approval_status cascade;
drop type if exists public.timeclock_session_status cascade;

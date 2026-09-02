create table if not exists public.guild_suggestions_settings (
  id bigint generated always as identity primary key,
  guild_id text not null unique,
  enabled boolean not null default false,
  panel_channel_id text null,
  publish_channel_id text null,
  logs_channel_id text null,
  panel_layout jsonb not null default '[]'::jsonb,
  panel_title text not null default '',
  panel_description text not null default '',
  panel_button_label text not null default '',
  panel_message_id text null,
  suggestion_layout jsonb not null default '[]'::jsonb,
  published_header text not null default 'NOVA SUGESTAO ENVIADA!',
  published_footer text not null default 'Flowdesk | Sistema de sugestoes',
  thread_name_prefix text not null default 'Debater sugestao',
  configured_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.guild_suggestions (
  id bigint generated always as identity primary key,
  guild_id text not null,
  author_user_id text not null,
  title text not null,
  body text not null,
  status text not null default 'open',
  publish_channel_id text null,
  message_id text null,
  thread_id text null,
  yes_votes integer not null default 0,
  no_votes integer not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_suggestions_status_check
    check (status in ('open', 'closed', 'approved', 'rejected'))
);

create table if not exists public.guild_suggestion_votes (
  id bigint generated always as identity primary key,
  suggestion_id bigint not null references public.guild_suggestions(id) on delete cascade,
  guild_id text not null,
  user_id text not null,
  vote text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_suggestion_votes_vote_check
    check (vote in ('yes', 'no')),
  constraint guild_suggestion_votes_unique_member unique (suggestion_id, user_id)
);

create table if not exists public.guild_suggestion_vote_events (
  id bigint generated always as identity primary key,
  suggestion_id bigint not null references public.guild_suggestions(id) on delete cascade,
  guild_id text not null,
  user_id text not null,
  previous_vote text null,
  new_vote text null,
  action text not null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint guild_suggestion_vote_events_action_check
    check (action in ('cast', 'change', 'remove')),
  constraint guild_suggestion_vote_events_previous_vote_check
    check (previous_vote is null or previous_vote in ('yes', 'no')),
  constraint guild_suggestion_vote_events_new_vote_check
    check (new_vote is null or new_vote in ('yes', 'no'))
);

create index if not exists idx_guild_suggestions_guild_id
  on public.guild_suggestions (guild_id);

create index if not exists idx_guild_suggestions_status
  on public.guild_suggestions (guild_id, status);

create index if not exists idx_guild_suggestion_votes_suggestion_id
  on public.guild_suggestion_votes (suggestion_id);

create index if not exists idx_guild_suggestion_votes_guild_id
  on public.guild_suggestion_votes (guild_id);

create index if not exists idx_guild_suggestion_vote_events_suggestion_id
  on public.guild_suggestion_vote_events (suggestion_id);

drop trigger if exists tr_guild_suggestions_settings_updated_at on public.guild_suggestions_settings;
create trigger tr_guild_suggestions_settings_updated_at
before update on public.guild_suggestions_settings
for each row
execute function public.set_updated_at();

drop trigger if exists tr_guild_suggestions_updated_at on public.guild_suggestions;
create trigger tr_guild_suggestions_updated_at
before update on public.guild_suggestions
for each row
execute function public.set_updated_at();

drop trigger if exists tr_guild_suggestion_votes_updated_at on public.guild_suggestion_votes;
create trigger tr_guild_suggestion_votes_updated_at
before update on public.guild_suggestion_votes
for each row
execute function public.set_updated_at();

alter table public.guild_suggestions_settings enable row level security;
alter table public.guild_suggestions enable row level security;
alter table public.guild_suggestion_votes enable row level security;
alter table public.guild_suggestion_vote_events enable row level security;

drop policy if exists "service_role_all_guild_suggestions_settings" on public.guild_suggestions_settings;
create policy "service_role_all_guild_suggestions_settings"
on public.guild_suggestions_settings
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_guild_suggestions" on public.guild_suggestions;
create policy "service_role_all_guild_suggestions"
on public.guild_suggestions
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_guild_suggestion_votes" on public.guild_suggestion_votes;
create policy "service_role_all_guild_suggestion_votes"
on public.guild_suggestion_votes
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_guild_suggestion_vote_events" on public.guild_suggestion_vote_events;
create policy "service_role_all_guild_suggestion_vote_events"
on public.guild_suggestion_vote_events
for all
to service_role
using (true)
with check (true);

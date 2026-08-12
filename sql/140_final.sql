begin;

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.auth_users (
  id bigint generated always as identity primary key,
  discord_user_id text unique,
  google_user_id text,
  microsoft_user_id text,
  username text not null,
  global_name text,
  display_name text not null,
  avatar text,
  profile_avatar_url text,
  profile_avatar_source text,
  profile_avatar_updated_at timestamptz,
  email text,
  email_normalized text,
  email_verified_at timestamptz,
  locale text,
  raw_user jsonb not null default '{}'::jsonb,
  last_login_at timestamptz,
  last_auth_method text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.auth_users
  add column if not exists discord_user_id text,
  add column if not exists google_user_id text,
  add column if not exists microsoft_user_id text,
  add column if not exists username text,
  add column if not exists global_name text,
  add column if not exists display_name text,
  add column if not exists avatar text,
  add column if not exists profile_avatar_url text,
  add column if not exists profile_avatar_source text,
  add column if not exists profile_avatar_updated_at timestamptz,
  add column if not exists email text,
  add column if not exists email_normalized text,
  add column if not exists email_verified_at timestamptz,
  add column if not exists locale text,
  add column if not exists raw_user jsonb not null default '{}'::jsonb,
  add column if not exists last_login_at timestamptz,
  add column if not exists last_auth_method text,
  add column if not exists created_at timestamptz not null default timezone('utc', now()),
  add column if not exists updated_at timestamptz not null default timezone('utc', now());

alter table public.auth_users
  alter column discord_user_id drop not null;

update public.auth_users
set
  email = nullif(lower(trim(email)), ''),
  email_normalized = nullif(lower(trim(email)), '')
where email is not null
  and (
    email is distinct from nullif(lower(trim(email)), '')
    or email_normalized is distinct from nullif(lower(trim(email)), '')
  );

update public.auth_users
set
  username = left(
    coalesce(
      nullif(
        regexp_replace(
          regexp_replace(
            regexp_replace(lower(trim(coalesce(username, display_name, email, 'flowdesk-user'))), '[^a-z0-9._-]+', '-', 'g'),
            '-{2,}',
            '-',
            'g'
          ),
          '^[-._]+|[-._]+$',
          '',
          'g'
        ),
        ''
      ),
      'flowdesk-user'
    ),
    32
  )
where username is null or btrim(username) = '';

update public.auth_users
set display_name = coalesce(nullif(btrim(display_name), ''), username, 'Flowdesk User')
where display_name is null or btrim(display_name) = '';

do $$
declare
  duplicate_record record;
  base_username text;
  candidate_username text;
  suffix_number integer;
begin
  for duplicate_record in
    select id, username
    from (
      select
        id,
        username,
        row_number() over (
          partition by username
          order by id
        ) as duplicate_rank
      from public.auth_users
      where username is not null
    ) duplicated
    where duplicate_rank > 1
    order by id
  loop
    base_username := lower(trim(coalesce(duplicate_record.username, 'flowdesk-user')));
    base_username := regexp_replace(base_username, '[^a-z0-9._-]+', '-', 'g');
    base_username := regexp_replace(base_username, '-{2,}', '-', 'g');
    base_username := regexp_replace(base_username, '^[-._]+|[-._]+$', '', 'g');
    base_username := left(nullif(base_username, ''), 32);

    if base_username is null then
      base_username := 'flowdesk-user';
    end if;

    candidate_username := base_username;
    suffix_number := 2;

    while exists (
      select 1
      from public.auth_users
      where username = candidate_username
        and id <> duplicate_record.id
    ) loop
      candidate_username :=
        left(
          base_username,
          greatest(1, 32 - char_length('-' || suffix_number::text))
        ) || '-' || suffix_number::text;
      suffix_number := suffix_number + 1;
    end loop;

    update public.auth_users
    set username = candidate_username
    where id = duplicate_record.id;
  end loop;
end
$$;

update public.auth_users
set
  profile_avatar_url =
    'https://cdn.discordapp.com/avatars/' || discord_user_id || '/' || avatar ||
    case when avatar like 'a\_%' escape '\' then '.gif?size=512' else '.png?size=512' end,
  profile_avatar_source = 'discord',
  profile_avatar_updated_at = coalesce(updated_at, timezone('utc', now()))
where profile_avatar_url is null
  and discord_user_id is not null
  and avatar is not null;

create unique index if not exists idx_auth_users_username_unique
on public.auth_users (username);

create unique index if not exists idx_auth_users_email_normalized_unique
on public.auth_users (email_normalized)
where email_normalized is not null;

create index if not exists idx_auth_users_discord_user_id_not_null
on public.auth_users (discord_user_id)
where discord_user_id is not null;

create unique index if not exists idx_auth_users_google_user_id_unique
on public.auth_users (google_user_id)
where google_user_id is not null;

create unique index if not exists idx_auth_users_microsoft_user_id_unique
on public.auth_users (microsoft_user_id)
where microsoft_user_id is not null;

drop trigger if exists tr_auth_users_updated_at on public.auth_users;
create trigger tr_auth_users_updated_at
before update on public.auth_users
for each row execute function public.set_updated_at();

create table if not exists public.auth_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.auth_users(id) on delete cascade,
  session_token_hash text not null unique,
  ip_address text,
  user_agent text,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  discord_access_token text,
  discord_refresh_token text,
  discord_token_expires_at timestamptz,
  auth_method text not null default 'email',
  otp_verified_at timestamptz,
  remembered_until timestamptz,
  active_guild_id text,
  discord_guilds_cache jsonb,
  discord_guilds_cached_at timestamptz,
  config_current_step integer,
  config_draft jsonb,
  config_context_updated_at timestamptz,
  last_seen_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now())
);

alter table public.auth_sessions
  add column if not exists discord_access_token text,
  add column if not exists discord_refresh_token text,
  add column if not exists discord_token_expires_at timestamptz,
  add column if not exists auth_method text,
  add column if not exists otp_verified_at timestamptz,
  add column if not exists remembered_until timestamptz,
  add column if not exists active_guild_id text,
  add column if not exists discord_guilds_cache jsonb,
  add column if not exists discord_guilds_cached_at timestamptz,
  add column if not exists config_current_step integer,
  add column if not exists config_draft jsonb,
  add column if not exists config_context_updated_at timestamptz,
  add column if not exists last_seen_at timestamptz;

update public.auth_sessions s
set auth_method = coalesce(
  s.auth_method,
  case
    when s.discord_access_token is not null then 'discord'
    when u.google_user_id is not null and u.discord_user_id is null then 'google'
    when u.microsoft_user_id is not null and u.discord_user_id is null then 'microsoft'
    else 'email'
  end
)
from public.auth_users u
where u.id = s.user_id
  and s.auth_method is null;

update public.auth_sessions
set
  auth_method = coalesce(auth_method, 'email'),
  last_seen_at = coalesce(last_seen_at, created_at, timezone('utc', now()))
where auth_method is null
  or last_seen_at is null;

alter table public.auth_sessions
  alter column auth_method set default 'email',
  alter column last_seen_at set default timezone('utc', now());

alter table public.auth_sessions
  drop constraint if exists auth_sessions_auth_method_check;

alter table public.auth_sessions
  add constraint auth_sessions_auth_method_check
  check (auth_method in ('email', 'discord', 'google', 'microsoft'));

alter table public.auth_sessions
  drop constraint if exists auth_sessions_config_current_step_check;

alter table public.auth_sessions
  add constraint auth_sessions_config_current_step_check
  check (config_current_step is null or config_current_step between 1 and 4);

create index if not exists idx_auth_sessions_user_id
on public.auth_sessions (user_id);

create index if not exists idx_auth_sessions_expires_at
on public.auth_sessions (expires_at);

create index if not exists idx_auth_sessions_revoked_at
on public.auth_sessions (revoked_at);

create index if not exists idx_auth_sessions_discord_token_expires_at
on public.auth_sessions (discord_token_expires_at);

create index if not exists idx_auth_sessions_active_guild_id
on public.auth_sessions (active_guild_id);

create index if not exists idx_auth_sessions_discord_guilds_cached_at
on public.auth_sessions (discord_guilds_cached_at);

create index if not exists idx_auth_sessions_config_current_step
on public.auth_sessions (config_current_step);

create index if not exists idx_auth_sessions_config_context_updated_at
on public.auth_sessions (config_context_updated_at);

create index if not exists idx_auth_sessions_auth_method_expires_at
on public.auth_sessions (auth_method, expires_at desc);

create index if not exists idx_auth_sessions_remembered_until
on public.auth_sessions (remembered_until)
where remembered_until is not null;

create index if not exists idx_auth_sessions_user_activity
on public.auth_sessions (user_id, revoked_at, last_seen_at desc);

create table if not exists public.auth_user_credentials (
  user_id bigint primary key references public.auth_users(id) on delete cascade,
  password_hash text not null,
  password_version integer not null default 1,
  password_set_at timestamptz not null default timezone('utc', now()),
  last_password_login_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_user_credentials_password_hash_length_check
    check (char_length(password_hash) >= 32)
);

drop trigger if exists tr_auth_user_credentials_updated_at on public.auth_user_credentials;
create trigger tr_auth_user_credentials_updated_at
before update on public.auth_user_credentials
for each row execute function public.set_updated_at();

create table if not exists public.auth_email_otp_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.auth_users(id) on delete cascade,
  email text not null,
  email_normalized text not null,
  purpose text not null default 'login',
  code_hash text not null,
  ip_address text,
  user_agent text,
  attempts integer not null default 0,
  max_attempts integer not null default 6,
  resend_count integer not null default 0,
  last_sent_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_email_otp_challenges_attempts_check
    check (attempts >= 0 and attempts <= 50),
  constraint auth_email_otp_challenges_resend_count_check
    check (resend_count >= 0 and resend_count <= 20)
);

alter table public.auth_email_otp_challenges
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.auth_email_otp_challenges
  drop constraint if exists auth_email_otp_challenges_purpose_check;

alter table public.auth_email_otp_challenges
  add constraint auth_email_otp_challenges_purpose_check
  check (purpose in (
    'login',
    'email_registration',
    'email_change_current',
    'email_change_new'
  ));

drop trigger if exists tr_auth_email_otp_challenges_updated_at on public.auth_email_otp_challenges;
create trigger tr_auth_email_otp_challenges_updated_at
before update on public.auth_email_otp_challenges
for each row execute function public.set_updated_at();

create index if not exists idx_auth_email_otp_challenges_user_created_at
on public.auth_email_otp_challenges (user_id, created_at desc);

create index if not exists idx_auth_email_otp_challenges_email_created_at
on public.auth_email_otp_challenges (email_normalized, created_at desc);

create index if not exists idx_auth_email_otp_challenges_expires_at
on public.auth_email_otp_challenges (expires_at);

create index if not exists idx_auth_email_otp_challenges_active
on public.auth_email_otp_challenges (email_normalized, expires_at desc)
where consumed_at is null;

create index if not exists idx_auth_email_otp_challenges_active_user_purpose
on public.auth_email_otp_challenges (user_id, purpose, expires_at desc)
where consumed_at is null;

create table if not exists public.auth_user_trusted_devices (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.auth_users(id) on delete cascade,
  token_hash text not null unique,
  user_agent_hash text,
  last_used_at timestamptz,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_user_trusted_devices_token_hash_length_check
    check (char_length(token_hash) >= 32)
);

alter table public.auth_user_trusted_devices
  add column if not exists user_agent_hash text,
  add column if not exists last_used_at timestamptz,
  add column if not exists revoked_at timestamptz;

drop trigger if exists tr_auth_user_trusted_devices_updated_at on public.auth_user_trusted_devices;
create trigger tr_auth_user_trusted_devices_updated_at
before update on public.auth_user_trusted_devices
for each row execute function public.set_updated_at();

create index if not exists idx_auth_user_trusted_devices_user_expires_at
on public.auth_user_trusted_devices (user_id, expires_at desc);

create index if not exists idx_auth_user_trusted_devices_active
on public.auth_user_trusted_devices (user_id, expires_at desc)
where revoked_at is null;

create table if not exists public.auth_account_email_changes (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.auth_users(id) on delete cascade,
  current_email text,
  new_email text not null,
  new_email_normalized text not null,
  current_challenge_id uuid references public.auth_email_otp_challenges(id) on delete set null,
  new_challenge_id uuid references public.auth_email_otp_challenges(id) on delete set null,
  current_verified_at timestamptz,
  new_verified_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists tr_auth_account_email_changes_updated_at on public.auth_account_email_changes;
create trigger tr_auth_account_email_changes_updated_at
before update on public.auth_account_email_changes
for each row execute function public.set_updated_at();

create unique index if not exists idx_auth_account_email_changes_active_user
on public.auth_account_email_changes (user_id)
where completed_at is null and cancelled_at is null;

create unique index if not exists idx_auth_account_email_changes_active_email
on public.auth_account_email_changes (new_email_normalized)
where completed_at is null and cancelled_at is null;

create index if not exists idx_auth_account_email_changes_expires_at
on public.auth_account_email_changes (expires_at);

create table if not exists public.auth_user_provider_profiles (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  provider text not null check (provider in ('discord', 'google', 'microsoft', 'github')),
  provider_user_id text not null,
  provider_email text,
  provider_display_name text,
  provider_avatar_url text,
  linked_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, provider),
  unique (provider, provider_user_id)
);

drop trigger if exists tr_auth_user_provider_profiles_updated_at on public.auth_user_provider_profiles;
create trigger tr_auth_user_provider_profiles_updated_at
before update on public.auth_user_provider_profiles
for each row execute function public.set_updated_at();

create index if not exists idx_auth_user_provider_profiles_user
on public.auth_user_provider_profiles (user_id, provider);

create table if not exists public.auth_user_totp (
  user_id bigint primary key references public.auth_users(id) on delete cascade,
  secret_encrypted text not null,
  enabled boolean not null default false,
  verified_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists tr_auth_user_totp_updated_at on public.auth_user_totp;
create trigger tr_auth_user_totp_updated_at
before update on public.auth_user_totp
for each row execute function public.set_updated_at();

create table if not exists public.auth_user_passkeys (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.auth_users(id) on delete cascade,
  credential_id text not null unique,
  public_key text not null,
  counter bigint not null default 0,
  transports text[] not null default '{}'::text[],
  device_type text,
  backed_up boolean not null default false,
  name text not null default 'Passkey',
  last_used_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists tr_auth_user_passkeys_updated_at on public.auth_user_passkeys;
create trigger tr_auth_user_passkeys_updated_at
before update on public.auth_user_passkeys
for each row execute function public.set_updated_at();

create index if not exists idx_auth_user_passkeys_user_created_at
on public.auth_user_passkeys (user_id, created_at desc);

create table if not exists public.auth_security_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.auth_users(id) on delete cascade,
  kind text not null,
  challenge text not null,
  metadata jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

alter table public.auth_security_challenges
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.auth_security_challenges
  drop constraint if exists auth_security_challenges_kind_check;

alter table public.auth_security_challenges
  add constraint auth_security_challenges_kind_check
  check (kind in (
    'passkey_registration',
    'passkey_authentication',
    'two_factor_login',
    'sensitive_action'
  ));

create index if not exists idx_auth_security_challenges_active
on public.auth_security_challenges (user_id, kind, expires_at desc)
where consumed_at is null;

create index if not exists idx_auth_security_challenges_sensitive_action
on public.auth_security_challenges (user_id, expires_at desc)
where kind = 'sensitive_action' and consumed_at is null;

alter table public.auth_users enable row level security;
alter table public.auth_sessions enable row level security;
alter table public.auth_user_credentials enable row level security;
alter table public.auth_email_otp_challenges enable row level security;
alter table public.auth_user_trusted_devices enable row level security;
alter table public.auth_account_email_changes enable row level security;
alter table public.auth_user_provider_profiles enable row level security;
alter table public.auth_user_totp enable row level security;
alter table public.auth_user_passkeys enable row level security;
alter table public.auth_security_challenges enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    drop policy if exists "service_role_all_auth_users" on public.auth_users;
    create policy "service_role_all_auth_users"
      on public.auth_users for all to service_role
      using (true) with check (true);

    drop policy if exists "service_role_all_auth_sessions" on public.auth_sessions;
    create policy "service_role_all_auth_sessions"
      on public.auth_sessions for all to service_role
      using (true) with check (true);

    drop policy if exists "service_role_all_auth_user_credentials" on public.auth_user_credentials;
    create policy "service_role_all_auth_user_credentials"
      on public.auth_user_credentials for all to service_role
      using (true) with check (true);

    drop policy if exists "service_role_all_auth_email_otp_challenges" on public.auth_email_otp_challenges;
    create policy "service_role_all_auth_email_otp_challenges"
      on public.auth_email_otp_challenges for all to service_role
      using (true) with check (true);

    drop policy if exists "service_role_all_auth_user_trusted_devices" on public.auth_user_trusted_devices;
    create policy "service_role_all_auth_user_trusted_devices"
      on public.auth_user_trusted_devices for all to service_role
      using (true) with check (true);

    drop policy if exists auth_account_email_changes_service_role_all on public.auth_account_email_changes;
    create policy auth_account_email_changes_service_role_all
      on public.auth_account_email_changes for all to service_role
      using (true) with check (true);

    drop policy if exists auth_user_provider_profiles_service_role_all on public.auth_user_provider_profiles;
    create policy auth_user_provider_profiles_service_role_all
      on public.auth_user_provider_profiles for all to service_role
      using (true) with check (true);

    drop policy if exists auth_user_totp_service_role_all on public.auth_user_totp;
    create policy auth_user_totp_service_role_all
      on public.auth_user_totp for all to service_role
      using (true) with check (true);

    drop policy if exists auth_user_passkeys_service_role_all on public.auth_user_passkeys;
    create policy auth_user_passkeys_service_role_all
      on public.auth_user_passkeys for all to service_role
      using (true) with check (true);

    drop policy if exists auth_security_challenges_service_role_all on public.auth_security_challenges;
    create policy auth_security_challenges_service_role_all
      on public.auth_security_challenges for all to service_role
      using (true) with check (true);
  end if;
end
$$;

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'account-avatars',
      'account-avatars',
      true,
      5242880,
      array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
    )
    on conflict (id) do update
    set
      public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
  end if;
end
$$;

commit;

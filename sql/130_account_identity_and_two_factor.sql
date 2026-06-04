begin;

create extension if not exists pgcrypto;

alter table public.auth_users
  add column if not exists profile_avatar_url text,
  add column if not exists profile_avatar_source text,
  add column if not exists profile_avatar_updated_at timestamptz;

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

create index if not exists idx_auth_user_provider_profiles_user
on public.auth_user_provider_profiles (user_id, provider);

create unique index if not exists idx_auth_account_email_changes_active_user
on public.auth_account_email_changes (user_id)
where completed_at is null and cancelled_at is null;

create unique index if not exists idx_auth_account_email_changes_active_email
on public.auth_account_email_changes (new_email_normalized)
where completed_at is null and cancelled_at is null;

create index if not exists idx_auth_account_email_changes_expires_at
on public.auth_account_email_changes (expires_at);

create table if not exists public.auth_user_totp (
  user_id bigint primary key references public.auth_users(id) on delete cascade,
  secret_encrypted text not null,
  enabled boolean not null default false,
  verified_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

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

create index if not exists idx_auth_user_passkeys_user_created_at
on public.auth_user_passkeys (user_id, created_at desc);

create table if not exists public.auth_security_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.auth_users(id) on delete cascade,
  kind text not null check (kind in ('passkey_registration', 'passkey_authentication', 'two_factor_login', 'sensitive_action')),
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
  check (kind in ('passkey_registration', 'passkey_authentication', 'two_factor_login', 'sensitive_action'));

create index if not exists idx_auth_security_challenges_active
on public.auth_security_challenges (user_id, kind, expires_at desc)
where consumed_at is null;

drop trigger if exists tr_auth_account_email_changes_updated_at on public.auth_account_email_changes;
create trigger tr_auth_account_email_changes_updated_at
before update on public.auth_account_email_changes
for each row execute function public.set_updated_at();

drop trigger if exists tr_auth_user_provider_profiles_updated_at on public.auth_user_provider_profiles;
create trigger tr_auth_user_provider_profiles_updated_at
before update on public.auth_user_provider_profiles
for each row execute function public.set_updated_at();

drop trigger if exists tr_auth_user_totp_updated_at on public.auth_user_totp;
create trigger tr_auth_user_totp_updated_at
before update on public.auth_user_totp
for each row execute function public.set_updated_at();

drop trigger if exists tr_auth_user_passkeys_updated_at on public.auth_user_passkeys;
create trigger tr_auth_user_passkeys_updated_at
before update on public.auth_user_passkeys
for each row execute function public.set_updated_at();

alter table public.auth_account_email_changes enable row level security;
alter table public.auth_user_provider_profiles enable row level security;
alter table public.auth_user_totp enable row level security;
alter table public.auth_user_passkeys enable row level security;
alter table public.auth_security_challenges enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
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

commit;

begin;

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

create index if not exists idx_auth_security_challenges_sensitive_action
on public.auth_security_challenges (user_id, expires_at desc)
where kind = 'sensitive_action' and consumed_at is null;

commit;

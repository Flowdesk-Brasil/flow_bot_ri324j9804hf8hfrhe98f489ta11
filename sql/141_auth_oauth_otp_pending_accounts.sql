-- Permite criar desafios OTP antes de existir auth_users.
-- O usuario definitivo e criado/vinculado apenas apos consumo valido do codigo.
alter table public.auth_email_otp_challenges
  alter column user_id drop not null;

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

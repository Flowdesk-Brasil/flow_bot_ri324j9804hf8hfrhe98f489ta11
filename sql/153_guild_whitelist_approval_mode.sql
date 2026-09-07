-- Modo de aprovacao da whitelist: analise da staff ou liberacao automatica.

alter table public.guild_whitelist_settings
  add column if not exists approval_mode text not null default 'manual';

alter table public.guild_whitelist_settings
  drop constraint if exists guild_whitelist_approval_mode_check;

alter table public.guild_whitelist_settings
  add constraint guild_whitelist_approval_mode_check
  check (approval_mode in ('manual', 'automatic'));

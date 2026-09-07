-- Formato do apelido apos liberar a whitelist.

alter table public.guild_whitelist_settings
  add column if not exists nickname_format text not null default '{nome} | {ID}';

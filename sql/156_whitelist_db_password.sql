-- Senha do MySQL da cidade: mesma coluna text usada pelo painel.
-- Rode no Supabase SQL Editor se a senha nao estiver gravando.

alter table public.guild_whitelist_settings
  add column if not exists db_password_cipher text;

alter table public.guild_whitelist_settings
  alter column db_password_cipher type text;

alter table public.guild_whitelist_settings
  add column if not exists db_host text,
  add column if not exists db_name text,
  add column if not exists db_user text,
  add column if not exists db_port integer,
  add column if not exists db_engine text,
  add column if not exists db_ssl boolean,
  add column if not exists last_health_ok boolean,
  add column if not exists last_health_error text,
  add column if not exists last_health_at timestamptz,
  add column if not exists last_health_latency_ms integer,
  add column if not exists mapping jsonb,
  add column if not exists mapping_status text,
  add column if not exists agent_public_ip text;

comment on column public.guild_whitelist_settings.db_password_cipher is
  'Senha do MySQL da cidade, criptografada (FlowSecure ou wl.v1). Nunca grave senha em claro.';

-- Nome informado no modal da whitelist, usado no nick apos aprovacao.

alter table public.guild_whitelist_requests
  add column if not exists player_name text null;

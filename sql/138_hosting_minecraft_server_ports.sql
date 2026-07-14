begin;

alter table if exists public.hosting_minecraft_servers
  add column if not exists server_port integer,
  add column if not exists rcon_port integer;

update public.hosting_minecraft_servers
set
  server_port = coalesce(server_port, 25565),
  rcon_port = coalesce(rcon_port, 30000)
where server_port is null
   or rcon_port is null;

alter table if exists public.hosting_minecraft_servers
  drop constraint if exists hosting_minecraft_servers_server_port_check,
  add constraint hosting_minecraft_servers_server_port_check
    check (server_port between 25565 and 29999);

alter table if exists public.hosting_minecraft_servers
  drop constraint if exists hosting_minecraft_servers_rcon_port_check,
  add constraint hosting_minecraft_servers_rcon_port_check
    check (rcon_port between 30000 and 34999);

create unique index if not exists idx_hosting_minecraft_servers_server_port
  on public.hosting_minecraft_servers (server_port)
  where server_port is not null;

create unique index if not exists idx_hosting_minecraft_servers_rcon_port
  on public.hosting_minecraft_servers (rcon_port)
  where rcon_port is not null;

commit;

-- Flowdesk hosting: Minecraft control-plane persistence.
-- Stores the Minecraft choices made during onboarding and the worlds created later.

alter table if exists public.hosting_projects
  drop constraint if exists hosting_projects_hosting_kind_check;

alter table if exists public.hosting_projects
  add constraint hosting_projects_hosting_kind_check
  check (hosting_kind in ('site', 'bot', 'cdn', 'minecraft'));

create table if not exists public.hosting_minecraft_servers (
  id bigserial primary key,
  hosting_project_id bigint not null references public.hosting_projects(id) on delete cascade,
  payment_order_id bigint references public.payment_orders(id) on delete set null,
  user_id bigint not null,
  server_name text not null,
  server_slug text not null,
  minecraft_version text not null,
  server_type text not null,
  primary_domain text not null,
  fixed_domain text,
  cloudflare_status text not null default 'pending',
  cloudflare_payload jsonb not null default '{}'::jsonb,
  limits jsonb not null default '{}'::jsonb,
  status text not null default 'created',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hosting_minecraft_servers_type_check
    check (server_type in ('paper', 'purpur', 'fabric', 'forge', 'neoforge', 'vanilla')),
  constraint hosting_minecraft_servers_slug_check
    check (server_slug ~ '^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$')
);

create unique index if not exists idx_hosting_minecraft_servers_project
  on public.hosting_minecraft_servers (hosting_project_id);

create unique index if not exists idx_hosting_minecraft_servers_primary_domain
  on public.hosting_minecraft_servers (lower(primary_domain));

create index if not exists idx_hosting_minecraft_servers_user_created
  on public.hosting_minecraft_servers (user_id, created_at desc);

create table if not exists public.hosting_minecraft_worlds (
  id bigserial primary key,
  minecraft_server_id bigint not null references public.hosting_minecraft_servers(id) on delete cascade,
  hosting_project_id bigint not null references public.hosting_projects(id) on delete cascade,
  world_slug text not null,
  world_name text not null,
  status text not null default 'created',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hosting_minecraft_worlds_slug_check
    check (world_slug ~ '^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$')
);

create unique index if not exists idx_hosting_minecraft_worlds_server_slug
  on public.hosting_minecraft_worlds (minecraft_server_id, world_slug);

create index if not exists idx_hosting_minecraft_worlds_project_created
  on public.hosting_minecraft_worlds (hosting_project_id, created_at desc);

drop trigger if exists tr_hosting_minecraft_servers_updated_at on public.hosting_minecraft_servers;
create trigger tr_hosting_minecraft_servers_updated_at
before update on public.hosting_minecraft_servers
for each row execute function public.set_updated_at();

drop trigger if exists tr_hosting_minecraft_worlds_updated_at on public.hosting_minecraft_worlds;
create trigger tr_hosting_minecraft_worlds_updated_at
before update on public.hosting_minecraft_worlds
for each row execute function public.set_updated_at();

alter table public.hosting_minecraft_servers enable row level security;
alter table public.hosting_minecraft_worlds enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    drop policy if exists hosting_minecraft_servers_service_role_all on public.hosting_minecraft_servers;
    create policy hosting_minecraft_servers_service_role_all
      on public.hosting_minecraft_servers for all to service_role
      using (true) with check (true);

    drop policy if exists hosting_minecraft_worlds_service_role_all on public.hosting_minecraft_worlds;
    create policy hosting_minecraft_worlds_service_role_all
      on public.hosting_minecraft_worlds for all to service_role
      using (true) with check (true);
  end if;
end
$$;

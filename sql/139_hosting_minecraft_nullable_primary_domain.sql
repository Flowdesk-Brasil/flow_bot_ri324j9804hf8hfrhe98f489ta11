begin;

alter table if exists public.hosting_minecraft_servers
  alter column primary_domain drop not null;

commit;

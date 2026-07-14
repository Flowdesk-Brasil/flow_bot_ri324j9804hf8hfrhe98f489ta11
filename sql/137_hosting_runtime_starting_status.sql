begin;

alter table if exists public.hosting_projects
  drop constraint if exists hosting_projects_runtime_status_check;

alter table if exists public.hosting_projects
  add constraint hosting_projects_runtime_status_check
  check (runtime_status in ('online', 'offline', 'starting', 'restarting', 'deploying', 'crashed', 'suspended', 'unknown'));

commit;

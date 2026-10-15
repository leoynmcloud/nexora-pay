-- Persist provider health observations without credentials or response bodies.
-- Apply after nexora-production-ledger.sql, credentials, and nexora-security-hardening.sql.
begin;

do $$ begin
  if to_regclass('public.nexora_acquirers') is null
     or to_regclass('public.nexora_platform_provider_credentials') is null
     or to_regprocedure('public.is_nexora_super_admin()') is null then
    raise exception 'Apply provider catalog, central credentials, and security hardening first.';
  end if;
end $$;

create table if not exists public.nexora_provider_health_checks (
  id uuid primary key default gen_random_uuid(),
  acquirer_id uuid not null references public.nexora_acquirers(id) on delete restrict,
  environment text not null check (environment in ('production','sandbox')),
  status text not null check (status in ('ONLINE','DEGRADED','OFFLINE','UNKNOWN')),
  latency_ms integer check (latency_ms is null or latency_ms between 0 and 60000),
  http_status integer check (http_status is null or http_status between 100 and 599),
  error_code text check (error_code is null or error_code ~ '^[a-z0-9_]{1,80}$'),
  checked_at timestamptz not null default now(),
  check ((status='ONLINE' and http_status is not null and http_status between 200 and 299 and error_code is null)
    or status<>'ONLINE')
);
create index if not exists nexora_provider_health_latest
  on public.nexora_provider_health_checks(acquirer_id,environment,checked_at desc);

alter table public.nexora_provider_health_checks enable row level security;
revoke all on public.nexora_provider_health_checks from public,anon,authenticated,service_role;

create or replace function public.nexora_provider_health_reject_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Provider health observations are append-only.';
end;
$$;
revoke all on function public.nexora_provider_health_reject_mutation() from public,anon,authenticated,service_role;
drop trigger if exists nexora_provider_health_immutable on public.nexora_provider_health_checks;
create trigger nexora_provider_health_immutable
  before update or delete on public.nexora_provider_health_checks
  for each row execute function public.nexora_provider_health_reject_mutation();

create or replace function public.nexora_provider_health_record(
  p_acquirer_id uuid,p_environment text,p_status text,p_latency_ms integer,p_http_status integer,p_error_code text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_acquirer_id is null or p_environment is null or p_environment not in ('production','sandbox')
     or p_status is null or p_status not in ('ONLINE','DEGRADED','OFFLINE','UNKNOWN')
     or (p_latency_ms is not null and p_latency_ms not between 0 and 60000)
     or (p_http_status is not null and p_http_status not between 100 and 599)
     or (p_error_code is not null and p_error_code !~ '^[a-z0-9_]{1,80}$')
     or (p_status='ONLINE' and (p_http_status is null or p_http_status not between 200 and 299 or p_error_code is not null)) then
    raise exception 'Invalid provider health observation.';
  end if;
  if not exists(select 1 from public.nexora_acquirers a where a.id=p_acquirer_id and a.environment=p_environment) then
    raise exception 'Provider health observation does not match the configured environment.';
  end if;
  insert into public.nexora_provider_health_checks(acquirer_id,environment,status,latency_ms,http_status,error_code)
    values(p_acquirer_id,p_environment,p_status,p_latency_ms,p_http_status,p_error_code) returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.nexora_provider_health_record(uuid,text,text,integer,integer,text) from public,anon,authenticated;
grant execute on function public.nexora_provider_health_record(uuid,text,text,integer,integer,text) to service_role;

create or replace function public.nexora_admin_provider_health_snapshot()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_nexora_super_admin() then raise exception 'Super Admin com MFA obrigatório.'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'acquirer_id',q.acquirer_id,'code',q.code,'name',q.name,'environment',q.environment,
      'status',q.status,'latency_ms',q.latency_ms,'http_status',q.http_status,
      'error_code',q.error_code,'checked_at',q.checked_at
    ) order by q.name,q.environment)
    from (
      select distinct on (a.id,a.environment) a.id as acquirer_id,a.code,a.name,a.environment,
        h.status,h.latency_ms,h.http_status,h.error_code,h.checked_at
      from public.nexora_acquirers a
      left join public.nexora_provider_health_checks h
        on h.acquirer_id=a.id and h.environment=a.environment
      where a.status<>'disabled'
      order by a.id,a.environment,h.checked_at desc nulls last
    ) q
  ),'[]'::jsonb);
end;
$$;
revoke all on function public.nexora_admin_provider_health_snapshot() from public,anon;
grant execute on function public.nexora_admin_provider_health_snapshot() to authenticated;

notify pgrst,'reload schema';
commit;

select c.relname as table_name,c.relrowsecurity as rls_enabled,
  has_table_privilege('anon',c.oid,'SELECT') as anon_can_select,
  has_table_privilege('authenticated',c.oid,'SELECT') as authenticated_can_select,
  has_table_privilege('authenticated',c.oid,'INSERT') as authenticated_can_insert,
  has_table_privilege('authenticated',c.oid,'UPDATE') as authenticated_can_update,
  has_table_privilege('authenticated',c.oid,'DELETE') as authenticated_can_delete,
  has_table_privilege('service_role',c.oid,'SELECT') as service_role_can_select,
  has_table_privilege('service_role',c.oid,'INSERT') as service_role_can_insert,
  has_table_privilege('service_role',c.oid,'UPDATE') as service_role_can_update,
  has_table_privilege('service_role',c.oid,'DELETE') as service_role_can_delete
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname='nexora_provider_health_checks';

select p.oid::regprocedure as function_name,
  has_function_privilege('anon',p.oid,'EXECUTE') as anon_can_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_can_execute,
  has_function_privilege('service_role',p.oid,'EXECUTE') as service_role_can_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('nexora_provider_health_record','nexora_admin_provider_health_snapshot')
order by p.proname;

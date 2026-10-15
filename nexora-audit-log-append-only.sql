-- Protect the administrative audit trail from application-role edits/deletes.
-- Apply after nexora-repair.sql has created public.nexora_audit_log.
begin;

do $$ begin
  if to_regclass('public.nexora_audit_log') is null
     or not exists (
       select 1 from information_schema.columns
       where table_schema='public' and table_name='nexora_audit_log' and column_name='actor_id'
     )
     or not exists (
       select 1 from information_schema.columns
       where table_schema='public' and table_name='nexora_audit_log' and column_name='action'
     )
     or not exists (
       select 1 from information_schema.columns
       where table_schema='public' and table_name='nexora_audit_log' and column_name='created_at'
     ) then
    raise exception 'Apply the migration that creates public.nexora_audit_log first.';
  end if;
end $$;

alter table public.nexora_audit_log enable row level security;
revoke all on public.nexora_audit_log from public,anon,authenticated,service_role;
grant select,insert on public.nexora_audit_log to service_role;
revoke all on sequence public.nexora_audit_log_id_seq from public,anon,authenticated,service_role;
grant usage,select on sequence public.nexora_audit_log_id_seq to service_role;

create or replace function public.nexora_audit_log_reject_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode='55000',message='Administrative audit events are append-only.';
end;
$$;
revoke all on function public.nexora_audit_log_reject_mutation() from public,anon,authenticated,service_role;

drop trigger if exists nexora_audit_log_reject_row_mutation on public.nexora_audit_log;
create trigger nexora_audit_log_reject_row_mutation
  before update or delete on public.nexora_audit_log
  for each row execute function public.nexora_audit_log_reject_mutation();

drop trigger if exists nexora_audit_log_reject_truncate on public.nexora_audit_log;
create trigger nexora_audit_log_reject_truncate
  before truncate on public.nexora_audit_log
  for each statement execute function public.nexora_audit_log_reject_mutation();

notify pgrst,'reload schema';
commit;

select c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  has_table_privilege('anon',c.oid,'SELECT') as anon_can_select,
  has_table_privilege('authenticated',c.oid,'SELECT') as authenticated_can_select,
  has_table_privilege('authenticated',c.oid,'INSERT') as authenticated_can_insert,
  has_table_privilege('authenticated',c.oid,'UPDATE') as authenticated_can_update,
  has_table_privilege('authenticated',c.oid,'DELETE') as authenticated_can_delete,
  has_table_privilege('service_role',c.oid,'SELECT') as service_role_can_select,
  has_table_privilege('service_role',c.oid,'INSERT') as service_role_can_insert,
  has_table_privilege('service_role',c.oid,'UPDATE') as service_role_can_update,
  has_table_privilege('service_role',c.oid,'DELETE') as service_role_can_delete,
  has_table_privilege('service_role',c.oid,'TRUNCATE') as service_role_can_truncate,
  has_sequence_privilege('service_role','public.nexora_audit_log_id_seq','USAGE') as service_role_sequence_usage,
  (select count(*)=2 from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal
    and t.tgname in ('nexora_audit_log_reject_row_mutation','nexora_audit_log_reject_truncate')) as append_only_triggers_installed
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname='nexora_audit_log';

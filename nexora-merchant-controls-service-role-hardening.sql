-- Prevent backend service-role credentials from editing merchant controls
-- outside the audited, Super Admin + AAL2 security-definer RPCs.
begin;

do $$ begin
  if to_regclass('public.nexora_merchant_controls') is null
     or to_regprocedure('public.nexora_admin_set_merchant_controls_v3(uuid,boolean,boolean,boolean,boolean,boolean,text,numeric,numeric,numeric,numeric,smallint)') is null
     or to_regprocedure('public.nexora_admin_configure_merchant(uuid,boolean,uuid,boolean,boolean,boolean,boolean,boolean,text,numeric,numeric,numeric,numeric,smallint)') is null then
    raise exception 'Apply nexora-reserve-holdback.sql and nexora-merchant-independent-controls.sql first.';
  end if;
end $$;

revoke insert,update,delete on public.nexora_merchant_controls
  from public,anon,authenticated,service_role;

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
where n.nspname='public' and c.relname='nexora_merchant_controls';

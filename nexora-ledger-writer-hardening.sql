-- Apply to an existing ledger installation after nexora-production-ledger.sql.
-- Direct service-role DML is removed; validated SECURITY DEFINER RPCs remain.
begin;
do $$ begin
  if to_regclass('public.nexora_ledger_accounts') is null
     or to_regclass('public.nexora_ledger_journals') is null
     or to_regclass('public.nexora_ledger_entries') is null
     or to_regprocedure('public.nexora_ledger_post_journal(uuid,uuid,uuid,text,text,text,text,jsonb,jsonb)') is null then
    raise exception 'Execute nexora-production-ledger.sql antes do hardening.';
  end if;
end $$;

-- Existing workspaces need the provider-fee expense account used by the future
-- settlement journal. No balance is imported or changed by this insert.
insert into public.nexora_ledger_accounts(owner_id,business_id,account_code,account_class)
select b.owner_id,b.id,'provider_fee_expense','expense'
from public.businesses b
on conflict (business_id,account_code) do nothing;

revoke insert,update,delete on public.nexora_ledger_accounts,
  public.nexora_ledger_journals,public.nexora_ledger_entries from service_role;
revoke usage,select on sequence public.nexora_ledger_entries_id_seq from service_role;
grant select on public.nexora_ledger_accounts,public.nexora_ledger_journals,
  public.nexora_ledger_entries to service_role;
commit;

-- Expected: three rows, service_role_direct_* = false. The writer RPC must
-- still be exercised with a controlled, idempotent test before production use.
select c.relname as table_name,
  has_table_privilege('service_role',c.oid,'INSERT') as service_role_direct_insert,
  has_table_privilege('service_role',c.oid,'UPDATE') as service_role_direct_update,
  has_table_privilege('service_role',c.oid,'DELETE') as service_role_direct_delete
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in
  ('nexora_ledger_accounts','nexora_ledger_journals','nexora_ledger_entries')
order by c.relname;

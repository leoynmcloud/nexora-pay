-- Least-privilege grants for the reconciliation subsystem.
-- Apply after nexora-reconciliation-foundation.sql and
-- nexora-reconciliation-comparator.sql. No rows or financial state are changed.
begin;

do $$ begin
  if to_regclass('public.nexora_provider_statement_entries') is null
     or to_regclass('public.nexora_reconciliation_runs') is null
     or to_regclass('public.nexora_reconciliation_items') is null
     or to_regclass('public.nexora_receivables') is null
     or to_regclass('public.nexora_settlements') is null
     or to_regclass('public.nexora_reconciliation_exceptions') is null
     or to_regclass('public.nexora_provider_payment_operations') is null then
    raise exception 'Apply the reconciliation foundation and comparator migrations first.';
  end if;
end $$;

-- Revoke broad/default service-role table grants, then restore only what the
-- Edge Function actually uses. Receivables and settlements are accessed via
-- the SECURITY DEFINER release RPC, not direct table grants. Reconciliation
-- writes are append-only; upserts use ON CONFLICT DO NOTHING, so INSERT suffices.
revoke all on table
  public.nexora_provider_statement_entries,
  public.nexora_reconciliation_runs,
  public.nexora_reconciliation_items,
  public.nexora_receivables,
  public.nexora_settlements,
  public.nexora_reconciliation_exceptions,
  public.nexora_provider_payment_operations
from service_role;

grant select, insert on table
  public.nexora_provider_statement_entries,
  public.nexora_reconciliation_runs,
  public.nexora_reconciliation_items,
  public.nexora_reconciliation_exceptions
to service_role;

-- The Asaas compatibility trigger and future provider adapters synchronize
-- the mutable provider status/reference while the operation identity guard
-- prevents reassignment to another merchant/transaction.
grant select, insert, update on table public.nexora_provider_payment_operations to service_role;

commit;

-- Expected: RLS=true for all seven; authenticated has no direct table access;
-- service_role has no DELETE anywhere and no UPDATE except provider operations.
with expected(table_name) as (
  values
    ('nexora_provider_statement_entries'),
    ('nexora_reconciliation_runs'),
    ('nexora_reconciliation_items'),
    ('nexora_receivables'),
    ('nexora_settlements'),
    ('nexora_reconciliation_exceptions'),
    ('nexora_provider_payment_operations')
)
select e.table_name,
  coalesce(c.relrowsecurity,false) as rls_enabled,
  coalesce(has_table_privilege('authenticated',c.oid,'SELECT'),false) as authenticated_can_select,
  coalesce(has_table_privilege('authenticated',c.oid,'INSERT'),false) as authenticated_can_insert,
  coalesce(has_table_privilege('authenticated',c.oid,'UPDATE'),false) as authenticated_can_update,
  coalesce(has_table_privilege('authenticated',c.oid,'DELETE'),false) as authenticated_can_delete,
  coalesce(has_table_privilege('service_role',c.oid,'SELECT'),false) as service_role_can_select,
  coalesce(has_table_privilege('service_role',c.oid,'INSERT'),false) as service_role_can_insert,
  coalesce(has_table_privilege('service_role',c.oid,'UPDATE'),false) as service_role_can_update,
  coalesce(has_table_privilege('service_role',c.oid,'DELETE'),false) as service_role_can_delete
from expected e
left join pg_namespace n on n.nspname='public'
left join pg_class c on c.relnamespace=n.oid and c.relname=e.table_name
order by e.table_name;

-- Additive reconciliation comparator support. Run AFTER
-- nexora-reconciliation-foundation.sql. This does not release or move funds.
begin;

do $$ begin
  if to_regclass('public.nexora_reconciliation_items') is null
     or to_regclass('public.nexora_provider_statement_entries') is null
     or to_regclass('public.nexora_ledger_entries') is null
     or to_regclass('public.nexora_applied_pricing') is null
     or to_regclass('public.nexora_transactions') is null
     or to_regclass('public.nexora_acquirers') is null
     or to_regprocedure('public.nexora_ledger_reject_mutation()') is null then
    raise exception 'Execute nexora-reconciliation-foundation.sql antes desta migração.';
  end if;
end $$;

alter table public.nexora_reconciliation_items
  add column if not exists statement_entry_ids text[] not null default '{}',
  add column if not exists result_sha256 text;
alter table public.nexora_reconciliation_items
  drop constraint if exists nexora_reconciliation_items_result_hash_check;
alter table public.nexora_reconciliation_items
  add constraint nexora_reconciliation_items_result_hash_check
  check (result_sha256 is null or result_sha256 ~ '^[a-f0-9]{64}$');

-- Provider-neutral operation identity. Provider-specific adapters can write
-- this contract; the legacy Asaas adapter is bridged below until migrated.
create table if not exists public.nexora_provider_payment_operations (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null,
  business_id uuid not null,
  owner_id uuid not null,
  acquirer_id uuid not null references public.nexora_acquirers(id) on delete restrict,
  provider_code text not null check (provider_code ~ '^[a-z][a-z0-9_-]{1,79}$'),
  environment text not null check (environment in ('production','sandbox')),
  external_reference text not null check (length(trim(external_reference)) between 1 and 255),
  provider_transaction_id text check (provider_transaction_id is null or length(trim(provider_transaction_id)) between 1 and 255),
  operation_status text not null check (length(trim(operation_status)) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (transaction_id,business_id,owner_id)
    references public.nexora_transactions(id,business_id,owner_id) on delete restrict,
  unique (acquirer_id,environment,external_reference),
  unique (acquirer_id,environment,provider_transaction_id)
);
create index if not exists nexora_provider_payment_operations_transaction
  on public.nexora_provider_payment_operations(transaction_id,acquirer_id,environment,created_at desc);
create index if not exists nexora_reconciliation_paid_payment_window
  on public.nexora_transactions(acquirer_id,paid_at,id)
  where status='paid' and kind='payment' and payment_method='pix' and not test_mode;
create index if not exists nexora_reconciliation_provider_reference
  on public.nexora_transactions(acquirer_id,provider_reference)
  where status='paid' and kind='payment' and payment_method='pix' and not test_mode;

create or replace function public.nexora_guard_provider_payment_operation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.transaction_id is distinct from old.transaction_id
     or new.business_id is distinct from old.business_id or new.owner_id is distinct from old.owner_id
     or new.acquirer_id is distinct from old.acquirer_id or new.provider_code is distinct from old.provider_code
     or new.environment is distinct from old.environment
     or new.external_reference is distinct from old.external_reference
     or (old.provider_transaction_id is not null
       and new.provider_transaction_id is distinct from old.provider_transaction_id) then
    raise exception 'Provider payment operation identity is immutable.';
  end if;
  return new;
end;
$$;
revoke all on function public.nexora_guard_provider_payment_operation() from public,anon,authenticated;
drop trigger if exists nexora_provider_payment_operation_identity_guard
  on public.nexora_provider_payment_operations;
create trigger nexora_provider_payment_operation_identity_guard
  before update on public.nexora_provider_payment_operations
  for each row execute function public.nexora_guard_provider_payment_operation();

-- Temporary compatibility bridge: Asaas remains one adapter, not the core
-- data model. New adapters write the neutral table directly.
do $$ begin
  if to_regclass('public.nexora_asaas_sandbox_operations') is not null then
    insert into public.nexora_provider_payment_operations as existing(
      transaction_id,business_id,owner_id,acquirer_id,provider_code,environment,
      external_reference,provider_transaction_id,operation_status,created_at,updated_at
    )
    select distinct on (o.id) o.transaction_id,o.business_id,o.owner_id,o.acquirer_id,
      a.code,o.environment,o.external_reference,o.provider_reference,o.status,o.created_at,o.updated_at
    from public.nexora_asaas_sandbox_operations o
    join public.nexora_acquirers a on a.id=o.acquirer_id
    where o.transaction_id is not null and o.acquirer_id is not null
      and o.environment in ('production','sandbox')
    order by o.id
    on conflict (acquirer_id,environment,external_reference) do update set
      provider_transaction_id=coalesce(excluded.provider_transaction_id,existing.provider_transaction_id),
      operation_status=excluded.operation_status,updated_at=excluded.updated_at;
  end if;
end $$;

create or replace function public.nexora_sync_asaas_operation_to_provider_core()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_code text;
begin
  if new.transaction_id is null or new.acquirer_id is null
     or new.environment not in ('production','sandbox') or nullif(trim(new.external_reference),'') is null then
    return new;
  end if;
  select a.code into v_code from public.nexora_acquirers a where a.id=new.acquirer_id;
  if v_code is null then raise exception 'Acquirer identity is missing.'; end if;
  insert into public.nexora_provider_payment_operations as existing(
    transaction_id,business_id,owner_id,acquirer_id,provider_code,environment,
    external_reference,provider_transaction_id,operation_status,created_at,updated_at
  ) values (
    new.transaction_id,new.business_id,new.owner_id,new.acquirer_id,v_code,new.environment,
    new.external_reference,new.provider_reference,new.status,coalesce(new.created_at,now()),coalesce(new.updated_at,now())
  ) on conflict (acquirer_id,environment,external_reference) do update set
    provider_transaction_id=coalesce(excluded.provider_transaction_id,existing.provider_transaction_id),
    operation_status=excluded.operation_status,updated_at=excluded.updated_at
  where existing.transaction_id=excluded.transaction_id
    and existing.business_id=excluded.business_id
    and existing.owner_id=excluded.owner_id;
  if not found then raise exception 'Provider operation identity conflicts with an existing payment.'; end if;
  return new;
end;
$$;
revoke all on function public.nexora_sync_asaas_operation_to_provider_core() from public,anon,authenticated;
do $$ begin
  if to_regclass('public.nexora_asaas_sandbox_operations') is not null then
    drop trigger if exists nexora_asaas_operation_provider_core_sync on public.nexora_asaas_sandbox_operations;
    create trigger nexora_asaas_operation_provider_core_sync
      after insert or update of transaction_id,business_id,owner_id,acquirer_id,environment,
        external_reference,provider_reference,status on public.nexora_asaas_sandbox_operations
      for each row execute function public.nexora_sync_asaas_operation_to_provider_core();
  end if;
end $$;

create table if not exists public.nexora_reconciliation_exceptions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.nexora_reconciliation_runs(id) on delete restrict,
  external_entry_id text not null check (length(trim(external_entry_id)) between 1 and 200),
  provider_transaction_id text check (provider_transaction_id is null or length(provider_transaction_id) between 1 and 200),
  issue_code text not null check (issue_code in ('unmatched_statement_entry','unlinked_provider_entry')),
  evidence_sha256 text not null check (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  unique(run_id,external_entry_id,issue_code)
);
create index if not exists nexora_reconciliation_exceptions_run
  on public.nexora_reconciliation_exceptions(run_id,created_at);

-- Return paid production transactions and their financial prerequisites for a
-- single provider/day. Pending is computed from the immutable ledger, not a
-- cached balance. Provider fee is fetched and verified by the Edge Function.
create or replace function public.nexora_reconciliation_payment_expectations(
  p_acquirer_id uuid,p_window_start timestamptz,p_window_end timestamptz,
  p_provider_references text[] default '{}',p_offset integer default 0,p_limit integer default 200
)
returns table(
  transaction_id uuid,business_id uuid,owner_id uuid,provider_transaction_id text,
  status text,test_mode boolean,payment_method text,gross_amount_cents bigint,
  receipt_ledger_cents bigint,applied_merchant_fee_cents bigint,merchant_net_cents bigint,
  external_reference text,operation_provider_reference text,operation_environment text,total_count bigint
)
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'Backend service role required.';
  end if;
  if p_acquirer_id is null or p_window_start is null or p_window_end is null
     or p_window_end <= p_window_start or p_offset < 0 or p_limit not between 1 and 200
     or coalesce(cardinality(p_provider_references),0)>5000
     or exists(select 1 from unnest(coalesce(p_provider_references,'{}'::text[])) as refs(provider_reference)
       where nullif(trim(provider_reference),'') is null or length(provider_reference)>255) then
    raise exception 'Invalid reconciliation window.';
  end if;
  return query
  with candidates as (
  select t.id,t.business_id,t.owner_id,t.provider_reference,t.status,t.test_mode,t.payment_method,
    round(t.amount*100)::bigint as gross_amount_cents,
    coalesce((select sum(e.amount_cents)
      from public.nexora_ledger_journals j
      join public.nexora_ledger_entries e on e.journal_id=j.id
      join public.nexora_ledger_accounts a on a.id=e.account_id
      where j.transaction_id=t.id and j.event_code='payment.received'
        and a.account_code='merchant_pending' and e.side='credit'),0)::bigint as receipt_ledger_cents,
    p.merchant_fee_cents as applied_merchant_fee_cents,p.merchant_net_cents,
    o.external_reference,o.provider_reference as operation_provider_reference,o.environment as operation_environment,
    count(*) over() as full_count,t.paid_at
  from public.nexora_transactions t
  left join public.nexora_applied_pricing p on p.transaction_id=t.id
    and p.business_id=t.business_id and p.owner_id=t.owner_id and p.acquirer_id=t.acquirer_id
  left join lateral (
    select op.external_reference,op.provider_transaction_id as provider_reference,op.environment
    from public.nexora_provider_payment_operations op
    where op.transaction_id=t.id and op.acquirer_id=t.acquirer_id
      and op.provider_code=(select a.code from public.nexora_acquirers a where a.id=t.acquirer_id)
      and op.environment='production'
    order by op.created_at desc,op.id desc limit 1
  ) o on true
  where t.acquirer_id=p_acquirer_id and t.status='paid' and t.kind='payment'
    and t.payment_method='pix' and not t.test_mode
    and ((t.paid_at>=p_window_start and t.paid_at<p_window_end)
      or t.provider_reference=any(coalesce(p_provider_references,'{}'::text[])))
  )
  select c.id,c.business_id,c.owner_id,c.provider_reference,c.status,c.test_mode,c.payment_method,
    c.gross_amount_cents,c.receipt_ledger_cents,c.applied_merchant_fee_cents,c.merchant_net_cents,c.external_reference,
    c.operation_provider_reference,c.operation_environment,c.full_count
  from candidates c order by c.paid_at,c.id offset p_offset limit p_limit;
end;
$$;
revoke all on function public.nexora_reconciliation_payment_expectations(uuid,timestamptz,timestamptz,text[],integer,integer)
  from public,anon,authenticated;
grant execute on function public.nexora_reconciliation_payment_expectations(uuid,timestamptz,timestamptz,text[],integer,integer)
  to service_role;

alter table public.nexora_reconciliation_exceptions enable row level security;
alter table public.nexora_provider_payment_operations enable row level security;
revoke all on public.nexora_reconciliation_exceptions from public,anon,authenticated,service_role;
revoke all on public.nexora_provider_payment_operations from public,anon,authenticated,service_role;
grant select,insert on public.nexora_reconciliation_exceptions to service_role;
grant select,insert,update on public.nexora_provider_payment_operations to service_role;
drop trigger if exists nexora_reconciliation_exceptions_immutable on public.nexora_reconciliation_exceptions;
create trigger nexora_reconciliation_exceptions_immutable
  before update or delete on public.nexora_reconciliation_exceptions
  for each row execute function public.nexora_ledger_reject_mutation();

notify pgrst,'reload schema';
commit;

select c.relname as table_name,c.relrowsecurity as rls_enabled,
  has_table_privilege('authenticated',c.oid,'INSERT') as authenticated_can_insert,
  has_table_privilege('authenticated',c.oid,'UPDATE') as authenticated_can_update,
  has_table_privilege('authenticated',c.oid,'DELETE') as authenticated_can_delete
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname='nexora_reconciliation_exceptions';
select has_function_privilege('anon',
  'public.nexora_reconciliation_payment_expectations(uuid,timestamptz,timestamptz,text[],integer,integer)','EXECUTE') as anon_can_compare,
  has_function_privilege('authenticated',
  'public.nexora_reconciliation_payment_expectations(uuid,timestamptz,timestamptz,text[],integer,integer)','EXECUTE') as authenticated_can_compare,
  has_function_privilege('service_role',
  'public.nexora_reconciliation_payment_expectations(uuid,timestamptz,timestamptz,text[],integer,integer)','EXECUTE') as service_role_can_compare;
select c.relname as table_name,c.relrowsecurity as rls_enabled,
  has_table_privilege('authenticated',c.oid,'SELECT') as authenticated_can_select,
  has_table_privilege('authenticated',c.oid,'INSERT') as authenticated_can_insert,
  has_table_privilege('authenticated',c.oid,'UPDATE') as authenticated_can_update,
  has_table_privilege('authenticated',c.oid,'DELETE') as authenticated_can_delete,
  has_table_privilege('service_role',c.oid,'SELECT') as service_role_can_select,
  has_table_privilege('service_role',c.oid,'INSERT') as service_role_can_insert,
  has_table_privilege('service_role',c.oid,'UPDATE') as service_role_can_update,
  has_table_privilege('service_role',c.oid,'DELETE') as service_role_can_delete
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname='nexora_provider_payment_operations';
-- Generic diagnostic: paid production payments should correlate to the
-- provider-neutral operation record, irrespective of the adapter.
select count(*) as provider_operations_missing_for_paid_payments
from public.nexora_transactions t
where t.status='paid' and t.kind='payment' and not t.test_mode and t.acquirer_id is not null
  and not exists(select 1 from public.nexora_provider_payment_operations p
    where p.transaction_id=t.id and p.business_id=t.business_id and p.owner_id=t.owner_id
      and p.acquirer_id=t.acquirer_id and p.provider_transaction_id is not distinct from t.provider_reference);

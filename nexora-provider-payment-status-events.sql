-- Append-only, provider-neutral history for verified payment status events.
-- Run after nexora-reconciliation-comparator.sql. This migration never posts
-- ledger entries and never changes a transaction or merchant balance.
begin;

do $$ begin
  if to_regclass('public.nexora_provider_payment_operations') is null
     or to_regprocedure('public.nexora_ledger_reject_mutation()') is null then
    raise exception 'Apply the provider operation core and ledger hardening first.';
  end if;
end $$;

create unique index if not exists nexora_provider_payment_operations_id_transaction_unique
  on public.nexora_provider_payment_operations(id,transaction_id);

create table if not exists public.nexora_provider_payment_status_events (
  id uuid primary key default gen_random_uuid(),
  provider_code text not null check (provider_code ~ '^[a-z][a-z0-9_-]{1,79}$'),
  provider_event_id text not null check (length(trim(provider_event_id)) between 1 and 255),
  provider_event_type text not null check (length(trim(provider_event_type)) between 1 and 100),
  provider_operation_id uuid not null references public.nexora_provider_payment_operations(id) on delete restrict,
  transaction_id uuid not null,
  provider_transaction_id text not null check (length(trim(provider_transaction_id)) between 1 and 255),
  raw_provider_status text not null check (length(trim(raw_provider_status)) between 1 and 80),
  normalized_status text not null check (normalized_status in (
    'CREATED','PENDING','PROCESSING','AUTHORIZED','SUCCEEDED','SETTLED','FAILED','CANCELED',
    'EXPIRED','REFUND_PENDING','REFUNDED','PARTIALLY_REFUNDED','REVERSED','UNDER_REVIEW'
  )),
  status_checked_at timestamptz not null,
  received_at timestamptz not null default now(),
  unique (provider_code,provider_event_id),
  foreign key (provider_operation_id,transaction_id)
    references public.nexora_provider_payment_operations(id,transaction_id) on delete restrict
);

create index if not exists nexora_provider_payment_status_events_transaction_time
  on public.nexora_provider_payment_status_events(transaction_id,received_at desc);

alter table public.nexora_provider_payment_status_events enable row level security;
revoke all on public.nexora_provider_payment_status_events from public,anon,authenticated,service_role;
grant select,insert on public.nexora_provider_payment_status_events to service_role;

drop trigger if exists nexora_provider_payment_status_events_immutable
  on public.nexora_provider_payment_status_events;
create trigger nexora_provider_payment_status_events_immutable
  before update or delete on public.nexora_provider_payment_status_events
  for each row execute function public.nexora_ledger_reject_mutation();

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
where n.nspname='public' and c.relname='nexora_provider_payment_status_events';

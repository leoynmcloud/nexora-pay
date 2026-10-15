-- Etapa 1/45 — histórico imutável dos eventos de transação do Payment Core.
-- Execute após nexora-repair.sql e as migrações de pagamento existentes.
-- Não altera saldos, status existentes, credenciais nem dispara operações externas.

begin;

do $$
begin
  if to_regclass('public.nexora_transactions') is null then
    raise exception 'Execute as migrações-base de Nexora antes de instalar o histórico de pagamentos.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='nexora_transactions' and column_name='status'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='nexora_transactions' and column_name='owner_id'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='nexora_transactions' and column_name='business_id'
  ) then
    raise exception 'A tabela nexora_transactions não tem os campos mínimos esperados.';
  end if;
end $$;

create table if not exists public.nexora_payment_events (
  id bigint generated always as identity primary key,
  transaction_id uuid not null,
  owner_id uuid not null,
  business_id uuid not null,
  event_code text not null check (length(event_code) between 1 and 80),
  from_status text,
  to_status text not null,
  actor_type text not null check (actor_type in ('user','service','system')),
  actor_id uuid,
  occurred_at timestamptz not null default clock_timestamp(),
  event_data jsonb not null default '{}'::jsonb
);

create index if not exists nexora_payment_events_transaction_time
  on public.nexora_payment_events(transaction_id, occurred_at desc, id desc);
create index if not exists nexora_payment_events_owner_time
  on public.nexora_payment_events(owner_id, occurred_at desc, id desc);

alter table public.nexora_payment_events enable row level security;
revoke all on public.nexora_payment_events from public, anon, authenticated;
grant select on public.nexora_payment_events to authenticated, service_role;
grant usage, select on sequence public.nexora_payment_events_id_seq to service_role;

drop policy if exists nexora_payment_events_owner_read on public.nexora_payment_events;
create policy nexora_payment_events_owner_read
  on public.nexora_payment_events for select to authenticated
  using (owner_id = (select auth.uid()));

create or replace function public.nexora_payment_events_reject_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'Payment events are append-only.';
end;
$$;
revoke all on function public.nexora_payment_events_reject_mutation() from public, anon, authenticated;

drop trigger if exists nexora_payment_events_immutable on public.nexora_payment_events;
create trigger nexora_payment_events_immutable
  before update or delete on public.nexora_payment_events
  for each row execute function public.nexora_payment_events_reject_mutation();

create or replace function public.nexora_payment_record_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_role text := coalesce(current_setting('request.jwt.claim.role', true), '');
  v_from_status text;
  v_code text;
begin
  if tg_op = 'INSERT' then
    v_from_status := null;
    v_code := 'transaction.created';
  elsif old.status is distinct from new.status then
    v_from_status := old.status;
    v_code := 'transaction.status_changed';
  else
    return new;
  end if;

  insert into public.nexora_payment_events (
    transaction_id, owner_id, business_id, event_code, from_status, to_status,
    actor_type, actor_id, event_data
  ) values (
    new.id, new.owner_id, new.business_id, v_code, v_from_status, new.status,
    case when v_actor_id is not null then 'user'
         when v_role = 'service_role' then 'service'
         else 'system' end,
    v_actor_id,
    jsonb_build_object(
      'source', to_jsonb(new)->>'source',
      'payment_method', to_jsonb(new)->>'payment_method',
      'request_id', to_jsonb(new)->>'request_id',
      'provider_reference', to_jsonb(new)->>'provider_reference'
    )
  );
  return new;
end;
$$;
revoke all on function public.nexora_payment_record_event() from public, anon, authenticated;

drop trigger if exists nexora_transactions_record_insert on public.nexora_transactions;
create trigger nexora_transactions_record_insert
  after insert on public.nexora_transactions
  for each row execute function public.nexora_payment_record_event();

drop trigger if exists nexora_transactions_record_status on public.nexora_transactions;
create trigger nexora_transactions_record_status
  after update of status on public.nexora_transactions
  for each row execute function public.nexora_payment_record_event();

commit;

-- Read-only verification: one created/status event per applicable transaction transition.
select event_code, actor_type, count(*) as events
from public.nexora_payment_events
group by event_code, actor_type
order by event_code, actor_type;

select c.relname as table_name, c.relrowsecurity as rls_enabled,
       has_table_privilege('authenticated', c.oid, 'INSERT') as authenticated_can_insert,
       has_table_privilege('authenticated', c.oid, 'UPDATE') as authenticated_can_update,
       has_table_privilege('authenticated', c.oid, 'DELETE') as authenticated_can_delete
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname='nexora_payment_events';

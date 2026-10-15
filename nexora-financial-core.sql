-- Nexora Pay: double-entry ledger for the isolated sandbox only.
-- Run after nexora-prelaunch-2-3-4.sql. This does not enable or post real payments.
begin;

do $$ begin
  if to_regclass('public.nexora_runtime_config') is null
     or to_regclass('public.nexora_sandbox_transactions') is null
     or to_regclass('public.nexora_sandbox_events') is null
     or to_regclass('public.nexora_audit_log') is null then
    raise exception 'Execute nexora-prelaunch-2-3-4.sql first.';
  end if;
end $$;

create table if not exists public.nexora_sandbox_ledger_journals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  transaction_id uuid not null references public.nexora_sandbox_transactions(id) on delete cascade,
  source_event_id bigint not null unique,
  event_code text not null,
  amount_cents bigint not null check (amount_cents > 0),
  created_at timestamptz not null default now(),
  unique(transaction_id,event_code)
);
create index if not exists nexora_sandbox_ledger_owner_business
  on public.nexora_sandbox_ledger_journals(owner_id,business_id,created_at desc);

create table if not exists public.nexora_sandbox_ledger_entries (
  id bigint generated always as identity primary key,
  journal_id uuid not null references public.nexora_sandbox_ledger_journals(id) on delete cascade,
  account_code text not null check (account_code in ('provider_clearing','merchant_available','merchant_reserved')),
  side text not null check (side in ('debit','credit')),
  amount_cents bigint not null check (amount_cents > 0),
  created_at timestamptz not null default now(),
  unique(journal_id,account_code,side)
);
create index if not exists nexora_sandbox_ledger_entries_account
  on public.nexora_sandbox_ledger_entries(account_code,journal_id);

alter table public.nexora_sandbox_ledger_journals enable row level security;
alter table public.nexora_sandbox_ledger_entries enable row level security;
revoke all on public.nexora_sandbox_ledger_journals,public.nexora_sandbox_ledger_entries from public,anon,authenticated;
grant select on public.nexora_sandbox_ledger_journals,public.nexora_sandbox_ledger_entries to service_role;
grant usage,select on sequence public.nexora_sandbox_ledger_entries_id_seq to service_role;

create or replace function public.nexora_sandbox_ledger_assert_balanced()
returns trigger language plpgsql set search_path = '' as $$
declare v_debits bigint; v_credits bigint; v_count integer;
begin
  select count(*),coalesce(sum(amount_cents) filter(where side='debit'),0),
         coalesce(sum(amount_cents) filter(where side='credit'),0)
    into v_count,v_debits,v_credits
    from public.nexora_sandbox_ledger_entries where journal_id=new.id;
  if v_count<2 or v_debits<>v_credits then
    raise exception 'Sandbox ledger journal is not balanced.';
  end if;
  return null;
end;
$$;
drop trigger if exists nexora_sandbox_ledger_balanced on public.nexora_sandbox_ledger_journals;
create constraint trigger nexora_sandbox_ledger_balanced
after insert on public.nexora_sandbox_ledger_journals
deferrable initially deferred for each row
execute function public.nexora_sandbox_ledger_assert_balanced();

create or replace function public.nexora_sandbox_post_event(p_event_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare v_event public.nexora_sandbox_events; v_tx public.nexora_sandbox_transactions;
  v_journal uuid; v_debit text; v_credit text; v_cents bigint;
begin
  select * into v_event from public.nexora_sandbox_events where id=p_event_id;
  if not found then return; end if;
  select * into v_tx from public.nexora_sandbox_transactions
    where id=v_event.transaction_id and owner_id=v_event.owner_id;
  if not found then return; end if;
  v_cents:=round(v_tx.amount*100)::bigint;

  if v_tx.kind='payment' and v_event.to_status='succeeded'
     and v_event.from_status is distinct from 'succeeded' then
    v_debit:='provider_clearing'; v_credit:='merchant_available';
  elsif v_tx.kind='payment' and v_event.from_status='succeeded'
     and v_event.to_status in ('refunded','reversed') then
    v_debit:='merchant_available'; v_credit:='provider_clearing';
  elsif v_tx.kind='withdrawal' and v_event.from_status is null and v_event.to_status='pending' then
    v_debit:='merchant_available'; v_credit:='merchant_reserved';
  elsif v_tx.kind='withdrawal' and v_event.to_status='succeeded'
     and v_event.from_status in ('pending','processing') then
    v_debit:='merchant_reserved'; v_credit:='provider_clearing';
  elsif v_tx.kind='withdrawal' and v_event.to_status in ('failed','cancelled','reversed')
     and v_event.from_status in ('pending','processing') then
    v_debit:='merchant_reserved'; v_credit:='merchant_available';
  else
    return;
  end if;

  insert into public.nexora_sandbox_ledger_journals(
    owner_id,business_id,transaction_id,source_event_id,event_code,amount_cents
  ) values (
    v_event.owner_id,v_tx.business_id,v_tx.id,v_event.id,v_event.event_type,v_cents
  ) on conflict do nothing returning id into v_journal;
  if v_journal is null then return; end if;
  insert into public.nexora_sandbox_ledger_entries(journal_id,account_code,side,amount_cents)
  values (v_journal,v_debit,'debit',v_cents),(v_journal,v_credit,'credit',v_cents);
end;
$$;
revoke all on function public.nexora_sandbox_post_event(bigint) from public,anon,authenticated;

create or replace function public.nexora_sandbox_post_event_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.nexora_sandbox_post_event(new.id);
  return new;
end;
$$;
revoke all on function public.nexora_sandbox_post_event_trigger() from public,anon,authenticated;
drop trigger if exists nexora_sandbox_events_post_ledger on public.nexora_sandbox_events;
create trigger nexora_sandbox_events_post_ledger
after insert on public.nexora_sandbox_events
for each row execute function public.nexora_sandbox_post_event_trigger();

-- Backfill only from the append-only sandbox event history; repeated runs are idempotent.
do $$ declare v_event record; begin
  for v_event in select id from public.nexora_sandbox_events order by id loop
    perform public.nexora_sandbox_post_event(v_event.id);
  end loop;
end $$;

create or replace function public.nexora_sandbox_ledger_balance(p_business_id uuid,p_account_code text)
returns numeric language plpgsql security definer set search_path = '' as $$
declare v_cents bigint;
begin
  if p_account_code not in ('merchant_available','merchant_reserved') then
    raise exception 'Unsupported merchant balance account.';
  end if;
  if auth.uid() is null or not exists(select 1 from public.businesses
      where id=p_business_id and owner_id=auth.uid()) then
    raise exception 'Workspace not found for current account.';
  end if;
  select coalesce(sum(case when entry.side='credit' then entry.amount_cents else -entry.amount_cents end),0)
    into v_cents
    from public.nexora_sandbox_ledger_entries entry
    join public.nexora_sandbox_ledger_journals journal on journal.id=entry.journal_id
    where journal.owner_id=auth.uid() and journal.business_id=p_business_id
      and entry.account_code=p_account_code;
  return v_cents::numeric/100;
end;
$$;
revoke all on function public.nexora_sandbox_ledger_balance(uuid,text) from public,anon,authenticated;

create or replace function public.nexora_sandbox_snapshot()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_business uuid:=public.nexora_sandbox_assert(); v_available numeric(14,2); v_reserved numeric(14,2);
  v_received numeric(14,2); v_paid_out numeric(14,2); v_pending numeric(14,2); v_transactions jsonb;
begin
  v_available:=public.nexora_sandbox_ledger_balance(v_business,'merchant_available');
  v_reserved:=public.nexora_sandbox_ledger_balance(v_business,'merchant_reserved');
  select coalesce(sum(case
      when event_code='sandbox.payment.succeeded' then amount_cents
      when event_code in ('sandbox.payment.refunded','sandbox.payment.reversed') then -amount_cents
      else 0 end),0)::numeric/100
    into v_received from public.nexora_sandbox_ledger_journals
    where owner_id=auth.uid() and business_id=v_business;
  select coalesce(sum(amount_cents),0)::numeric/100 into v_paid_out
    from public.nexora_sandbox_ledger_journals
    where owner_id=auth.uid() and business_id=v_business and event_code='sandbox.withdrawal.succeeded';
  select coalesce(sum(amount),0) into v_pending from public.nexora_sandbox_transactions
    where owner_id=auth.uid() and business_id=v_business and kind='payment' and status in ('pending','processing');
  select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'external_id',t.external_id,'kind',t.kind,
      'title',t.title,'amount',t.amount,'status',t.status,'customer_name',t.customer_name,
      'customer_email',t.customer_email,'created_at',t.created_at,'updated_at',t.updated_at,
      'events',(select coalesce(jsonb_agg(jsonb_build_object('event_type',e.event_type,'from_status',e.from_status,
        'to_status',e.to_status,'created_at',e.created_at) order by e.created_at),'[]'::jsonb)
        from public.nexora_sandbox_events e where e.transaction_id=t.id and e.owner_id=auth.uid())) order by t.created_at desc),'[]'::jsonb)
    into v_transactions from (select * from public.nexora_sandbox_transactions
      where owner_id=auth.uid() and business_id=v_business order by created_at desc limit 100) t;
  return jsonb_build_object('transactions',v_transactions,'summary',jsonb_build_object(
    'available',v_available,'received',v_received,'pending',v_pending,'reserved',v_reserved,'paid_out',v_paid_out,
    'count',(select count(*) from public.nexora_sandbox_transactions where owner_id=auth.uid() and business_id=v_business)));
end;
$$;

create or replace function public.nexora_sandbox_request_withdrawal(p_request_id uuid,p_amount numeric)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_business uuid:=public.nexora_sandbox_assert(); v_id uuid; v_existing public.nexora_sandbox_transactions;
  v_available numeric(14,2); v_controls public.nexora_merchant_controls; v_has_controls boolean;
begin
  if p_request_id is null or p_amount is null or p_amount<=0 or p_amount<>round(p_amount,2) or p_amount>9999999999.99
    then raise exception 'Valor ou chave de idempotência inválidos.'; end if;
  perform 1 from public.businesses where id=v_business and owner_id=auth.uid() for update;
  select * into v_existing from public.nexora_sandbox_transactions where owner_id=auth.uid() and request_id=p_request_id;
  if found then
    if v_existing.kind<>'withdrawal' or v_existing.amount<>p_amount then raise exception 'Chave de idempotência já usada com dados diferentes.'; end if;
    return v_existing.id;
  end if;
  select * into v_controls from public.nexora_merchant_controls where business_id=v_business and owner_id=auth.uid();
  v_has_controls:=found;
  if v_has_controls and not v_controls.withdrawals_enabled then raise exception 'Saques bloqueados pelo Painel Nexora Pay.'; end if;
  v_available:=public.nexora_sandbox_ledger_balance(v_business,'merchant_available');
  if p_amount>v_available then raise exception 'Saldo de teste disponível insuficiente.'; end if;
  if v_has_controls and (p_amount>v_controls.max_transfer_amount or
      (select coalesce(sum(amount),0) from public.nexora_sandbox_transactions
       where owner_id=auth.uid() and business_id=v_business and kind='withdrawal'
         and status not in ('failed','cancelled','reversed') and created_at>=date_trunc('day',now()))+p_amount>v_controls.daily_transfer_limit) then
    raise exception 'Solicitação excede o limite de teste configurado.'; end if;
  insert into public.nexora_sandbox_transactions(owner_id,business_id,request_id,external_id,kind,title,amount,status)
    values(auth.uid(),v_business,p_request_id,'SIM-SAQUE-'||upper(substr(replace(p_request_id::text,'-',''),1,12)),
      'withdrawal','Saque simulado · nenhum Pix será enviado',p_amount,'pending') returning id into v_id;
  insert into public.nexora_sandbox_events(transaction_id,owner_id,idempotency_key,event_type,to_status)
    values(v_id,auth.uid(),p_request_id,'sandbox.withdrawal.created','pending');
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(auth.uid(),'sandbox.withdrawal.created',v_id::text,jsonb_build_object('amount',p_amount,'mode','sandbox'));
  return v_id;
end;
$$;

create or replace function public.nexora_sandbox_transition(p_transaction_id uuid,p_idempotency_key uuid,p_next_status text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_business uuid:=public.nexora_sandbox_assert(); v_tx public.nexora_sandbox_transactions;
  v_existing public.nexora_sandbox_events; v_allowed boolean:=false; v_available numeric(14,2);
begin
  if p_idempotency_key is null or p_next_status is null then raise exception 'Chave de idempotência e próximo status são obrigatórios.'; end if;
  perform 1 from public.businesses where id=v_business and owner_id=auth.uid() for update;
  select * into v_tx from public.nexora_sandbox_transactions where id=p_transaction_id
    and owner_id=auth.uid() and business_id=v_business for update;
  if not found then raise exception 'Registro de teste não encontrado nesta conta.'; end if;
  select * into v_existing from public.nexora_sandbox_events where owner_id=auth.uid() and idempotency_key=p_idempotency_key;
  if found then
    if v_existing.transaction_id<>v_tx.id then raise exception 'Chave de idempotência já usada em outra operação.'; end if;
    if v_existing.to_status<>p_next_status then raise exception 'Chave de idempotência já usada para outro estado.'; end if;
    return v_tx.status;
  end if;
  if v_tx.kind='payment' then
    v_allowed:=(v_tx.status='pending' and p_next_status in ('processing','succeeded','failed','cancelled','expired'))
      or (v_tx.status='processing' and p_next_status in ('succeeded','failed'))
      or (v_tx.status='succeeded' and p_next_status in ('refunded','reversed'));
  else
    v_allowed:=(v_tx.status='pending' and p_next_status in ('processing','failed','cancelled','succeeded'))
      or (v_tx.status='processing' and p_next_status in ('succeeded','failed','reversed'));
  end if;
  if not v_allowed then raise exception 'Transição simulada inválida: % → %.',v_tx.status,p_next_status; end if;
  if v_tx.kind='payment' and v_tx.status='succeeded' and p_next_status in ('refunded','reversed') then
    v_available:=public.nexora_sandbox_ledger_balance(v_business,'merchant_available');
    if v_available<v_tx.amount then raise exception 'Saldo de teste insuficiente para simular este estorno.'; end if;
  end if;
  update public.nexora_sandbox_transactions set status=p_next_status,updated_at=now() where id=v_tx.id;
  insert into public.nexora_sandbox_events(transaction_id,owner_id,idempotency_key,event_type,from_status,to_status)
    values(v_tx.id,auth.uid(),p_idempotency_key,'sandbox.'||v_tx.kind||'.'||p_next_status,v_tx.status,p_next_status);
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(auth.uid(),'sandbox.'||v_tx.kind||'.'||p_next_status,v_tx.id::text,
      jsonb_build_object('from',v_tx.status,'to',p_next_status,'mode','sandbox'));
  return p_next_status;
end;
$$;

revoke all on function public.nexora_sandbox_request_withdrawal(uuid,numeric) from public,anon;
revoke all on function public.nexora_sandbox_transition(uuid,uuid,text) from public,anon;
revoke all on function public.nexora_sandbox_snapshot() from public,anon;
grant execute on function public.nexora_sandbox_request_withdrawal(uuid,numeric) to authenticated;
grant execute on function public.nexora_sandbox_transition(uuid,uuid,text) to authenticated;
grant execute on function public.nexora_sandbox_snapshot() to authenticated;
notify pgrst,'reload schema';
commit;

-- Read-only checks: both ledger tables should have RLS; direct user writes must be false.
select c.relname as table_name,c.relrowsecurity as rls_enabled,
  has_table_privilege('authenticated','public.'||c.relname,'INSERT') as authenticated_can_insert
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('nexora_sandbox_ledger_journals','nexora_sandbox_ledger_entries')
order by c.relname;

-- This query should return zero rows: every sandbox journal balances exactly.
select journal.id,journal.event_code,
  coalesce(sum(le.amount_cents) filter(where le.side='debit'),0) as debit_cents,
  coalesce(sum(le.amount_cents) filter(where le.side='credit'),0) as credit_cents
from public.nexora_sandbox_ledger_journals journal
left join public.nexora_sandbox_ledger_entries le on le.journal_id=journal.id
group by journal.id,journal.event_code
having coalesce(sum(le.amount_cents) filter(where le.side='debit'),0)
    <> coalesce(sum(le.amount_cents) filter(where le.side='credit'),0);

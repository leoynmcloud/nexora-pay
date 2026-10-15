-- Nexora Pay: isolamento, simulador pré-lançamento e contratos de integração.
-- Execute DEPOIS de nexora-repair.sql e nexora-onboarding-kyc.sql.
-- Não cria transações de exemplo e não habilita pagamentos reais.
begin;

do $$ begin
  if to_regclass('public.nexora_runtime_config') is null
     or to_regclass('public.nexora_transactions') is null
     or to_regclass('public.nexora_admins') is null
     or to_regclass('public.merchant_onboarding') is null
     or to_regclass('public.nexora_merchant_controls') is null
     or to_regclass('public.nexora_audit_log') is null then
    raise exception 'Execute primeiro os SQLs existentes de dados, reparo e onboarding.';
  end if;
end $$;

-- No pré-lançamento, habilita apenas simulação se o gateway ainda não estiver ativo.
-- Nunca rebaixa uma configuração que já esteja marcada como gateway_ready.
update public.nexora_runtime_config set sandbox=true where id=true and gateway_ready=false;

create table if not exists public.nexora_sandbox_transactions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  request_id uuid not null,
  external_id text not null,
  kind text not null check (kind in ('payment','withdrawal')),
  title text not null,
  amount numeric(14,2) not null check (amount>0),
  status text not null check (status in ('pending','processing','succeeded','failed','cancelled','expired','refunded','reversed')),
  customer_name text,
  customer_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id,request_id),
  unique(owner_id,external_id)
);
create index if not exists nexora_sandbox_tx_workspace_date on public.nexora_sandbox_transactions(business_id,created_at desc);

create table if not exists public.nexora_sandbox_events (
  id bigint generated always as identity primary key,
  transaction_id uuid not null references public.nexora_sandbox_transactions(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key uuid not null,
  event_type text not null,
  from_status text,
  to_status text not null,
  created_at timestamptz not null default now(),
  unique(owner_id,idempotency_key)
);
create index if not exists nexora_sandbox_events_transaction on public.nexora_sandbox_events(transaction_id,created_at);

create or replace function public.nexora_sandbox_event_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op='UPDATE' then raise exception 'O histórico do simulador não pode ser alterado.'; end if;
  return old; -- Exclusões de retenção/privacidade continuam possíveis.
end;
$$;
drop trigger if exists nexora_sandbox_events_immutable on public.nexora_sandbox_events;
create trigger nexora_sandbox_events_immutable before update on public.nexora_sandbox_events
for each row execute function public.nexora_sandbox_event_immutable();

alter table public.nexora_sandbox_transactions enable row level security;
alter table public.nexora_sandbox_events enable row level security;
drop policy if exists nexora_sandbox_owner_read on public.nexora_sandbox_transactions;
create policy nexora_sandbox_owner_read on public.nexora_sandbox_transactions for select to authenticated
using (owner_id=auth.uid() and public.nexora_account_active(auth.uid())
  and exists(select 1 from public.businesses b where b.id=business_id and b.owner_id=auth.uid())
  and (public.is_nexora_super_admin() or exists(select 1 from public.merchant_onboarding m where m.user_id=auth.uid() and m.status='APPROVED')));
drop policy if exists nexora_sandbox_events_owner_read on public.nexora_sandbox_events;
create policy nexora_sandbox_events_owner_read on public.nexora_sandbox_events for select to authenticated
using (owner_id=auth.uid() and exists(select 1 from public.nexora_sandbox_transactions t
  where t.id=transaction_id and t.owner_id=auth.uid() and t.business_id in (select b.id from public.businesses b where b.owner_id=auth.uid())));
revoke all on public.nexora_sandbox_transactions,public.nexora_sandbox_events from public,anon,authenticated;
grant select on public.nexora_sandbox_transactions,public.nexora_sandbox_events to authenticated;

create or replace function public.nexora_sandbox_assert()
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_business uuid;
begin
  v_business:=public.nexora_assert_workspace();
  if not coalesce((select r.sandbox and not r.gateway_ready from public.nexora_runtime_config r where r.id=true),false) then
    raise exception 'Simulador indisponível: a conta está fora do modo pré-lançamento.';
  end if;
  return v_business;
end;
$$;

create or replace function public.nexora_sandbox_snapshot()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_business uuid:=public.nexora_sandbox_assert(); v_available numeric(14,2); v_reserved numeric(14,2);
  v_received numeric(14,2); v_paid_out numeric(14,2); v_pending numeric(14,2); v_transactions jsonb;
begin
  select coalesce(sum(amount) filter(where kind='payment' and status='succeeded'),0),
         coalesce(sum(amount) filter(where kind='payment' and status in ('pending','processing')),0),
         coalesce(sum(amount) filter(where kind='withdrawal' and status in ('pending','processing')),0),
         coalesce(sum(amount) filter(where kind='withdrawal' and status='succeeded'),0)
    into v_received,v_pending,v_reserved,v_paid_out
    from public.nexora_sandbox_transactions where owner_id=auth.uid() and business_id=v_business;
  v_available:=v_received-v_paid_out-v_reserved;
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

create or replace function public.nexora_sandbox_create_payment(
  p_request_id uuid,p_amount numeric,p_customer_name text,p_customer_email text default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_business uuid:=public.nexora_sandbox_assert(); v_id uuid; v_existing public.nexora_sandbox_transactions; v_controls public.nexora_merchant_controls;
begin
  if p_request_id is null or p_amount is null or p_amount<=0 or p_amount<>round(p_amount,2) or p_amount>9999999999.99
    then raise exception 'Valor ou chave de idempotência inválidos.'; end if;
  if nullif(trim(coalesce(p_customer_name,'')),'') is null or length(p_customer_name)>160 then raise exception 'Informe o nome fictício do cliente.'; end if;
  if p_customer_email is not null and (length(p_customer_email)>254 or p_customer_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then
    raise exception 'E-mail de teste inválido.'; end if;
  perform 1 from public.businesses where id=v_business and owner_id=auth.uid() for update;
  select * into v_existing from public.nexora_sandbox_transactions where owner_id=auth.uid() and request_id=p_request_id;
  if found then
    if v_existing.kind<>'payment' or v_existing.amount<>p_amount or v_existing.customer_name<>trim(p_customer_name)
      or v_existing.customer_email is distinct from nullif(lower(trim(p_customer_email)), '') then
      raise exception 'Chave de idempotência já usada com dados diferentes.';
    end if;
    return v_existing.id;
  end if;
  select * into v_controls from public.nexora_merchant_controls where business_id=v_business and owner_id=auth.uid();
  if found and not v_controls.payments_enabled then raise exception 'Recebimentos bloqueados pelo Painel Nexora Pay.'; end if;
  insert into public.nexora_sandbox_transactions(owner_id,business_id,request_id,external_id,kind,title,amount,status,customer_name,customer_email)
    values(auth.uid(),v_business,p_request_id,'SIM-'||upper(substr(replace(p_request_id::text,'-',''),1,12)),
      'payment','Cobrança simulada',p_amount,'pending',trim(p_customer_name),nullif(lower(trim(p_customer_email)),'')) returning id into v_id;
  insert into public.nexora_sandbox_events(transaction_id,owner_id,idempotency_key,event_type,to_status)
    values(v_id,auth.uid(),p_request_id,'sandbox.payment.created','pending');
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(auth.uid(),'sandbox.payment.created',v_id::text,jsonb_build_object('amount',p_amount,'mode','sandbox'));
  return v_id;
end;
$$;

create or replace function public.nexora_sandbox_request_withdrawal(p_request_id uuid,p_amount numeric)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_business uuid:=public.nexora_sandbox_assert(); v_id uuid; v_existing public.nexora_sandbox_transactions; v_available numeric(14,2); v_controls public.nexora_merchant_controls; v_has_controls boolean;
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
  select coalesce(sum(case when kind='payment' and status='succeeded' then amount
      when kind='withdrawal' and status in ('succeeded','pending','processing') then -amount else 0 end),0)
    into v_available from public.nexora_sandbox_transactions where owner_id=auth.uid() and business_id=v_business;
  if p_amount>v_available then raise exception 'Saldo de teste disponível insuficiente.'; end if;
  if v_has_controls and (p_amount>v_controls.max_transfer_amount or
      (select coalesce(sum(amount),0) from public.nexora_sandbox_transactions where owner_id=auth.uid() and business_id=v_business
       and kind='withdrawal' and status not in ('failed','cancelled') and created_at>=date_trunc('day',now()))+p_amount>v_controls.daily_transfer_limit) then
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
declare v_business uuid:=public.nexora_sandbox_assert(); v_tx public.nexora_sandbox_transactions; v_existing public.nexora_sandbox_events;
  v_allowed boolean:=false; v_available numeric(14,2);
begin
  if p_idempotency_key is null or p_next_status is null then raise exception 'Chave de idempotência e próximo status são obrigatórios.'; end if;
  perform 1 from public.businesses where id=v_business and owner_id=auth.uid() for update;
  select * into v_tx from public.nexora_sandbox_transactions where id=p_transaction_id and owner_id=auth.uid()
    and business_id=v_business for update;
  if not found then raise exception 'Registro de teste não encontrado nesta conta.'; end if;
  select * into v_existing from public.nexora_sandbox_events where owner_id=auth.uid() and idempotency_key=p_idempotency_key;
  if found then
    if v_existing.transaction_id<>v_tx.id then raise exception 'Chave de idempotência já usada em outra operação.'; end if;
    if v_existing.to_status<>p_next_status then raise exception 'Chave de idempotência já usada para outro estado.'; end if;
    return v_tx.status;
  end if;
  if v_tx.kind='payment' then
    v_allowed := (v_tx.status='pending' and p_next_status in ('processing','succeeded','failed','cancelled','expired'))
      or (v_tx.status='processing' and p_next_status in ('succeeded','failed'))
      or (v_tx.status='succeeded' and p_next_status in ('refunded','reversed'));
  else
    v_allowed := (v_tx.status='pending' and p_next_status in ('processing','failed','cancelled','succeeded'))
      or (v_tx.status='processing' and p_next_status in ('succeeded','failed','reversed'));
  end if;
  if not v_allowed then raise exception 'Transição simulada inválida: % → %.',v_tx.status,p_next_status; end if;
  if v_tx.kind='payment' and v_tx.status='succeeded' and p_next_status in ('refunded','reversed') then
    select coalesce(sum(case when kind='payment' and status='succeeded' then amount
      when kind='withdrawal' and status in ('succeeded','pending','processing') then -amount else 0 end),0)
      into v_available from public.nexora_sandbox_transactions where owner_id=auth.uid() and business_id=v_business;
    if v_available<v_tx.amount then raise exception 'Saldo de teste insuficiente para simular este estorno.'; end if;
  end if;
  update public.nexora_sandbox_transactions set status=p_next_status,updated_at=now() where id=v_tx.id;
  insert into public.nexora_sandbox_events(transaction_id,owner_id,idempotency_key,event_type,from_status,to_status)
    values(v_tx.id,auth.uid(),p_idempotency_key,'sandbox.'||v_tx.kind||'.'||p_next_status,v_tx.status,p_next_status);
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(auth.uid(),'sandbox.'||v_tx.kind||'.'||p_next_status,v_tx.id::text,jsonb_build_object('from',v_tx.status,'to',p_next_status,'mode','sandbox'));
  return p_next_status;
end;
$$;

-- Inbox mínimo para futuros webhooks: sem payload bruto/PII e acessível apenas pelo backend.
create table if not exists public.nexora_provider_webhook_inbox (
  id bigint generated always as identity primary key,
  provider_code text not null,
  external_event_id text not null,
  external_transaction_id text,
  normalized_event_type text not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'received' check (status in ('received','processing','processed','retry','failed')),
  attempts integer not null default 0 check (attempts>=0),
  next_attempt_at timestamptz,
  last_error_code text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique(provider_code,external_event_id)
);
create index if not exists nexora_provider_webhook_pending on public.nexora_provider_webhook_inbox(status,received_at);

-- Outbound operation keys are reserved server-side before a provider request is sent.
create table if not exists public.nexora_provider_operations (
  id bigint generated always as identity primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  provider_code text not null,
  idempotency_key text not null,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  operation text not null check (operation in ('payment.create','payment.refund','withdrawal.create','transaction.query')),
  internal_transaction_id uuid references public.nexora_transactions(id),
  provider_reference text,
  status text not null default 'reserved' check (status in ('reserved','sent','succeeded','failed','unknown')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(business_id,idempotency_key)
);

create or replace function public.nexora_provider_reserve_operation(
  p_business_id uuid,p_owner_id uuid,p_provider_code text,p_idempotency_key text,
  p_request_hash text,p_operation text,p_internal_transaction_id uuid default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.nexora_provider_operations;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if not coalesce((select not sandbox and gateway_ready from public.nexora_runtime_config where id=true),false) then
    raise exception 'Provider operations are disabled until the production gateway is explicitly enabled.';
  end if;
  if p_business_id is null or p_owner_id is null or nullif(trim(p_provider_code),'') is null
    or p_idempotency_key is null or length(p_idempotency_key) not between 16 and 128
    or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
    or p_operation is null or p_operation not in ('payment.create','payment.refund','withdrawal.create','transaction.query') then
    raise exception 'Invalid provider operation request.';
  end if;
  if not exists(select 1 from public.businesses b join public.nexora_merchant_provider_connections c
      on c.business_id=b.id and c.owner_id=b.owner_id join public.nexora_acquirers a on a.id=c.acquirer_id
      where b.id=p_business_id and b.owner_id=p_owner_id and a.code=p_provider_code
        and a.status='enabled' and c.status='active') then
    raise exception 'No active provider connection for this merchant.';
  end if;
  insert into public.nexora_provider_operations(business_id,owner_id,provider_code,idempotency_key,request_hash,operation,internal_transaction_id)
    values(p_business_id,p_owner_id,p_provider_code,p_idempotency_key,p_request_hash,p_operation,p_internal_transaction_id)
    on conflict(business_id,idempotency_key) do nothing;
  select * into v_row from public.nexora_provider_operations where business_id=p_business_id and idempotency_key=p_idempotency_key for update;
  if v_row.request_hash<>p_request_hash or v_row.operation<>p_operation or v_row.provider_code<>p_provider_code then
    raise exception 'Idempotency key was already used for a different request.';
  end if;
  return jsonb_build_object('id',v_row.id,'status',v_row.status,'provider_reference',v_row.provider_reference,
    'internal_transaction_id',v_row.internal_transaction_id,'created_at',v_row.created_at);
end;
$$;

create or replace function public.nexora_provider_update_operation(p_id bigint,p_status text,p_provider_reference text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_row public.nexora_provider_operations;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  select * into v_row from public.nexora_provider_operations where id=p_id for update;
  if not found then raise exception 'Provider operation not found.'; end if;
  if p_status is null or p_status not in ('sent','succeeded','failed','unknown') then raise exception 'Invalid provider operation status.'; end if;
  if not ((v_row.status='reserved' and p_status in ('sent','failed','unknown'))
      or (v_row.status='sent' and p_status in ('succeeded','failed','unknown'))
      or (v_row.status='unknown' and p_status in ('succeeded','failed'))
      or (v_row.status=p_status)) then
    raise exception 'Unsafe provider operation transition: % -> %.',v_row.status,p_status;
  end if;
  update public.nexora_provider_operations set status=p_status,
    provider_reference=coalesce(nullif(trim(p_provider_reference),''),provider_reference),updated_at=now() where id=p_id;
end;
$$;

-- Call only after the selected adapter verifies signature/timestamp and normalizes the event.
-- A duplicate provider event ID returns false and must never be applied twice.
create or replace function public.nexora_provider_accept_webhook(
  p_provider_code text,p_external_event_id text,p_external_transaction_id text,
  p_normalized_event_type text,p_payload_sha256 text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_inserted integer; v_existing public.nexora_provider_webhook_inbox;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if nullif(trim(p_provider_code),'') is null or nullif(trim(p_external_event_id),'') is null
    or nullif(trim(p_normalized_event_type),'') is null or p_payload_sha256 is null or p_payload_sha256 !~ '^[a-f0-9]{64}$'
    or length(p_external_event_id)>255 or length(coalesce(p_external_transaction_id,''))>255 then
    raise exception 'Invalid normalized webhook metadata.';
  end if;
  insert into public.nexora_provider_webhook_inbox(provider_code,external_event_id,external_transaction_id,normalized_event_type,payload_sha256)
    values(p_provider_code,p_external_event_id,nullif(p_external_transaction_id,''),p_normalized_event_type,p_payload_sha256)
    on conflict(provider_code,external_event_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted=0 then
    select * into v_existing from public.nexora_provider_webhook_inbox
      where provider_code=p_provider_code and external_event_id=p_external_event_id;
    if v_existing.payload_sha256<>p_payload_sha256 or v_existing.normalized_event_type<>p_normalized_event_type
      or v_existing.external_transaction_id is distinct from nullif(p_external_transaction_id,'') then
      raise exception 'Duplicate webhook ID arrived with different normalized data.';
    end if;
  end if;
  return v_inserted=1;
end;
$$;

alter table public.nexora_provider_webhook_inbox enable row level security;
alter table public.nexora_provider_operations enable row level security;
revoke all on public.nexora_provider_webhook_inbox,public.nexora_provider_operations from public,anon,authenticated;
grant select,insert,update on public.nexora_provider_webhook_inbox,public.nexora_provider_operations to service_role;
grant usage,select on sequence public.nexora_provider_webhook_inbox_id_seq,public.nexora_provider_operations_id_seq to service_role;
revoke all on function public.nexora_provider_reserve_operation(uuid,uuid,text,text,text,text,uuid) from public,anon,authenticated;
revoke all on function public.nexora_provider_update_operation(bigint,text,text) from public,anon,authenticated;
revoke all on function public.nexora_provider_accept_webhook(text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.nexora_provider_reserve_operation(uuid,uuid,text,text,text,text,uuid) to service_role;
grant execute on function public.nexora_provider_update_operation(bigint,text,text) to service_role;
grant execute on function public.nexora_provider_accept_webhook(text,text,text,text,text) to service_role;

revoke all on function public.nexora_sandbox_assert() from public,anon,authenticated;
revoke all on function public.nexora_sandbox_snapshot() from public,anon;
revoke all on function public.nexora_sandbox_create_payment(uuid,numeric,text,text) from public,anon;
revoke all on function public.nexora_sandbox_request_withdrawal(uuid,numeric) from public,anon;
revoke all on function public.nexora_sandbox_transition(uuid,uuid,text) from public,anon;
grant execute on function public.nexora_sandbox_snapshot() to authenticated;
grant execute on function public.nexora_sandbox_create_payment(uuid,numeric,text,text) to authenticated;
grant execute on function public.nexora_sandbox_request_withdrawal(uuid,numeric) to authenticated;
grant execute on function public.nexora_sandbox_transition(uuid,uuid,text) to authenticated;
notify pgrst,'reload schema';
commit;

-- Read-only spot checks (expect RLS enabled, anon/authenticated cannot write sandbox data).
select c.relname as table_name,c.relrowsecurity as rls_enabled
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('nexora_sandbox_transactions','nexora_sandbox_events',
  'nexora_provider_webhook_inbox','nexora_provider_operations') order by c.relname;

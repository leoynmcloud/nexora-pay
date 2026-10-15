-- Merchant outbound webhook endpoints, immutable events, and a durable retry queue.
-- Endpoint secrets are AES-GCM envelopes produced by the Edge Function; plaintext
-- is returned once and is never stored in Postgres or included in event payloads.
begin;

do $$ begin
  if to_regclass('public.businesses') is null
     or to_regclass('public.nexora_transactions') is null
     or to_regclass('public.nexora_ledger_journals') is null
     or to_regclass('public.nexora_ledger_entries') is null
     or to_regclass('public.nexora_ledger_accounts') is null
     or to_regclass('public.nexora_audit_log') is null
     or to_regclass('public.merchant_onboarding') is null
     or to_regprocedure('public.is_nexora_super_admin()') is null
     or to_regprocedure('public.nexora_account_active(uuid)') is null then
    raise exception 'Apply the merchant, transaction, ledger, and security migrations first.';
  end if;
end $$;

create table if not exists public.nexora_merchant_webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  owner_id uuid not null,
  endpoint_url text not null check (length(endpoint_url) between 10 and 2048 and endpoint_url ~ '^https://'),
  subscribed_events text[] not null check (cardinality(subscribed_events) between 1 and 20),
  secret_ciphertext text not null check (length(secret_ciphertext) between 40 and 12000 and secret_ciphertext ~ '^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$'),
  secret_fingerprint text not null check (secret_fingerprint ~ '^[a-f0-9]{64}$'),
  status text not null default 'active' check (status in ('active','disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (business_id,owner_id) references public.businesses(id,owner_id) on delete restrict,
  unique (business_id,endpoint_url)
);
create index if not exists nexora_merchant_webhook_endpoints_owner
  on public.nexora_merchant_webhook_endpoints(owner_id,business_id,created_at desc);

create table if not exists public.nexora_merchant_webhook_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  owner_id uuid not null,
  transaction_id uuid,
  event_code text not null check (event_code in (
    'payment.created','payment.pending','payment.processing','payment.succeeded','payment.failed',
    'payment.canceled','payment.refunded','withdrawal.created','withdrawal.processing',
    'withdrawal.succeeded','withdrawal.failed','chargeback.created','chargeback.updated',
    'chargeback.closed','merchant.suspended','merchant.reactivated'
  )),
  idempotency_key text not null check (length(idempotency_key) between 10 and 200),
  payload jsonb not null check (jsonb_typeof(payload)='object'
    and payload->>'event_id'=id::text and payload->>'event'=event_code),
  created_at timestamptz not null default now(),
  foreign key (business_id,owner_id) references public.businesses(id,owner_id) on delete restrict,
  foreign key (transaction_id,business_id,owner_id)
    references public.nexora_transactions(id,business_id,owner_id) on delete restrict,
  unique (business_id,event_code,transaction_id),
  unique (business_id,idempotency_key)
);
create index if not exists nexora_merchant_webhook_events_owner
  on public.nexora_merchant_webhook_events(owner_id,business_id,created_at desc);

create table if not exists public.nexora_merchant_webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.nexora_merchant_webhook_events(id) on delete restrict,
  endpoint_id uuid not null references public.nexora_merchant_webhook_endpoints(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending','delivering','delivered','dead')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 12),
  retry_generation smallint not null default 0 check (retry_generation between 0 and 5),
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_http_status integer check (last_http_status is null or last_http_status between 100 and 599),
  last_error_code text check (last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,80}$'),
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id,endpoint_id),
  check ((status='delivered')=(delivered_at is not null)),
  check ((status='delivering')=(lease_token is not null and lease_expires_at is not null))
);
create index if not exists nexora_merchant_webhook_deliveries_due
  on public.nexora_merchant_webhook_deliveries(status,next_attempt_at,created_at)
  where status in ('pending','delivering');

create table if not exists public.nexora_merchant_webhook_attempts (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.nexora_merchant_webhook_deliveries(id) on delete restrict,
  retry_generation smallint not null default 0 check (retry_generation between 0 and 5),
  attempt_number integer not null check (attempt_number between 1 and 12),
  outcome text not null check (outcome in ('delivered','retrying','dead')),
  http_status integer check (http_status is null or http_status between 100 and 599),
  error_code text check (error_code is null or error_code ~ '^[a-z0-9_]{1,80}$'),
  duration_ms integer not null check (duration_ms between 0 and 60000),
  attempted_at timestamptz not null default now()
);
alter table public.nexora_merchant_webhook_deliveries
  add column if not exists retry_generation smallint not null default 0;
alter table public.nexora_merchant_webhook_attempts
  add column if not exists retry_generation smallint not null default 0;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid='public.nexora_merchant_webhook_deliveries'::regclass and conname='nexora_webhook_delivery_generation_check') then
    alter table public.nexora_merchant_webhook_deliveries add constraint nexora_webhook_delivery_generation_check check (retry_generation between 0 and 5);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.nexora_merchant_webhook_attempts'::regclass and conname='nexora_webhook_attempt_generation_check') then
    alter table public.nexora_merchant_webhook_attempts add constraint nexora_webhook_attempt_generation_check check (retry_generation between 0 and 5);
  end if;
end $$;
alter table public.nexora_merchant_webhook_attempts
  drop constraint if exists nexora_merchant_webhook_attempts_delivery_id_attempt_number_key;
create unique index if not exists nexora_merchant_webhook_attempts_generation_number
  on public.nexora_merchant_webhook_attempts(delivery_id,retry_generation,attempt_number);

alter table public.nexora_merchant_webhook_endpoints enable row level security;
alter table public.nexora_merchant_webhook_events enable row level security;
alter table public.nexora_merchant_webhook_deliveries enable row level security;
alter table public.nexora_merchant_webhook_attempts enable row level security;
revoke all on public.nexora_merchant_webhook_endpoints,public.nexora_merchant_webhook_events,
  public.nexora_merchant_webhook_deliveries,public.nexora_merchant_webhook_attempts from public,anon,authenticated,service_role;

create or replace function public.nexora_merchant_webhook_reject_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'Merchant webhook events and delivery attempts are append-only.'; end;
$$;
revoke all on function public.nexora_merchant_webhook_reject_mutation() from public,anon,authenticated,service_role;
drop trigger if exists nexora_merchant_webhook_events_immutable on public.nexora_merchant_webhook_events;
create trigger nexora_merchant_webhook_events_immutable before update or delete on public.nexora_merchant_webhook_events
  for each row execute function public.nexora_merchant_webhook_reject_mutation();
drop trigger if exists nexora_merchant_webhook_attempts_immutable on public.nexora_merchant_webhook_attempts;
create trigger nexora_merchant_webhook_attempts_immutable before update or delete on public.nexora_merchant_webhook_attempts
  for each row execute function public.nexora_merchant_webhook_reject_mutation();

create or replace function public.nexora_merchant_webhook_create_endpoint(
  p_business_id uuid,p_endpoint_url text,p_subscribed_events text[],p_secret_ciphertext text,p_secret_fingerprint text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_owner uuid := auth.uid(); v_count integer;
begin
  if coalesce(auth.jwt()->>'role','')<>'authenticated' or v_owner is null then raise exception 'Merchant session required.'; end if;
  if p_business_id is null or p_endpoint_url is null or length(p_endpoint_url) not between 10 and 2048
    or p_endpoint_url !~ '^https://' or p_endpoint_url ~ '[[:space:]?#]'
    or p_endpoint_url ~* '^https://(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|\[::1\])'
    or p_subscribed_events is null or cardinality(p_subscribed_events) not between 1 and 20
    or exists(select 1 from unnest(p_subscribed_events) as e(value)
      where value is null or value not in ('payment.succeeded','payment.failed','payment.canceled'))
    or p_secret_ciphertext is null or length(p_secret_ciphertext) not between 40 and 12000
    or p_secret_ciphertext !~ '^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$'
    or p_secret_fingerprint is null or p_secret_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid merchant webhook endpoint.';
  end if;
  perform 1 from public.businesses b where b.id=p_business_id and b.owner_id=v_owner for update;
  if not found or not exists(select 1 from public.merchant_onboarding k where k.user_id=v_owner and k.status='APPROVED')
     or not public.nexora_account_active(v_owner) then raise exception 'Approved active merchant is required.'; end if;
  select count(*) into v_count from public.nexora_merchant_webhook_endpoints e
    where e.business_id=p_business_id and e.owner_id=v_owner and e.status='active';
  if v_count>=10 then raise exception 'Maximum active webhook endpoint limit reached.'; end if;
  insert into public.nexora_merchant_webhook_endpoints(
    business_id,owner_id,endpoint_url,subscribed_events,secret_ciphertext,secret_fingerprint
  ) values (p_business_id,v_owner,p_endpoint_url,p_subscribed_events,p_secret_ciphertext,p_secret_fingerprint)
  returning id into v_id;
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(v_owner,'merchant.webhook.endpoint.created',v_id::text,jsonb_build_object(
      'business_id',p_business_id,'events',p_subscribed_events,'secret_fingerprint',p_secret_fingerprint
    ));
  return jsonb_build_object('id',v_id,'endpoint_url',p_endpoint_url,'events',p_subscribed_events,'status','active');
end;
$$;
revoke all on function public.nexora_merchant_webhook_create_endpoint(uuid,text,text[],text,text) from public,anon;
grant execute on function public.nexora_merchant_webhook_create_endpoint(uuid,text,text[],text,text) to authenticated;

create or replace function public.nexora_merchant_webhook_list_endpoints(p_business_id uuid)
returns table(id uuid,endpoint_url text,subscribed_events text[],status text,created_at timestamptz,updated_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.jwt()->>'role','')<>'authenticated' or auth.uid() is null then raise exception 'Merchant session required.'; end if;
  return query select e.id,e.endpoint_url,e.subscribed_events,e.status,e.created_at,e.updated_at
    from public.nexora_merchant_webhook_endpoints e
    where e.business_id=p_business_id and e.owner_id=auth.uid()
    order by e.created_at desc limit 50;
end;
$$;
revoke all on function public.nexora_merchant_webhook_list_endpoints(uuid) from public,anon;
grant execute on function public.nexora_merchant_webhook_list_endpoints(uuid) to authenticated;

create or replace function public.nexora_merchant_webhook_disable_endpoint(p_endpoint_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_business_id uuid;
begin
  if coalesce(auth.jwt()->>'role','')<>'authenticated' or auth.uid() is null then raise exception 'Merchant session required.'; end if;
  update public.nexora_merchant_webhook_endpoints e set status='disabled',updated_at=now()
    where e.id=p_endpoint_id and e.owner_id=auth.uid() returning e.business_id into v_business_id;
  if v_business_id is null then raise exception 'Webhook endpoint not found.'; end if;
  update public.nexora_merchant_webhook_deliveries d set status='dead',lease_token=null,lease_expires_at=null,
    last_error_code='endpoint_disabled',updated_at=now()
    where d.endpoint_id=p_endpoint_id and d.status in ('pending','delivering');
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(auth.uid(),'merchant.webhook.endpoint.disabled',p_endpoint_id::text,jsonb_build_object('business_id',v_business_id));
end;
$$;
revoke all on function public.nexora_merchant_webhook_disable_endpoint(uuid) from public,anon;
grant execute on function public.nexora_merchant_webhook_disable_endpoint(uuid) to authenticated;

create or replace function public.nexora_merchant_webhook_rotate_endpoint(
  p_endpoint_id uuid,p_secret_ciphertext text,p_secret_fingerprint text
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_business_id uuid;
begin
  if coalesce(auth.jwt()->>'role','')<>'authenticated' or auth.uid() is null then raise exception 'Merchant session required.'; end if;
  if p_secret_ciphertext is null or length(p_secret_ciphertext) not between 40 and 12000
    or p_secret_ciphertext !~ '^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$'
    or p_secret_fingerprint is null or p_secret_fingerprint !~ '^[a-f0-9]{64}$' then raise exception 'Invalid webhook secret.'; end if;
  update public.nexora_merchant_webhook_endpoints e set secret_ciphertext=p_secret_ciphertext,
    secret_fingerprint=p_secret_fingerprint,updated_at=now()
    where e.id=p_endpoint_id and e.owner_id=auth.uid() and e.status='active' returning e.business_id into v_business_id;
  if v_business_id is null then raise exception 'Active webhook endpoint not found.'; end if;
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(auth.uid(),'merchant.webhook.secret.rotated',p_endpoint_id::text,jsonb_build_object('business_id',v_business_id,'fingerprint',p_secret_fingerprint));
end;
$$;
revoke all on function public.nexora_merchant_webhook_rotate_endpoint(uuid,text,text) from public,anon;
grant execute on function public.nexora_merchant_webhook_rotate_endpoint(uuid,text,text) to authenticated;

create or replace function public.nexora_webhook_enqueue_payment_succeeded(p_transaction_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_tx public.nexora_transactions;
  v_event_id uuid;
  v_now timestamptz:=now();
  v_hash text;
  v_receipt_journal_count bigint;
  v_receipt_entry_count bigint;
  v_pending_cents numeric;
  v_provider_clearing_debit numeric;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  select * into v_tx from public.nexora_transactions t where t.id=p_transaction_id
    and t.status='paid' and t.kind='payment' and not t.test_mode for share;
  if not found or v_tx.acquirer_id is null then raise exception 'Verified production payment not found.'; end if;
  select count(distinct j.id),count(le.id),
    coalesce(sum(le.amount_cents) filter(where la.account_code='merchant_pending' and le.side='credit'),0),
    coalesce(sum(le.amount_cents) filter(where la.account_code='provider_clearing' and le.side='debit'),0)
    into v_receipt_journal_count,v_receipt_entry_count,v_pending_cents,v_provider_clearing_debit
    from public.nexora_ledger_journals j
    join public.nexora_ledger_entries le on le.journal_id=j.id
    join public.nexora_ledger_accounts la on la.id=le.account_id
    where j.transaction_id=v_tx.id and j.event_code='payment.received';
  if v_receipt_journal_count<>1 or v_receipt_entry_count<>2
    or v_pending_cents<>round(v_tx.amount*100)::bigint
    or v_provider_clearing_debit<>round(v_tx.amount*100)::bigint then
    raise exception 'Exact two-entry pending receipt journal is required before merchant notification.';
  end if;
  v_hash := 'payment.succeeded:'||v_tx.id::text;
  v_event_id := gen_random_uuid();
  insert into public.nexora_merchant_webhook_events(
    id,business_id,owner_id,transaction_id,event_code,idempotency_key,payload,created_at
  ) values (
    v_event_id,v_tx.business_id,v_tx.owner_id,v_tx.id,'payment.succeeded',v_hash,
    jsonb_build_object('event_id',v_event_id,'event','payment.succeeded','created_at',v_now,
      'data',jsonb_build_object('transaction_id',v_tx.id,'merchant_id',v_tx.business_id,
        'amount',round(v_tx.amount*100)::bigint,'currency','BRL','status','SUCCEEDED')),
    v_now
  ) on conflict(business_id,event_code,transaction_id) do nothing;
  if not found then
    select e.id into v_event_id from public.nexora_merchant_webhook_events e
      where e.business_id=v_tx.business_id and e.event_code='payment.succeeded' and e.transaction_id=v_tx.id;
    return v_event_id;
  end if;
  insert into public.nexora_merchant_webhook_deliveries(event_id,endpoint_id)
    select v_event_id,e.id from public.nexora_merchant_webhook_endpoints e
    where e.business_id=v_tx.business_id and e.owner_id=v_tx.owner_id and e.status='active'
      and 'payment.succeeded'=any(e.subscribed_events)
    on conflict(event_id,endpoint_id) do nothing;
  return v_event_id;
end;
$$;
revoke all on function public.nexora_webhook_enqueue_payment_succeeded(uuid) from public,anon,authenticated;
grant execute on function public.nexora_webhook_enqueue_payment_succeeded(uuid) to service_role;

create or replace function public.nexora_webhook_enqueue_payment_terminal(
  p_transaction_id uuid,p_event_code text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_tx public.nexora_transactions;
  v_event_id uuid;
  v_attempt_status text;
  v_last_error_code text;
  v_provider_status text;
  v_payload_status text;
  v_now timestamptz:=now();
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_transaction_id is null or p_event_code is null
     or p_event_code not in ('payment.failed','payment.canceled') then
    raise exception 'Invalid terminal payment event.';
  end if;
  select * into v_tx from public.nexora_transactions t
    where t.id=p_transaction_id and t.status='cancelled' and t.kind='payment' and not t.test_mode;
  if not found then return null; end if;

  execute 'select a.status,a.last_error_code,d.normalized_status
    from public.nexora_payment_attempts a
    left join public.nexora_provider_payment_details d on d.provider_operation_id=a.provider_operation_id
    where a.transaction_id=$1'
    into v_attempt_status,v_last_error_code,v_provider_status using p_transaction_id;
  if p_event_code='payment.failed' then
    if v_attempt_status is distinct from 'failed'
      or (v_last_error_code is null and v_provider_status is distinct from 'FAILED') then return null; end if;
    v_payload_status:='FAILED';
  else
    if v_attempt_status is distinct from 'failed' or v_provider_status is null
      or v_provider_status not in ('CANCELED','EXPIRED') then return null; end if;
    v_payload_status:='CANCELED';
  end if;

  v_event_id:=gen_random_uuid();
  insert into public.nexora_merchant_webhook_events(
    id,business_id,owner_id,transaction_id,event_code,idempotency_key,payload,created_at
  ) values (
    v_event_id,v_tx.business_id,v_tx.owner_id,v_tx.id,p_event_code,p_event_code||':'||v_tx.id::text,
    jsonb_build_object('event_id',v_event_id,'event',p_event_code,'created_at',v_now,
      'data',jsonb_build_object('transaction_id',v_tx.id,'merchant_id',v_tx.business_id,
        'amount',round(v_tx.amount*100)::bigint,'currency','BRL','status',v_payload_status)),
    v_now
  ) on conflict(business_id,event_code,transaction_id) do nothing;
  if not found then
    select e.id into v_event_id from public.nexora_merchant_webhook_events e
      where e.business_id=v_tx.business_id and e.event_code=p_event_code and e.transaction_id=v_tx.id;
    return v_event_id;
  end if;
  insert into public.nexora_merchant_webhook_deliveries(event_id,endpoint_id)
    select v_event_id,e.id from public.nexora_merchant_webhook_endpoints e
    where e.business_id=v_tx.business_id and e.owner_id=v_tx.owner_id and e.status='active'
      and p_event_code=any(e.subscribed_events)
    on conflict(event_id,endpoint_id) do nothing;
  return v_event_id;
end;
$$;
revoke all on function public.nexora_webhook_enqueue_payment_terminal(uuid,text) from public,anon,authenticated;
grant execute on function public.nexora_webhook_enqueue_payment_terminal(uuid,text) to service_role;

drop function if exists public.nexora_webhook_claim_deliveries(integer);
create or replace function public.nexora_webhook_claim_deliveries(p_limit integer default 20)
returns table(delivery_id uuid,lease_token uuid,endpoint_id uuid,endpoint_url text,secret_ciphertext text,
  event_id uuid,payload_text text,retry_generation smallint,attempt_count integer)
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_limit is null or p_limit not between 1 and 50 then raise exception 'Invalid webhook claim limit.'; end if;
  insert into public.nexora_merchant_webhook_attempts(delivery_id,retry_generation,attempt_number,outcome,http_status,error_code,duration_ms)
    select d.id,d.retry_generation,d.attempt_count,case when d.attempt_count>=12 then 'dead' else 'retrying' end,
      null,case when d.attempt_count>=12 then 'retry_limit_exceeded' else 'lease_expired' end,0
    from public.nexora_merchant_webhook_deliveries d
    where d.status='delivering' and d.lease_expires_at<=now()
    on conflict(delivery_id,retry_generation,attempt_number) do nothing;
  return query
  with candidates as (
    select d.id from public.nexora_merchant_webhook_deliveries d
    join public.nexora_merchant_webhook_endpoints ep on ep.id=d.endpoint_id and ep.status='active'
    where (d.status='pending' and d.next_attempt_at<=now())
      or (d.status='delivering' and d.lease_expires_at<=now())
    order by d.next_attempt_at,d.created_at,d.id
    for update of d skip locked limit p_limit
  ),claimed as (
    update public.nexora_merchant_webhook_deliveries d set status='delivering',attempt_count=d.attempt_count+1,
      lease_token=gen_random_uuid(),lease_expires_at=now()+interval '45 seconds',
      last_http_status=null,last_error_code=null,updated_at=now()
    from candidates c where d.id=c.id and d.attempt_count<12
      returning d.id,d.lease_token,d.endpoint_id,d.retry_generation,d.attempt_count
  )
    select c.id,c.lease_token,c.endpoint_id,ep.endpoint_url,ep.secret_ciphertext,e.id,e.payload::text,
      c.retry_generation,c.attempt_count
  from claimed c join public.nexora_merchant_webhook_endpoints ep on ep.id=c.endpoint_id
    join public.nexora_merchant_webhook_events e on e.id=(select d.event_id from public.nexora_merchant_webhook_deliveries d where d.id=c.id);
  insert into public.nexora_merchant_webhook_attempts(delivery_id,retry_generation,attempt_number,outcome,http_status,error_code,duration_ms)
    select d.id,d.retry_generation,d.attempt_count,'dead',null,'retry_limit_exceeded',0
    from public.nexora_merchant_webhook_deliveries d
    where d.attempt_count>=12 and ((d.status='pending' and d.next_attempt_at<=now())
      or (d.status='delivering' and d.lease_expires_at<=now()))
    on conflict(delivery_id,retry_generation,attempt_number) do nothing;
  update public.nexora_merchant_webhook_deliveries d set status='dead',lease_token=null,lease_expires_at=null,
    last_error_code='retry_limit_exceeded',updated_at=now()
    where d.attempt_count>=12 and ((d.status='pending' and d.next_attempt_at<=now())
      or (d.status='delivering' and d.lease_expires_at<=now()));
end;
$$;
revoke all on function public.nexora_webhook_claim_deliveries(integer) from public,anon,authenticated;
grant execute on function public.nexora_webhook_claim_deliveries(integer) to service_role;

drop function if exists public.nexora_webhook_finish_delivery(uuid,uuid,integer,text);
drop function if exists public.nexora_webhook_finish_delivery(uuid,uuid,integer,text,integer);
create or replace function public.nexora_webhook_finish_delivery(
  p_delivery_id uuid,p_lease_token uuid,p_retry_generation smallint,p_http_status integer,p_error_code text,p_duration_ms integer
)
returns text language plpgsql security definer set search_path = '' as $$
declare v_row public.nexora_merchant_webhook_deliveries; v_next text; v_outcome text;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_delivery_id is null or p_lease_token is null or p_retry_generation is null or p_retry_generation not between 0 and 5
     or (p_http_status is not null and p_http_status not between 100 and 599)
     or (p_error_code is not null and p_error_code !~ '^[a-z0-9_]{1,80}$')
     or p_duration_ms is null or p_duration_ms not between 0 and 60000 then raise exception 'Invalid webhook result.'; end if;
  select * into v_row from public.nexora_merchant_webhook_deliveries d
    where d.id=p_delivery_id and d.status='delivering' and d.lease_token=p_lease_token
      and d.retry_generation=p_retry_generation for update;
  if not found then return 'stale'; end if;
  if p_http_status between 200 and 299 then
    insert into public.nexora_merchant_webhook_attempts(delivery_id,retry_generation,attempt_number,outcome,http_status,duration_ms)
      values(p_delivery_id,v_row.retry_generation,v_row.attempt_count,'delivered',p_http_status,p_duration_ms);
    update public.nexora_merchant_webhook_deliveries set status='delivered',delivered_at=now(),
      last_http_status=p_http_status,last_error_code=null,lease_token=null,lease_expires_at=null,updated_at=now()
      where id=p_delivery_id;
    return 'delivered';
  end if;
  if v_row.attempt_count>=12 then v_next:='dead';
  else v_next:='pending'; end if;
  v_outcome:=case when v_next='dead' then 'dead' else 'retrying' end;
  insert into public.nexora_merchant_webhook_attempts(delivery_id,retry_generation,attempt_number,outcome,http_status,error_code,duration_ms)
    values(p_delivery_id,v_row.retry_generation,v_row.attempt_count,v_outcome,p_http_status,coalesce(p_error_code,'non_2xx_response'),p_duration_ms);
  update public.nexora_merchant_webhook_deliveries set status=v_next,
    next_attempt_at=now()+make_interval(secs=>least(3600.0,60.0*power(2.0,least(v_row.attempt_count-1,6)))::double precision),
    last_http_status=p_http_status,last_error_code=coalesce(p_error_code,'non_2xx_response'),
    lease_token=null,lease_expires_at=null,updated_at=now()
    where id=p_delivery_id;
  return v_next;
end;
$$;
revoke all on function public.nexora_webhook_finish_delivery(uuid,uuid,smallint,integer,text,integer) from public,anon,authenticated;
grant execute on function public.nexora_webhook_finish_delivery(uuid,uuid,smallint,integer,text,integer) to service_role;

create or replace function public.nexora_admin_webhook_delivery_snapshot(p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_nexora_super_admin() then raise exception 'Acesso restrito ao Painel Nexora Pay.'; end if;
  if p_limit is null or p_limit not between 1 and 250 then raise exception 'Invalid webhook list limit.'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'delivery_id',q.id,'event_id',q.event_id,'event',q.event_code,'business_id',q.business_id,
      'business_name',q.business_name,'merchant_email',q.merchant_email,'endpoint_url',q.endpoint_url,
      'status',q.status,'attempt_count',q.attempt_count,'retry_generation',q.retry_generation,
      'last_http_status',q.last_http_status,'last_error_code',q.last_error_code,
      'next_attempt_at',q.next_attempt_at,'created_at',q.created_at,'updated_at',q.updated_at,
      'delivered_at',q.delivered_at,'attempts',q.attempts
    ) order by q.updated_at desc)
    from (
      select d.id,d.event_id,e.event_code,e.business_id,b.name as business_name,u.email as merchant_email,
        ep.endpoint_url,d.status,d.attempt_count,d.retry_generation,d.last_http_status,d.last_error_code,
        d.next_attempt_at,d.created_at,d.updated_at,d.delivered_at,
        (select coalesce(jsonb_agg(jsonb_build_object(
          'retry_generation',recent.retry_generation,'attempt_number',recent.attempt_number,
          'outcome',recent.outcome,'http_status',recent.http_status,'error_code',recent.error_code,
          'duration_ms',recent.duration_ms,'attempted_at',recent.attempted_at
        ) order by recent.retry_generation desc,recent.attempt_number desc),'[]'::jsonb)
         from (select a.* from public.nexora_merchant_webhook_attempts a
           where a.delivery_id=d.id order by a.retry_generation desc,a.attempt_number desc limit 20) recent) as attempts
      from public.nexora_merchant_webhook_deliveries d
      join public.nexora_merchant_webhook_events e on e.id=d.event_id
      join public.nexora_merchant_webhook_endpoints ep on ep.id=d.endpoint_id
      join public.businesses b on b.id=e.business_id and b.owner_id=e.owner_id
      join auth.users u on u.id=e.owner_id
      order by d.updated_at desc,d.id desc limit p_limit
    ) q
  ),'[]'::jsonb);
end;
$$;

create or replace function public.nexora_admin_webhook_retry_delivery(p_delivery_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_delivery public.nexora_merchant_webhook_deliveries;
begin
  if not public.is_nexora_super_admin() then raise exception 'Acesso restrito ao Painel Nexora Pay.'; end if;
  if p_delivery_id is null or length(trim(coalesce(p_reason,''))) not between 8 and 500 then
    raise exception 'Informe um motivo de reenvio entre 8 e 500 caracteres.';
  end if;
  select * into v_delivery from public.nexora_merchant_webhook_deliveries d
    where d.id=p_delivery_id and d.status in ('dead','delivered') for update;
  if not found then raise exception 'Somente entregas encerradas podem ser reenviadas.'; end if;
  if v_delivery.retry_generation>=5 then raise exception 'Limite de reenvios administrativos atingido.'; end if;
  update public.nexora_merchant_webhook_deliveries set status='pending',attempt_count=0,
    retry_generation=v_delivery.retry_generation+1,next_attempt_at=now(),lease_token=null,
    lease_expires_at=null,last_http_status=null,last_error_code=null,delivered_at=null,updated_at=now()
    where id=p_delivery_id;
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(auth.uid(),'merchant.webhook.delivery_retried',p_delivery_id::text,jsonb_build_object(
      'event_id',v_delivery.event_id,'endpoint_id',v_delivery.endpoint_id,'previous_status',v_delivery.status,
      'previous_attempt_count',v_delivery.attempt_count,'retry_generation',v_delivery.retry_generation+1,
      'reason',trim(p_reason)
    ));
  return jsonb_build_object('delivery_id',p_delivery_id,'status','pending',
    'retry_generation',v_delivery.retry_generation+1);
end;
$$;
revoke all on function public.nexora_admin_webhook_delivery_snapshot(integer) from public,anon;
revoke all on function public.nexora_admin_webhook_retry_delivery(uuid,text) from public,anon;
grant execute on function public.nexora_admin_webhook_delivery_snapshot(integer) to authenticated;
grant execute on function public.nexora_admin_webhook_retry_delivery(uuid,text) to authenticated;

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
where n.nspname='public' and c.relname in (
  'nexora_merchant_webhook_endpoints','nexora_merchant_webhook_events','nexora_merchant_webhook_deliveries',
  'nexora_merchant_webhook_attempts'
) order by c.relname;

select p.oid::regprocedure as function_name,
  has_function_privilege('anon',p.oid,'EXECUTE') as anon_can_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_can_execute,
  has_function_privilege('service_role',p.oid,'EXECUTE') as service_role_can_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in (
  'nexora_webhook_claim_deliveries','nexora_webhook_finish_delivery',
  'nexora_admin_webhook_delivery_snapshot','nexora_admin_webhook_retry_delivery'
) order by p.proname;

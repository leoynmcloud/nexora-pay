-- Provider-neutral production charge attempts.
-- Run after provider operation core, central credentials, pricing, production
-- ledger and transaction-status migrations. This does not enable an acquirer.
begin;

do $$ begin
  if to_regclass('public.nexora_provider_payment_operations') is null
     or to_regclass('public.nexora_transactions') is null
     or to_regclass('public.nexora_acquirers') is null
     or to_regclass('public.nexora_merchant_provider_connections') is null
     or to_regclass('public.nexora_platform_provider_credentials') is null
     or to_regclass('public.nexora_applied_pricing') is null
     or to_regclass('public.nexora_checkout_links') is null
     or to_regclass('public.nexora_provider_payment_status_events') is null
     or to_regclass('public.nexora_provider_webhook_inbox') is null
     or to_regclass('public.businesses') is null
     or to_regclass('public.merchant_onboarding') is null
     or to_regclass('public.user_settings') is null
     or to_regclass('public.nexora_runtime_config') is null
     or to_regclass('public.nexora_merchant_controls') is null
     or to_regclass('public.nexora_ledger_journals') is null
     or to_regclass('public.nexora_ledger_entries') is null
     or to_regclass('public.nexora_ledger_accounts') is null
     or to_regclass('public.nexora_merchant_webhook_events') is null
     or to_regprocedure('public.nexora_pricing_apply(uuid,uuid,uuid,uuid)') is null
     or to_regprocedure('public.nexora_provider_accept_webhook(text,text,text,text,text)') is null
     or to_regprocedure('public.nexora_webhook_enqueue_payment_succeeded(uuid)') is null
     or to_regprocedure('public.nexora_webhook_enqueue_payment_terminal(uuid,text)') is null
     or to_regprocedure('public.nexora_workspace_read_id()') is null
     or to_regprocedure('public.is_nexora_super_admin()') is null
     or to_regprocedure('public.nexora_ledger_reject_mutation()') is null then
    raise exception 'Apply provider core, credentials, pricing and transaction migrations first.';
  end if;
end $$;

create table if not exists public.nexora_payment_attempts (
  id uuid primary key default gen_random_uuid(),
  provider_operation_id uuid not null unique references public.nexora_provider_payment_operations(id) on delete restrict,
  transaction_id uuid not null unique,
  business_id uuid not null,
  owner_id uuid not null,
  acquirer_id uuid not null references public.nexora_acquirers(id) on delete restrict,
  platform_credential_id uuid not null references public.nexora_platform_provider_credentials(id) on delete restrict,
  -- Include the provider slug in the ledger idempotency key (max 128 chars).
  provider_code text not null check (provider_code ~ '^[a-z][a-z0-9_-]{1,63}$'),
  environment text not null check (environment in ('production','sandbox')),
  connection_version timestamptz,
  idempotency_key uuid not null,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  external_reference text not null check (length(trim(external_reference)) between 1 and 255),
  provider_transaction_id text check (provider_transaction_id is null or length(trim(provider_transaction_id)) between 1 and 255),
  status text not null default 'created' check (status in ('created','processing','succeeded','failed','unknown')),
  lease_token uuid,
  lease_expires_at timestamptz,
  payment_attempted_at timestamptz,
  last_error_code text check (last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,80}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (transaction_id,business_id,owner_id)
    references public.nexora_transactions(id,business_id,owner_id) on delete restrict,
  unique (business_id,idempotency_key),
  unique (acquirer_id,environment,external_reference),
  unique (acquirer_id,environment,provider_transaction_id)
);
alter table public.nexora_payment_attempts
  add column if not exists connection_version timestamptz;
create index if not exists nexora_payment_attempts_owner_date
  on public.nexora_payment_attempts(owner_id,created_at desc);
create index if not exists nexora_payment_attempts_recovery
  on public.nexora_payment_attempts(status,lease_expires_at)
  where payment_attempted_at is null;

create table if not exists public.nexora_provider_payment_details (
  id uuid primary key default gen_random_uuid(),
  provider_operation_id uuid not null unique references public.nexora_provider_payment_operations(id) on delete restrict,
  transaction_id uuid not null unique,
  business_id uuid not null,
  owner_id uuid not null,
  provider_transaction_id text not null check (length(trim(provider_transaction_id)) between 1 and 255),
  raw_provider_status text not null check (length(trim(raw_provider_status)) between 1 and 80),
  normalized_status text not null check (normalized_status in (
    'CREATED','PENDING','PROCESSING','AUTHORIZED','SUCCEEDED','SETTLED','FAILED','CANCELED',
    'EXPIRED','REFUND_PENDING','REFUNDED','PARTIALLY_REFUNDED','REVERSED','UNDER_REVIEW'
  )),
  pix_copy_paste text check (pix_copy_paste is null or length(pix_copy_paste)<=5000),
  pix_encoded_image text check (pix_encoded_image is null or length(pix_encoded_image)<=100000),
  checkout_url text check (checkout_url is null or length(checkout_url)<=2000),
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (transaction_id,business_id,owner_id)
    references public.nexora_transactions(id,business_id,owner_id) on delete restrict
);

alter table public.nexora_payment_attempts enable row level security;
alter table public.nexora_provider_payment_details enable row level security;
revoke all on public.nexora_payment_attempts,public.nexora_provider_payment_details
  from public,anon,authenticated,service_role;
grant select on public.nexora_payment_attempts,public.nexora_provider_payment_details to service_role;

create or replace function public.nexora_payment_attempt_identity_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.id is distinct from old.id
     or new.provider_operation_id is distinct from old.provider_operation_id
     or new.transaction_id is distinct from old.transaction_id
     or new.business_id is distinct from old.business_id
     or new.owner_id is distinct from old.owner_id
     or new.acquirer_id is distinct from old.acquirer_id
     or new.platform_credential_id is distinct from old.platform_credential_id
     or new.provider_code is distinct from old.provider_code
     or new.environment is distinct from old.environment
     or new.connection_version is distinct from old.connection_version
     or new.idempotency_key is distinct from old.idempotency_key
     or new.request_hash is distinct from old.request_hash
     or new.external_reference is distinct from old.external_reference
     or (old.provider_transaction_id is not null
       and new.provider_transaction_id is distinct from old.provider_transaction_id)
     or new.created_at is distinct from old.created_at then
    raise exception 'Payment attempt identity is immutable.';
  end if;
  if old.payment_attempted_at is not null and new.payment_attempted_at is distinct from old.payment_attempted_at then
    raise exception 'Provider submission timestamp is immutable.';
  end if;
  return new;
end;
$$;
revoke all on function public.nexora_payment_attempt_identity_guard() from public,anon,authenticated,service_role;
drop trigger if exists nexora_payment_attempt_identity_guard on public.nexora_payment_attempts;
create trigger nexora_payment_attempt_identity_guard before update on public.nexora_payment_attempts
  for each row execute function public.nexora_payment_attempt_identity_guard();

create or replace function public.nexora_provider_payment_details_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.id is distinct from old.id or new.provider_operation_id is distinct from old.provider_operation_id
     or new.transaction_id is distinct from old.transaction_id or new.business_id is distinct from old.business_id
     or new.owner_id is distinct from old.owner_id
     or new.provider_transaction_id is distinct from old.provider_transaction_id then
    raise exception 'Provider payment detail identity is immutable.';
  end if;
  return new;
end;
$$;
revoke all on function public.nexora_provider_payment_details_guard() from public,anon,authenticated,service_role;
drop trigger if exists nexora_provider_payment_details_guard on public.nexora_provider_payment_details;
create trigger nexora_provider_payment_details_guard before update on public.nexora_provider_payment_details
  for each row execute function public.nexora_provider_payment_details_guard();
drop trigger if exists nexora_provider_payment_details_immutable on public.nexora_provider_payment_details;
create trigger nexora_provider_payment_details_immutable before delete on public.nexora_provider_payment_details
  for each row execute function public.nexora_ledger_reject_mutation();

-- Atomically authorize a payment attempt for any active, configured provider
-- route. The provider adapter remains responsible for the outbound API call.
create or replace function public.nexora_provider_begin_charge(
  p_owner_id uuid,p_business_id uuid,p_request_id uuid,p_request_hash text,
  p_customer_name text,p_customer_email text,p_customer_document text,
  p_amount numeric,p_description text,p_acquirer_id uuid,p_environment text,p_connection_version timestamptz
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_connection public.nexora_merchant_provider_connections;
  v_acquirer public.nexora_acquirers;
  v_attempt public.nexora_payment_attempts;
  v_credential public.nexora_platform_provider_credentials;
  v_operation_id uuid;
  v_transaction_id uuid;
  v_customer_id uuid;
  v_lease uuid := gen_random_uuid();
  v_external_reference text;
  v_should_submit boolean := false;
  v_amount_cents bigint;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_owner_id is null or p_business_id is null or p_request_id is null or p_acquirer_id is null
    or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
    or length(trim(coalesce(p_customer_name,''))) not between 2 and 160
    or (nullif(trim(coalesce(p_customer_email,'')),'') is not null and
      (length(p_customer_email)>254 or p_customer_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'))
    or p_customer_document is null or p_customer_document !~ '^([0-9]{11}|[A-Z0-9]{12}[0-9]{2})$'
    or p_amount is null or p_amount<=0 or p_amount<>round(p_amount,2) or p_amount>999999.99
    or length(trim(coalesce(p_description,''))) not between 2 and 120
    or p_environment is null or p_environment not in ('production','sandbox')
    or p_connection_version is null then
    raise exception 'Dados da cobrança inválidos.';
  end if;
  v_amount_cents := round(p_amount*100)::bigint;
  perform pg_advisory_xact_lock(hashtextextended(p_business_id::text||':'||p_request_id::text,0));

  select * into v_connection from public.nexora_merchant_provider_connections c
    where c.business_id=p_business_id and c.owner_id=p_owner_id and c.acquirer_id=p_acquirer_id
    for share;
  if not found or v_connection.status<>'active' or v_connection.updated_at is distinct from p_connection_version then
    raise exception 'A rota mudou ou não está ativa. Atualize e tente novamente.';
  end if;
  select * into v_acquirer from public.nexora_acquirers a
    where a.id=p_acquirer_id and a.environment=p_environment and a.status='enabled'
      and 'pix'=any(a.payment_methods) for share;
  if not found then raise exception 'Adquirente não está habilitado para Pix neste ambiente.'; end if;
  if not exists(select 1 from public.businesses b where b.id=p_business_id and b.owner_id=p_owner_id)
     or not exists(select 1 from public.merchant_onboarding k where k.user_id=p_owner_id and k.status='APPROVED')
     or not public.nexora_account_active(p_owner_id)
     or not exists(select 1 from public.nexora_merchant_controls c where c.business_id=p_business_id
       and c.owner_id=p_owner_id and c.payments_enabled) then
    raise exception 'Merchant aprovado, ativo e com recebimentos habilitados é necessário.';
  end if;

  select * into v_attempt from public.nexora_payment_attempts a
    where a.business_id=p_business_id and a.idempotency_key=p_request_id for update;
  if found then
    if (v_attempt.status<>'failed' and v_attempt.request_hash<>p_request_hash) or v_attempt.acquirer_id<>p_acquirer_id
      or v_attempt.environment<>p_environment or v_attempt.connection_version is distinct from p_connection_version then
      raise exception 'A chave idempotente já foi usada para outra solicitação/rota.';
    end if;
    if v_attempt.payment_attempted_at is null and v_attempt.status not in ('succeeded','failed')
       and (v_attempt.lease_expires_at is null or v_attempt.lease_expires_at<=now()) then
      update public.nexora_payment_attempts set status='processing',lease_token=v_lease,
        lease_expires_at=now()+interval '90 seconds',updated_at=now()
        where id=v_attempt.id returning * into v_attempt;
      v_should_submit := true;
    elsif v_attempt.status = 'failed'
       and (v_attempt.lease_expires_at is null or v_attempt.lease_expires_at<=now()) then
      update public.nexora_payment_attempts set status='processing',lease_token=v_lease,
        request_hash=p_request_hash,
        lease_expires_at=now()+interval '90 seconds',payment_attempted_at=null,
        provider_transaction_id=null,last_error_code=null,updated_at=now()
        where id=v_attempt.id returning * into v_attempt;
      v_should_submit := true;
    end if;
    select * into v_credential from public.nexora_platform_provider_credentials c
      where c.id=v_attempt.platform_credential_id;
    if not found then raise exception 'Credencial histórica da tentativa não encontrada.'; end if;
    if v_credential.acquirer_id is distinct from v_attempt.acquirer_id
       or v_credential.environment is distinct from v_attempt.environment then
      raise exception 'A credencial histórica não corresponde ao adquirente e ambiente da tentativa.';
    end if;
    if v_should_submit and v_credential.status<>'active' then
      raise exception 'A credencial desta tentativa não está ativa; o envio foi bloqueado.';
    end if;
    return jsonb_build_object('attempt_id',v_attempt.id,'provider_operation_id',v_attempt.provider_operation_id,
      'transaction_id',v_attempt.transaction_id,'provider_code',v_attempt.provider_code,
      'environment',v_attempt.environment,'external_reference',v_attempt.external_reference,
      'provider_transaction_id',v_attempt.provider_transaction_id,'status',v_attempt.status,
      'payment_attempted_at',v_attempt.payment_attempted_at,'should_submit',v_should_submit,
      'lease_token',v_attempt.lease_token,'api_key_ciphertext',v_credential.api_key_ciphertext,
      'platform_credential_id',v_credential.id,'business_id',v_attempt.business_id,
      'owner_id',v_attempt.owner_id,'acquirer_id',v_attempt.acquirer_id,
      'amount_cents',(select (t.amount*100)::bigint from public.nexora_transactions t where t.id=v_attempt.transaction_id),
      'description',(select t.title from public.nexora_transactions t where t.id=v_attempt.transaction_id));
  end if;

  select * into v_credential from public.nexora_platform_provider_credentials c
    where c.acquirer_id=p_acquirer_id and c.environment=p_environment and c.status='active'
    for share;
  if not found then raise exception 'Credencial central não configurada para o adquirente e ambiente.'; end if;

  v_external_reference := 'NX-'||upper(replace(p_request_id::text,'-',''));
  if nullif(trim(coalesce(p_customer_email,'')),'') is not null then
    insert into public.nexora_customers(owner_id,business_id,name,email,last_activity)
      values(p_owner_id,p_business_id,trim(p_customer_name),lower(trim(p_customer_email)),now())
      on conflict(business_id,email) do update set name=excluded.name,last_activity=now()
      returning id into v_customer_id;
  end if;
  insert into public.nexora_transactions(owner_id,business_id,external_id,title,customer_id,customer_name,
    customer_email,amount,kind,status,source,payment_method,request_id,test_mode,acquirer_id)
  values(p_owner_id,p_business_id,'NX-'||upper(substr(replace(p_request_id::text,'-',''),1,12)),
    trim(p_description),v_customer_id,trim(p_customer_name),nullif(lower(trim(coalesce(p_customer_email,''))),''),
    p_amount,'payment','pending','gateway','pix',p_request_id,p_environment='sandbox',p_acquirer_id)
  returning id into v_transaction_id;

  perform public.nexora_pricing_apply(v_transaction_id,p_business_id,p_owner_id,p_acquirer_id);

  insert into public.nexora_provider_payment_operations(
    transaction_id,business_id,owner_id,acquirer_id,provider_code,environment,
    external_reference,operation_status
  ) values(v_transaction_id,p_business_id,p_owner_id,p_acquirer_id,v_acquirer.code,p_environment,
    v_external_reference,'CREATED') returning id into v_operation_id;

  insert into public.nexora_payment_attempts(
    provider_operation_id,transaction_id,business_id,owner_id,acquirer_id,platform_credential_id,
    provider_code,environment,connection_version,idempotency_key,request_hash,external_reference,status,lease_token,lease_expires_at
  ) values(v_operation_id,v_transaction_id,p_business_id,p_owner_id,p_acquirer_id,v_credential.id,
    v_acquirer.code,p_environment,p_connection_version,p_request_id,p_request_hash,v_external_reference,'processing',v_lease,
    now()+interval '90 seconds') returning * into v_attempt;

  return jsonb_build_object('attempt_id',v_attempt.id,'provider_operation_id',v_attempt.provider_operation_id,
    'transaction_id',v_attempt.transaction_id,'provider_code',v_attempt.provider_code,
    'environment',v_attempt.environment,'external_reference',v_attempt.external_reference,
    'provider_transaction_id',null,'status',v_attempt.status,'payment_attempted_at',null,
    'should_submit',true,'lease_token',v_attempt.lease_token,
    'api_key_ciphertext',v_credential.api_key_ciphertext,'platform_credential_id',v_credential.id,
    'amount_cents',v_amount_cents,'business_id',v_attempt.business_id,'owner_id',v_attempt.owner_id,
    'acquirer_id',v_attempt.acquirer_id,'description',trim(p_description));
end;
$$;
revoke all on function public.nexora_provider_begin_charge(uuid,uuid,uuid,text,text,text,text,numeric,text,uuid,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.nexora_provider_begin_charge(uuid,uuid,uuid,text,text,text,text,numeric,text,uuid,text,timestamptz)
  to service_role;

-- This durable preflight happens before an outbound POST. A retry can never
-- issue a second charge after the provider may have accepted the first one.
create or replace function public.nexora_provider_mark_payment_attempt_started(
  p_attempt_id uuid,p_lease_token uuid
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_attempt public.nexora_payment_attempts;
  v_connection public.nexora_merchant_provider_connections;
  v_acquirer public.nexora_acquirers;
  v_credential public.nexora_platform_provider_credentials;
  v_controls public.nexora_merchant_controls;
  v_block_reason text;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  select * into v_attempt from public.nexora_payment_attempts where id=p_attempt_id for update;
  if not found or p_lease_token is null or v_attempt.lease_token is distinct from p_lease_token
     or v_attempt.lease_expires_at is null or v_attempt.lease_expires_at<=now()
     or v_attempt.payment_attempted_at is not null or v_attempt.status<>'processing' then
    return false;
  end if;
  select * into v_connection from public.nexora_merchant_provider_connections c
    where c.business_id=v_attempt.business_id and c.owner_id=v_attempt.owner_id
      and c.acquirer_id=v_attempt.acquirer_id for share;
  if not found or v_connection.status is distinct from 'active' or v_attempt.connection_version is null
    or v_connection.updated_at is distinct from v_attempt.connection_version then
    v_block_reason:='provider_route_changed';
  end if;
  if v_block_reason is null then
    select * into v_acquirer from public.nexora_acquirers a
      where a.id=v_attempt.acquirer_id for share;
  end if;
  if v_block_reason is null and (not found or v_acquirer.status is distinct from 'enabled'
    or v_acquirer.environment is distinct from v_attempt.environment
    or not coalesce('pix'=any(v_acquirer.payment_methods),false)) then
    v_block_reason:='provider_unavailable';
  end if;
  if v_block_reason is null then
    select * into v_credential from public.nexora_platform_provider_credentials c
      where c.id=v_attempt.platform_credential_id for share;
  end if;
  if v_block_reason is null and (not found or v_credential.status is distinct from 'active'
    or v_credential.acquirer_id is distinct from v_attempt.acquirer_id
    or v_credential.environment is distinct from v_attempt.environment) then
    v_block_reason:='provider_credential_inactive';
  end if;
  if v_block_reason is null then
    select * into v_controls from public.nexora_merchant_controls c
      where c.business_id=v_attempt.business_id and c.owner_id=v_attempt.owner_id for share;
  end if;
  if v_block_reason is null and (not found or v_controls.payments_enabled is distinct from true
    or not exists(select 1 from public.businesses b
      where b.id=v_attempt.business_id and b.owner_id=v_attempt.owner_id)
    or not exists(select 1 from public.merchant_onboarding k
      where k.user_id=v_attempt.owner_id and k.status='APPROVED')
    or public.nexora_account_active(v_attempt.owner_id) is distinct from true) then
    v_block_reason:='merchant_not_operable';
  end if;
  if v_block_reason is null and not exists(select 1 from public.nexora_transactions t
    where t.id=v_attempt.transaction_id and t.business_id=v_attempt.business_id
      and t.owner_id=v_attempt.owner_id and t.kind='payment' and t.status='pending'
      and t.test_mode=(v_attempt.environment='sandbox')) then
    v_block_reason:='transaction_not_pending';
  end if;
  if v_block_reason is not null then
    update public.nexora_payment_attempts set status='failed',last_error_code=v_block_reason,
      lease_expires_at=null,updated_at=now() where id=p_attempt_id and lease_token=p_lease_token;
    update public.nexora_provider_payment_operations set operation_status='FAILED',updated_at=now()
      where id=v_attempt.provider_operation_id;
    update public.nexora_transactions set status='cancelled'
      where id=v_attempt.transaction_id and status='pending';
    update public.nexora_checkout_links set status='failed',updated_at=now()
      where transaction_id=v_attempt.transaction_id and status in ('active','processing');
    return false;
  end if;
  update public.nexora_payment_attempts set payment_attempted_at=now(),status='unknown',
    lease_expires_at=null,updated_at=now() where id=p_attempt_id;
  update public.nexora_checkout_links set status='processing',transaction_id=v_attempt.transaction_id,updated_at=now()
    where transaction_id=v_attempt.transaction_id and status='active';
  return true;
end;
$$;
revoke all on function public.nexora_provider_mark_payment_attempt_started(uuid,uuid) from public,anon,authenticated;
grant execute on function public.nexora_provider_mark_payment_attempt_started(uuid,uuid) to service_role;

-- Record a provider's explicit rejection after the outbound attempt. Ambiguous
-- timeouts must not call this function; they remain unknown for read-only recovery.
create or replace function public.nexora_provider_fail_charge_attempt(
  p_attempt_id uuid,p_lease_token uuid,p_error_code text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_attempt public.nexora_payment_attempts;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_attempt_id is null or p_lease_token is null or p_error_code is null
    or p_error_code !~ '^[a-z0-9_]{1,80}$' then raise exception 'Invalid provider rejection.'; end if;
  select * into v_attempt from public.nexora_payment_attempts where id=p_attempt_id for update;
  if not found or v_attempt.lease_token is distinct from p_lease_token then return false; end if;
  if v_attempt.status='failed' and v_attempt.last_error_code=p_error_code then return true; end if;
  if v_attempt.payment_attempted_at is null or v_attempt.provider_transaction_id is not null
    or v_attempt.status not in ('processing','unknown') then return false; end if;
  update public.nexora_payment_attempts set status='failed',last_error_code=p_error_code,
    lease_expires_at=null,updated_at=now() where id=p_attempt_id;
  update public.nexora_provider_payment_operations set operation_status='FAILED',updated_at=now()
    where id=v_attempt.provider_operation_id;
  update public.nexora_transactions set status='cancelled'
    where id=v_attempt.transaction_id and status in ('pending','processing');
  if found then perform public.nexora_webhook_enqueue_payment_terminal(v_attempt.transaction_id,'payment.failed'); end if;
  update public.nexora_checkout_links set status='failed',updated_at=now()
    where transaction_id=v_attempt.transaction_id and status='processing';
  return true;
end;
$$;
revoke all on function public.nexora_provider_fail_charge_attempt(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.nexora_provider_fail_charge_attempt(uuid,uuid,text) to service_role;

create or replace function public.nexora_provider_save_charge_result(
  p_attempt_id uuid,p_provider_transaction_id text,p_raw_status text,p_normalized_status text,
  p_pix_copy_paste text,p_pix_encoded_image text,p_checkout_url text,p_expires_at timestamptz
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_attempt public.nexora_payment_attempts;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_attempt_id is null or p_provider_transaction_id is null
     or length(trim(p_provider_transaction_id)) not between 1 and 255
     or p_raw_status is null or length(trim(p_raw_status)) not between 1 and 80
     or p_normalized_status is null
     or p_normalized_status not in ('CREATED','PENDING','PROCESSING','AUTHORIZED','SUCCEEDED','SETTLED',
       'FAILED','CANCELED','EXPIRED','REFUND_PENDING','REFUNDED','PARTIALLY_REFUNDED','REVERSED','UNDER_REVIEW')
     or length(coalesce(p_pix_copy_paste,''))>5000 or length(coalesce(p_pix_encoded_image,''))>100000
     or length(coalesce(p_checkout_url,''))>2000 then raise exception 'Resposta de pagamento inválida.'; end if;
  select * into v_attempt from public.nexora_payment_attempts where id=p_attempt_id for update;
  if not found or v_attempt.payment_attempted_at is null then raise exception 'Tentativa não autorizada pelo backend.'; end if;
  if v_attempt.provider_transaction_id is not null and v_attempt.provider_transaction_id<>p_provider_transaction_id then
    raise exception 'ID externo diverge da operação registrada.';
  end if;
  update public.nexora_payment_attempts set provider_transaction_id=p_provider_transaction_id,
    status=case when v_attempt.status='succeeded' then 'succeeded'
      when v_attempt.status='failed' then 'failed'
      when p_normalized_status in ('SUCCEEDED','SETTLED') then 'succeeded'
      when p_normalized_status in ('FAILED','CANCELED','EXPIRED') then 'failed' else 'processing' end,
    last_error_code=null,updated_at=now() where id=p_attempt_id;
  update public.nexora_provider_payment_operations set provider_transaction_id=p_provider_transaction_id,
    operation_status=p_normalized_status,updated_at=now()
    where id=v_attempt.provider_operation_id
      and (provider_transaction_id is null or provider_transaction_id=p_provider_transaction_id);
  if not found then raise exception 'Operação do provedor diverge da tentativa.'; end if;
  update public.nexora_transactions set provider_reference=p_provider_transaction_id
    where id=v_attempt.transaction_id
      and (provider_reference is null or provider_reference=p_provider_transaction_id);
  if not found then raise exception 'Referência externa diverge da transação interna.'; end if;
  insert into public.nexora_provider_payment_details(
    provider_operation_id,transaction_id,business_id,owner_id,provider_transaction_id,
    raw_provider_status,normalized_status,pix_copy_paste,pix_encoded_image,checkout_url,expires_at,updated_at
  ) values(v_attempt.provider_operation_id,v_attempt.transaction_id,v_attempt.business_id,v_attempt.owner_id,
    p_provider_transaction_id,left(trim(p_raw_status),80),p_normalized_status,nullif(p_pix_copy_paste,''),
    nullif(p_pix_encoded_image,''),nullif(p_checkout_url,''),p_expires_at,now())
  on conflict(provider_operation_id) do update set raw_provider_status=excluded.raw_provider_status,
    normalized_status=excluded.normalized_status,
    pix_copy_paste=coalesce(excluded.pix_copy_paste,public.nexora_provider_payment_details.pix_copy_paste),
    pix_encoded_image=coalesce(excluded.pix_encoded_image,public.nexora_provider_payment_details.pix_encoded_image),
    checkout_url=coalesce(excluded.checkout_url,public.nexora_provider_payment_details.checkout_url),
    expires_at=coalesce(excluded.expires_at,public.nexora_provider_payment_details.expires_at),updated_at=now();
  if p_normalized_status in ('FAILED','CANCELED','EXPIRED') and v_attempt.status not in ('succeeded','failed') then
    update public.nexora_transactions set status='cancelled'
      where id=v_attempt.transaction_id and status in ('pending','processing');
    if found then
      perform public.nexora_webhook_enqueue_payment_terminal(v_attempt.transaction_id,
        case when p_normalized_status='FAILED' then 'payment.failed' else 'payment.canceled' end);
    end if;
    update public.nexora_checkout_links set status='failed',updated_at=now()
      where transaction_id=v_attempt.transaction_id and status='processing';
  end if;
end;
$$;
revoke all on function public.nexora_provider_save_charge_result(uuid,text,text,text,text,text,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.nexora_provider_save_charge_result(uuid,text,text,text,text,text,text,timestamptz)
  to service_role;

-- A provider-confirmed success can become merchant-paid only after the exact
-- gross amount is in the pending ledger and the immutable status event exists.
create or replace function public.nexora_provider_confirm_payment_succeeded(
  p_provider_code text,p_transaction_id uuid,p_provider_transaction_id text,p_provider_event_id text
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_attempt public.nexora_payment_attempts;
  v_tx public.nexora_transactions;
  v_receipt_journal_id uuid;
  v_receipt_journal_count bigint;
  v_receipt_entry_count bigint;
  v_pending_credit numeric;
  v_provider_clearing_debit numeric;
  v_gross_amount_cents bigint;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_provider_code is null or p_provider_code !~ '^[a-z][a-z0-9_-]{1,63}$'
     or p_transaction_id is null or p_provider_transaction_id is null
     or length(trim(p_provider_transaction_id)) not between 1 and 255
     or p_provider_event_id is null or length(trim(p_provider_event_id)) not between 1 and 255 then
    raise exception 'Verified payment identity is required.';
  end if;
  select * into v_attempt from public.nexora_payment_attempts a
    where a.transaction_id=p_transaction_id and a.provider_code=p_provider_code
      and a.environment='production' and a.provider_transaction_id=p_provider_transaction_id
      and a.status='succeeded' for update;
  if not found then raise exception 'Verified production payment attempt not found.'; end if;
  if not exists(select 1 from public.nexora_provider_payment_status_events e
      where e.provider_code=p_provider_code and e.provider_event_id=p_provider_event_id
        and e.provider_operation_id=v_attempt.provider_operation_id and e.transaction_id=p_transaction_id
        and e.provider_transaction_id=p_provider_transaction_id and e.normalized_status='SUCCEEDED') then
    raise exception 'Immutable successful provider event is required.';
  end if;
  select * into v_tx from public.nexora_transactions where id=p_transaction_id for update;
  if not found or v_tx.kind<>'payment' or v_tx.test_mode or v_tx.acquirer_id<>v_attempt.acquirer_id
    or v_tx.status not in ('pending','processing','paid') then
    raise exception 'Transaction does not match verified production payment.';
  end if;
  v_gross_amount_cents := round(v_tx.amount*100)::bigint;
  select count(*) into v_receipt_journal_count from public.nexora_ledger_journals j
    where j.transaction_id=p_transaction_id and j.business_id=v_attempt.business_id
      and j.owner_id=v_attempt.owner_id and j.event_code='payment.received';
  if v_receipt_journal_count<>1 then
    raise exception 'Exactly one payment receipt journal is required.';
  end if;
  select j.id into v_receipt_journal_id from public.nexora_ledger_journals j
    where j.transaction_id=p_transaction_id and j.business_id=v_attempt.business_id
      and j.owner_id=v_attempt.owner_id and j.event_code='payment.received'
      and j.idempotency_key='provider.payment.succeeded:'||p_provider_code||':'||p_transaction_id::text
    for update;
  if not found then raise exception 'Provider receipt journal is missing or mismatched.'; end if;
  select count(*),
    coalesce(sum(le.amount_cents) filter(where la.account_code='merchant_pending' and le.side='credit'),0),
    coalesce(sum(le.amount_cents) filter(where la.account_code='provider_clearing' and le.side='debit'),0)
    into v_receipt_entry_count,v_pending_credit,v_provider_clearing_debit
    from public.nexora_ledger_entries le
    join public.nexora_ledger_accounts la on la.id=le.account_id
    where le.journal_id=v_receipt_journal_id;
  if v_receipt_entry_count<>2 or v_pending_credit<>v_gross_amount_cents
    or v_provider_clearing_debit<>v_gross_amount_cents then
    raise exception 'Receipt journal must contain only the exact pending credit and provider clearing debit.';
  end if;
  update public.nexora_transactions set status='paid',paid_at=coalesce(paid_at,now()),
    provider_reference=p_provider_transaction_id
    where id=p_transaction_id and (provider_reference is null or provider_reference=p_provider_transaction_id);
  if not found then raise exception 'Transaction provider reference mismatch.'; end if;
  update public.nexora_checkout_links set status='paid',paid_at=coalesce(paid_at,now()),updated_at=now()
    where transaction_id=p_transaction_id and status in ('processing','paid');
  if not found then raise exception 'Hosted checkout link not found or cannot transition to paid.'; end if;
  perform public.nexora_webhook_enqueue_payment_succeeded(p_transaction_id);
end;
$$;
revoke all on function public.nexora_provider_confirm_payment_succeeded(text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.nexora_provider_confirm_payment_succeeded(text,uuid,text,text) to service_role;

-- The public payer stays anonymous to Nexora. New checkout links for every
-- provider use provider-neutral attempts; only links already bound to a legacy
-- Asaas operation retain the old recovery path.
create or replace function public.nexora_checkout_public_begin_charge(
  p_token_hash text,p_request_hash text,p_payer_name text,p_payer_email text,p_payer_document text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_link public.nexora_checkout_links;
  v_connection public.nexora_merchant_provider_connections;
  v_result jsonb;
  v_legacy_operation boolean := false;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
    or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
    or length(trim(coalesce(p_payer_name,''))) not between 2 and 160
    or p_payer_document is null or p_payer_document !~ '^([0-9]{11}|[A-Z0-9]{12}[0-9]{2})$'
    or (nullif(trim(coalesce(p_payer_email,'')),'') is not null
      and (length(p_payer_email)>254 or p_payer_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')) then
    raise exception 'Invalid payer data.';
  end if;
  select * into v_link from public.nexora_checkout_links where token_hash=p_token_hash for update;
  if not found then raise exception 'Checkout link not found.'; end if;
  if v_link.status='active' and v_link.expires_at<=now() then
    update public.nexora_checkout_links set status='expired',updated_at=now() where id=v_link.id;
    return jsonb_build_object('status','expired');
  end if;
  if v_link.status not in ('active','processing') then return jsonb_build_object('status',v_link.status); end if;
  select * into v_connection from public.nexora_merchant_provider_connections c
    where c.business_id=v_link.business_id and c.owner_id=v_link.owner_id
      and c.acquirer_id=v_link.acquirer_id and c.status='active'
      and c.updated_at=v_link.connection_version for share;
  if not found then raise exception 'Provider route changed; ask the merchant for a new link.'; end if;

  -- Keep historical Asaas payments resumable without making the generic core
  -- migration depend on an Asaas table or RPC existing in every installation.
  if v_link.provider_code='asaas_production' and v_link.environment='production'
     and v_link.transaction_id is not null
     and to_regclass('public.nexora_asaas_sandbox_operations') is not null then
    execute 'select exists(select 1 from public.nexora_asaas_sandbox_operations
      where transaction_id=$1 and environment=''production'')'
      into v_legacy_operation using v_link.transaction_id;
  end if;

  if v_legacy_operation then
    if to_regprocedure('public.nexora_asaas_begin_charge(uuid,uuid,uuid,text,text,text,text,numeric,text,uuid,text,timestamptz)') is null then
      raise exception 'Legacy Asaas payment requires manual recovery; refusing to create a second charge.';
    end if;
    execute 'select public.nexora_asaas_begin_charge($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)'
      into v_result using
        v_link.owner_id,v_link.business_id,v_link.id,p_request_hash,
        trim(p_payer_name),nullif(lower(trim(coalesce(p_payer_email,''))),''),p_payer_document,
        v_link.amount_cents::numeric/100,v_link.description,v_link.acquirer_id,'production',v_link.connection_version;
  else
    v_result := public.nexora_provider_begin_charge(
      v_link.owner_id,v_link.business_id,v_link.id,p_request_hash,
      trim(p_payer_name),nullif(lower(trim(coalesce(p_payer_email,''))),''),p_payer_document,
      v_link.amount_cents::numeric/100,v_link.description,v_link.acquirer_id,v_link.environment,v_link.connection_version
    );
  end if;
  if nullif(v_result->>'transaction_id','') is not null then
    update public.nexora_checkout_links set
      status=case when v_legacy_operation or nullif(v_result->>'payment_attempted_at','') is not null
        then 'processing' else status end,
      transaction_id=nullif(v_result->>'transaction_id','')::uuid,updated_at=now()
      where id=v_link.id;
  end if;
  return v_result||jsonb_build_object('checkout_link_id',v_link.id,'provider_code',v_link.provider_code);
end;
$$;
revoke all on function public.nexora_checkout_public_begin_charge(text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.nexora_checkout_public_begin_charge(text,text,text,text,text) to service_role;

create or replace function public.nexora_checkout_public_snapshot(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_link public.nexora_checkout_links; v_business_name text; v_status text;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid checkout token.'; end if;
  select l.* into v_link from public.nexora_checkout_links l
    where l.token_hash=p_token_hash;
  if not found then return null; end if;
  select b.name into v_business_name from public.businesses b
    where b.id=v_link.business_id and b.owner_id=v_link.owner_id;
  if not found then return null; end if;
  v_status := case when v_link.status='active' and v_link.expires_at<=now() then 'expired' else v_link.status end;
  if v_status='expired' and v_link.status='active' then
    update public.nexora_checkout_links set status='expired',updated_at=now() where id=v_link.id;
  end if;
  return jsonb_build_object('id',v_link.id,'transaction_id',v_link.transaction_id,
    'merchant_name',v_business_name,'amount_cents',v_link.amount_cents,'description',v_link.description,
    'status',v_status,'expires_at',v_link.expires_at,'provider_code',v_link.provider_code,
    'payment_methods',array['pix']::text[]);
end;
$$;
revoke all on function public.nexora_checkout_public_snapshot(text) from public,anon,authenticated;
grant execute on function public.nexora_checkout_public_snapshot(text) to service_role;

-- Expose the transaction's original provider route so the merchant dashboard
-- refreshes old payments through their own adapter after an acquirer change.
create or replace function public.nexora_workspace_snapshot()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := public.nexora_workspace_read_id();
  v_status text;
  v_can_operate boolean;
  v_settings jsonb;
  v_transactions jsonb := '[]'::jsonb;
  v_customers jsonb := '[]'::jsonb;
  v_provider jsonb;
begin
  select coalesce(m.status,'DRAFT') into v_status from public.merchant_onboarding m where m.user_id=auth.uid();
  v_can_operate := public.is_nexora_super_admin() or v_status='APPROVED';
  select to_jsonb(s) into v_settings from public.user_settings s where s.user_id=auth.uid();
  if v_can_operate then
    select coalesce(jsonb_agg(to_jsonb(t)||jsonb_build_object(
      'provider_adapter',route.provider_code,'provider_code',route.provider_code)
      order by t.created_at desc,t.id),'[]'::jsonb)
      into v_transactions
      from public.nexora_transactions t
      left join lateral (
        select op.provider_code from public.nexora_provider_payment_operations op
        where op.transaction_id=t.id
        order by op.created_at desc,op.id desc limit 1
      ) route on true
      where t.business_id=v_id and t.owner_id=auth.uid();
    select coalesce(jsonb_agg(to_jsonb(c) order by c.last_activity desc,c.id),'[]'::jsonb)
      into v_customers from (
        select c.id,c.name,c.email,
          coalesce(sum(t.amount) filter(where t.kind<>'withdrawal' and t.status='paid' and not t.test_mode),0) as total,
          coalesce(max(coalesce(t.paid_at,t.created_at)) filter(where not t.test_mode),c.created_at) as last_activity
        from public.nexora_customers c left join public.nexora_transactions t
          on t.customer_id=c.id and t.business_id=c.business_id and t.owner_id=c.owner_id
        where c.business_id=v_id and c.owner_id=auth.uid() group by c.id
      ) c;
    select jsonb_build_object('acquirer_id',a.id,'code',a.code,'name',a.name,'environment',a.environment,'status',c.status,
      'api_key_configured',c.api_key_ciphertext is not null,'payments_enabled',coalesce(m.payments_enabled,false))
      into v_provider from public.nexora_merchant_provider_connections c
      join public.nexora_acquirers a on a.id=c.acquirer_id
      left join public.nexora_merchant_controls m on m.business_id=c.business_id and m.owner_id=c.owner_id
      where c.business_id=v_id and c.owner_id=auth.uid() limit 1;
  end if;
  return jsonb_build_object(
    'transactions',v_transactions,'customers',v_customers,'settings',coalesce(v_settings,'{}'::jsonb),
    'business_id',v_id,'business_name',(select b.name from public.businesses b where b.id=v_id),
    'balance',null,
    'sandbox',case when v_can_operate then (select r.sandbox from public.nexora_runtime_config r where r.id=true) else false end,
    'gateway_ready',case when v_can_operate then (select r.gateway_ready from public.nexora_runtime_config r where r.id=true) else false end,
    'provider',coalesce(v_provider,'null'::jsonb),'can_operate',v_can_operate,'onboarding_status',coalesce(v_status,'APPROVED')
  );
end;
$$;
revoke all on function public.nexora_workspace_snapshot() from public,anon;
grant execute on function public.nexora_workspace_snapshot() to authenticated;

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
where n.nspname='public' and c.relname in ('nexora_payment_attempts','nexora_provider_payment_details')
order by c.relname;

select p.oid::regprocedure as function_name,
  has_function_privilege('anon',p.oid,'EXECUTE') as anon_can_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_can_execute,
  has_function_privilege('service_role',p.oid,'EXECUTE') as service_role_can_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in (
  'nexora_provider_begin_charge','nexora_provider_mark_payment_attempt_started',
  'nexora_provider_fail_charge_attempt','nexora_provider_save_charge_result',
  'nexora_workspace_snapshot'
)
order by p.proname;

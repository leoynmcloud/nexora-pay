-- ==============================================================================
-- Nexora Pay - Checkout Público Pix (#10) e API Pública v1 para Clientes (#34)
-- ==============================================================================

begin;

-- ==============================================================================
-- PARTE 1: Tabela e Regras de Links de Checkout Público (Pix IN - Requisito #10)
-- ==============================================================================

create table if not exists public.nexora_checkout_links (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  owner_id uuid not null,
  acquirer_id uuid not null references public.nexora_acquirers(id) on delete restrict,
  provider_code text not null check (provider_code ~ '^[a-z][a-z0-9_-]{1,79}$'),
  environment text not null check (environment='production'),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  amount_cents bigint not null check (amount_cents between 100 and 99999999),
  description text not null check (length(trim(description)) between 2 and 120),
  status text not null default 'active' check (status in ('active','processing','paid','canceled','expired','failed')),
  transaction_id uuid unique,
  connection_version timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz,
  foreign key (business_id,owner_id) references public.businesses(id,owner_id) on delete restrict,
  check ((status='paid')=(paid_at is not null))
);

create index if not exists nexora_checkout_links_owner_created
  on public.nexora_checkout_links(owner_id,created_at desc);
create index if not exists nexora_checkout_links_expiry
  on public.nexora_checkout_links(status,expires_at);

alter table public.nexora_checkout_links enable row level security;
revoke all on public.nexora_checkout_links from public,anon,authenticated,service_role;
grant select on public.nexora_checkout_links to service_role;
grant update(status,transaction_id,updated_at,paid_at) on public.nexora_checkout_links to service_role;

create or replace function public.nexora_checkout_link_guard_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.id is distinct from old.id or new.business_id is distinct from old.business_id
    or new.owner_id is distinct from old.owner_id or new.acquirer_id is distinct from old.acquirer_id
    or new.provider_code is distinct from old.provider_code or new.environment is distinct from old.environment
    or new.token_hash is distinct from old.token_hash or new.amount_cents is distinct from old.amount_cents
    or new.description is distinct from old.description or new.connection_version is distinct from old.connection_version
    or new.expires_at is distinct from old.expires_at or new.created_at is distinct from old.created_at then
    raise exception 'Checkout link identity and amount are immutable.';
  end if;
  if new.status is distinct from old.status and not (
    (old.status='active' and new.status in ('processing','expired','canceled'))
    or (old.status='processing' and new.status in ('paid','failed'))
  ) then
    raise exception 'Invalid checkout link status transition.';
  end if;
  if old.status='paid' and (new.status is distinct from old.status or new.paid_at is distinct from old.paid_at) then
    raise exception 'Paid checkout link is immutable.';
  end if;
  if (new.status='paid') is distinct from (new.paid_at is not null)
    or (new.status='paid' and new.transaction_id is null) then
    raise exception 'Paid checkout link must reference a transaction and payment time.';
  end if;
  return new;
end;
$$;
revoke all on function public.nexora_checkout_link_guard_update() from public,anon,authenticated,service_role;

drop trigger if exists nexora_checkout_link_guard_update on public.nexora_checkout_links;
create trigger nexora_checkout_link_guard_update before update on public.nexora_checkout_links
  for each row execute function public.nexora_checkout_link_guard_update();

-- Rate limit persistente do checkout público
create table if not exists public.nexora_checkout_public_rate_limits (
  token_hash text not null,
  action text not null check (action in ('view','charge')),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  updated_at timestamptz not null default now(),
  primary key (token_hash,action)
);
alter table public.nexora_checkout_public_rate_limits enable row level security;
revoke all on public.nexora_checkout_public_rate_limits from public,anon,authenticated,service_role;

drop function if exists public.nexora_checkout_consume_public_rate_limit(text,text);
create or replace function public.nexora_checkout_consume_public_rate_limit(
  p_token_hash text,p_action text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := clock_timestamp();
  v_window_seconds integer;
  v_max_requests integer;
  v_window_start timestamptz;
  v_count integer;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
     or p_action not in ('view','charge') then
    raise exception 'Invalid checkout rate limit parameters.';
  end if;
  if p_action = 'view' then v_window_seconds := 60; v_max_requests := 30;
  else v_window_seconds := 600; v_max_requests := 5; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_token_hash||':'||p_action,0));
  select window_started_at,request_count into v_window_start,v_count
    from public.nexora_checkout_public_rate_limits where token_hash=p_token_hash and action=p_action;
  if not found or v_window_start <= v_now - make_interval(secs=>v_window_seconds) then
    insert into public.nexora_checkout_public_rate_limits(token_hash,action,window_started_at,request_count,updated_at)
      values(p_token_hash,p_action,v_now,1,v_now)
      on conflict (token_hash,action) do update set window_started_at=v_now,request_count=1,updated_at=v_now;
    return jsonb_build_object('allowed',true,'remaining',v_max_requests-1,'retry_after_seconds',0);
  end if;
  if v_count >= v_max_requests then
    return jsonb_build_object('allowed',false,'remaining',0,
      'retry_after_seconds',greatest(1,ceil(extract(epoch from (v_window_start+make_interval(secs=>v_window_seconds)-v_now))::numeric)::integer));
  end if;
  update public.nexora_checkout_public_rate_limits
    set request_count=request_count+1,updated_at=v_now where token_hash=p_token_hash and action=p_action;
  return jsonb_build_object('allowed',true,'remaining',greatest(v_max_requests-(v_count+1),0),'retry_after_seconds',0);
end;
$$;
revoke all on function public.nexora_checkout_consume_public_rate_limit(text,text) from public,anon,authenticated;
grant execute on function public.nexora_checkout_consume_public_rate_limit(text,text) to service_role;

drop function if exists public.nexora_checkout_create_link(uuid,uuid,bigint,text,text);
create or replace function public.nexora_checkout_create_link(
  p_business_id uuid,p_acquirer_id uuid,p_amount_cents bigint,p_description text,p_token_hash text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_connection public.nexora_merchant_provider_connections;
  v_acquirer public.nexora_acquirers;
  v_link public.nexora_checkout_links;
  v_fee bigint;
begin
  if coalesce(auth.jwt()->>'role','')<>'authenticated' or v_owner is null then
    raise exception 'Authenticated merchant session required.';
  end if;
  if p_business_id is null or p_acquirer_id is null
     or p_amount_cents is null or p_amount_cents not between 100 and 99999999
     or p_description is null or length(trim(p_description)) not between 2 and 120
     or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid checkout link data.';
  end if;
  if not exists(select 1 from public.businesses b where b.id=p_business_id and b.owner_id=v_owner)
     or not exists(select 1 from public.merchant_onboarding k where k.user_id=v_owner and k.status='APPROVED')
     or not public.nexora_account_active(v_owner)
     or not exists(select 1 from public.nexora_merchant_controls c where c.business_id=p_business_id
       and c.owner_id=v_owner and c.payments_enabled) then
    raise exception 'Approved, active merchant with receiving controls is required.';
  end if;

  select * into v_connection from public.nexora_merchant_provider_connections c
    where c.business_id=p_business_id and c.owner_id=v_owner and c.acquirer_id=p_acquirer_id and c.status='active'
    for share;
  if not found then raise exception 'Active provider route not found.'; end if;
  select * into v_acquirer from public.nexora_acquirers a
    where a.id=p_acquirer_id and a.environment='production' and a.status='enabled'
      and 'pix'=any(a.payment_methods);
  if not found then raise exception 'No production Pix checkout adapter is available for this provider.'; end if;

  select r.fixed_fee_cents + round(p_amount_cents::numeric*r.variable_fee_bps/10000)::bigint
    into v_fee from public.nexora_pricing_rules r
    where r.business_id=p_business_id and r.owner_id=v_owner and r.acquirer_id=p_acquirer_id
      and r.payment_method='pix' and r.effective_from<=now()
    order by r.effective_from desc limit 1;
  if not found or v_fee<0 or v_fee>=p_amount_cents then
    raise exception 'A valid Pix pricing rule is required before creating a checkout link.';
  end if;

  insert into public.nexora_checkout_links(
    business_id,owner_id,acquirer_id,provider_code,environment,token_hash,amount_cents,
    description,connection_version,expires_at
  ) values (
    p_business_id,v_owner,p_acquirer_id,v_acquirer.code,'production',p_token_hash,p_amount_cents,
    trim(p_description),v_connection.updated_at,now()+interval '7 days'
  ) returning * into v_link;
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(v_owner,'checkout.link.created',v_link.id::text,jsonb_build_object(
      'business_id',p_business_id,'acquirer_id',p_acquirer_id,'amount_cents',p_amount_cents,
      'environment','production','expires_at',v_link.expires_at
    ));
  return jsonb_build_object('id',v_link.id,'status',v_link.status,'amount_cents',v_link.amount_cents,
    'description',v_link.description,'expires_at',v_link.expires_at,'provider_code',v_link.provider_code);
end;
$$;
revoke all on function public.nexora_checkout_create_link(uuid,uuid,bigint,text,text) from public,anon;
grant execute on function public.nexora_checkout_create_link(uuid,uuid,bigint,text,text) to authenticated;

drop function if exists public.nexora_checkout_public_snapshot(text);
create or replace function public.nexora_checkout_public_snapshot(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_link public.nexora_checkout_links;
  v_business_name text;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid checkout token.'; end if;
  select l.* into v_link from public.nexora_checkout_links l where l.token_hash=p_token_hash;
  if not found then return null; end if;
  select b.name into v_business_name from public.businesses b where b.id=v_link.business_id;
  return jsonb_build_object(
    'id',v_link.id,'status',v_link.status,'amount_cents',v_link.amount_cents,'currency','BRL',
    'description',v_link.description,'business_name',coalesce(v_business_name,'Nexora Merchant'),
    'provider_code',v_link.provider_code,'environment',v_link.environment,
    'expires_at',v_link.expires_at,'created_at',v_link.created_at
  );
end;
$$;
revoke all on function public.nexora_checkout_public_snapshot(text) from public,anon,authenticated;
grant execute on function public.nexora_checkout_public_snapshot(text) to service_role;

-- ==============================================================================
-- PARTE 2: Idempotência e Endpoints da API v1 para Clientes (#34)
-- ==============================================================================

create table if not exists public.nexora_api_idempotency (
  api_key_id uuid not null references public.nexora_merchant_api_keys(id) on delete restrict,
  idempotency_key text not null check (length(idempotency_key) between 8 and 128
    and idempotency_key ~ '^[A-Za-z0-9._:-]+$'),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  payment_link_id uuid references public.nexora_checkout_links(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key(api_key_id,idempotency_key)
);
alter table public.nexora_api_idempotency enable row level security;
revoke all on public.nexora_api_idempotency from public,anon,authenticated,service_role;

drop function if exists public.nexora_api_v1_create_payment_link(uuid,uuid,text,text,text,bigint,text);
create or replace function public.nexora_api_v1_create_payment_link(
  p_api_key_id uuid,p_request_id uuid,p_idempotency_key text,p_request_hash text,p_token_hash text,
  p_amount_cents bigint,p_description text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_key public.nexora_merchant_api_keys;
  v_connection public.nexora_merchant_provider_connections;
  v_acquirer public.nexora_acquirers;
  v_link public.nexora_checkout_links;
  v_existing public.nexora_api_idempotency;
  v_fee bigint;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_api_key_id is null or p_request_id is null or p_idempotency_key is null
     or length(p_idempotency_key) not between 8 and 128 or p_idempotency_key !~ '^[A-Za-z0-9._:-]+$'
     or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
     or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
     or p_amount_cents is null or p_amount_cents not between 100 and 99999999
     or p_description is null or length(trim(p_description)) not between 2 and 120 then
    raise exception 'Invalid payment link request.';
  end if;

  select * into v_key from public.nexora_merchant_api_keys k
    where k.id=p_api_key_id and k.status='active' and (k.expires_at is null or k.expires_at>now());
  if not found then raise exception 'Invalid API key.'; end if;
  if not ('payments:write'=any(v_key.scopes)) then raise exception 'Scope payments:write required.'; end if;

  if not exists(select 1 from public.businesses b where b.id=v_key.business_id and b.owner_id=v_key.owner_id)
     or not exists(select 1 from public.merchant_onboarding k where k.user_id=v_key.owner_id and k.status='APPROVED')
     or not public.nexora_account_active(v_key.owner_id)
     or not exists(select 1 from public.nexora_merchant_controls c where c.business_id=v_key.business_id
       and c.owner_id=v_key.owner_id and c.payments_enabled and c.api_enabled) then
    raise exception 'Merchant receiving or API access disabled.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_key.id::text||':'||p_idempotency_key,0));
  select * into v_existing from public.nexora_api_idempotency
    where api_key_id=v_key.id and idempotency_key=p_idempotency_key;
  if found then
    if v_existing.request_hash <> p_request_hash then raise exception 'Idempotency conflict.'; end if;
    select * into v_link from public.nexora_checkout_links where id=v_existing.payment_link_id;
    return jsonb_build_object('id',v_link.id,'status',v_link.status,'amount_cents',v_link.amount_cents,
      'currency','BRL','description',v_link.description,'environment',v_link.environment,
      'expires_at',v_link.expires_at,'created_at',v_link.created_at,'idempotent_replay',true);
  end if;

  select c.* into v_connection from public.nexora_merchant_provider_connections c
    join public.nexora_acquirers a on a.id=c.acquirer_id
    where c.business_id=v_key.business_id and c.owner_id=v_key.owner_id and c.status='active'
      and a.environment='production' and a.status='enabled' and 'pix'=any(a.payment_methods)
    order by c.updated_at desc limit 1 for share;
  if not found then raise exception 'No active Pix provider route configured.'; end if;

  select * into v_acquirer from public.nexora_acquirers where id=v_connection.acquirer_id;

  select r.fixed_fee_cents + round(p_amount_cents::numeric*r.variable_fee_bps/10000)::bigint
    into v_fee from public.nexora_pricing_rules r
    where r.business_id=v_key.business_id and r.owner_id=v_key.owner_id and r.acquirer_id=v_connection.acquirer_id
      and r.payment_method='pix' and r.effective_from<=now()
    order by r.effective_from desc limit 1;
  if not found or v_fee<0 or v_fee>=p_amount_cents then
    raise exception 'Valid pricing rule required.';
  end if;

  insert into public.nexora_checkout_links(
    business_id,owner_id,acquirer_id,provider_code,environment,token_hash,amount_cents,
    description,connection_version,expires_at
  ) values (
    v_key.business_id,v_key.owner_id,v_connection.acquirer_id,v_acquirer.code,'production',
    p_token_hash,p_amount_cents,trim(p_description),v_connection.updated_at,now()+interval '7 days'
  ) returning * into v_link;

  insert into public.nexora_api_idempotency(api_key_id,idempotency_key,request_hash,payment_link_id)
    values(v_key.id,p_idempotency_key,p_request_hash,v_link.id);

  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(v_key.owner_id,'api.v1.payment_link.created',v_link.id::text,jsonb_build_object(
      'business_id',v_key.business_id,'amount_cents',p_amount_cents,'api_key_id',v_key.id,
      'idempotency_key',p_idempotency_key,'request_id',p_request_id
    ));

  return jsonb_build_object('id',v_link.id,'status',v_link.status,'amount_cents',v_link.amount_cents,
    'currency','BRL','description',v_link.description,'environment',v_link.environment,
    'expires_at',v_link.expires_at,'created_at',v_link.created_at,'idempotent_replay',false);
end;
$$;
revoke all on function public.nexora_api_v1_create_payment_link(uuid,uuid,text,text,text,bigint,text) from public,anon,authenticated;
grant execute on function public.nexora_api_v1_create_payment_link(uuid,uuid,text,text,text,bigint,text) to service_role;

drop function if exists public.nexora_api_v1_get_payment_link(uuid,uuid);
create or replace function public.nexora_api_v1_get_payment_link(p_api_key_id uuid,p_link_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_key public.nexora_merchant_api_keys; v_link public.nexora_checkout_links;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  select * into v_key from public.nexora_merchant_api_keys k
    where k.id=p_api_key_id and k.status='active' and (k.expires_at is null or k.expires_at>now());
  if not found then raise exception 'Invalid API key.'; end if;
  if not ('payments:read'=any(v_key.scopes)) then raise exception 'Scope payments:read required.'; end if;

  select * into v_link from public.nexora_checkout_links l
    where l.id=p_link_id and l.business_id=v_key.business_id and l.owner_id=v_key.owner_id;
  if not found then return null; end if;

  return jsonb_build_object('id',v_link.id,'status',v_link.status,'amount_cents',v_link.amount_cents,
    'currency','BRL','description',v_link.description,'environment',v_link.environment,
    'expires_at',v_link.expires_at,'created_at',v_link.created_at,'paid_at',v_link.paid_at);
end;
$$;
revoke all on function public.nexora_api_v1_get_payment_link(uuid,uuid) from public,anon,authenticated;
grant execute on function public.nexora_api_v1_get_payment_link(uuid,uuid) to service_role;

notify pgrst,'reload schema';
commit;

-- Consulta de confirmação:
select 'checkout_links_table_rls' as check_item, relrowsecurity::text as result
from pg_class where relname = 'nexora_checkout_links'
union all
select 'api_idempotency_table_rls', relrowsecurity::text
from pg_class where relname = 'nexora_api_idempotency'
union all
select 'checkout_create_link_rpc', count(*)::text
from pg_proc where proname = 'nexora_checkout_create_link'
union all
select 'api_v1_create_link_rpc', count(*)::text
from pg_proc where proname = 'nexora_api_v1_create_payment_link'
union all
select 'ledger_merchant_balances_rpc', count(*)::text
from pg_proc where proname = 'nexora_ledger_merchant_balances';

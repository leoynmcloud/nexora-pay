-- Hosted Nexora checkout links for payers without a Nexora login or a
-- pre-existing merchant customer record. The link stores no payer PII.
-- Run provider-neutral payment attempts after this migration before production use.
begin;

do $$ begin
  if to_regclass('public.nexora_transactions') is null
     or to_regclass('public.nexora_acquirers') is null
     or to_regclass('public.nexora_merchant_provider_connections') is null
     or to_regclass('public.nexora_platform_provider_credentials') is null
     or to_regclass('public.nexora_pricing_rules') is null then
    raise exception 'Apply production payments, central credentials and pricing migrations first.';
  end if;
end $$;

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
  foreign key (transaction_id,business_id,owner_id)
    references public.nexora_transactions(id,business_id,owner_id) on delete restrict,
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
  if not exists(select 1 from public.nexora_platform_provider_credentials c
      where c.acquirer_id=p_acquirer_id and c.environment='production' and c.status='active') then
    raise exception 'Platform provider credential is not configured.';
  end if;

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

create or replace function public.nexora_checkout_public_snapshot(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_link public.nexora_checkout_links;
  v_business_name text;
  v_status text;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid checkout token.'; end if;
  select l.* into v_link
    from public.nexora_checkout_links l
    where l.token_hash=p_token_hash;
  if not found then return null; end if;
  select b.name into v_business_name
    from public.businesses b
    where b.id=v_link.business_id and b.owner_id=v_link.owner_id;
  if not found then return null; end if;
  v_status := case when v_link.status='active' and v_link.expires_at<=now() then 'expired' else v_link.status end;
  if v_status='expired' and v_link.status='active' then
    update public.nexora_checkout_links set status='expired',updated_at=now() where id=v_link.id;
  end if;
  return jsonb_build_object('id',v_link.id,'transaction_id',v_link.transaction_id,
    'merchant_name',v_business_name,'amount_cents',v_link.amount_cents,
    'description',v_link.description,'status',v_status,'expires_at',v_link.expires_at,
    'provider_code',v_link.provider_code,
    'payment_methods',array['pix']::text[]);
end;
$$;
revoke all on function public.nexora_checkout_public_snapshot(text) from public,anon,authenticated;
grant execute on function public.nexora_checkout_public_snapshot(text) to service_role;

-- Durable anonymous checkout throttling, scoped to an existing link. A row per
-- link/action bounds storage and avoids trusting caller-supplied IP headers.
create table if not exists public.nexora_checkout_public_rate_limits (
  checkout_link_id uuid not null references public.nexora_checkout_links(id) on delete cascade,
  action text not null check (action in ('view','pay')),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  primary key (checkout_link_id,action)
);
alter table public.nexora_checkout_public_rate_limits enable row level security;
revoke all on public.nexora_checkout_public_rate_limits from public,anon,authenticated,service_role;

create or replace function public.nexora_checkout_consume_public_rate_limit(
  p_token_hash text,p_action text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_link_id uuid;
  v_now timestamptz := clock_timestamp();
  v_window_seconds integer;
  v_max_requests integer;
  v_window_start timestamptz;
  v_count integer;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
    or p_action is null or p_action not in ('view','pay') then raise exception 'Invalid checkout rate limit request.'; end if;

  select id into v_link_id from public.nexora_checkout_links
    where token_hash=p_token_hash and expires_at>v_now;
  if not found then return jsonb_build_object('allowed',false,'retry_after_seconds',0); end if;

  if p_action='view' then
    v_window_seconds := 60;
    v_max_requests := 30;
  else
    v_window_seconds := 600;
    v_max_requests := 5;
  end if;
  v_window_start := to_timestamp(floor(extract(epoch from v_now)/v_window_seconds)*v_window_seconds);

  insert into public.nexora_checkout_public_rate_limits(
    checkout_link_id,action,window_started_at,request_count
  ) values (v_link_id,p_action,v_window_start,1)
  on conflict (checkout_link_id,action) do update set
    request_count=case
      when public.nexora_checkout_public_rate_limits.window_started_at=v_window_start
        then least(public.nexora_checkout_public_rate_limits.request_count,v_max_requests)+1
      else 1 end,
    window_started_at=v_window_start
  where public.nexora_checkout_public_rate_limits.window_started_at is distinct from v_window_start
    or public.nexora_checkout_public_rate_limits.request_count<=v_max_requests
  returning request_count into v_count;
  if v_count is null then
    select request_count into v_count from public.nexora_checkout_public_rate_limits
      where checkout_link_id=v_link_id and action=p_action;
  end if;

  return jsonb_build_object(
    'allowed',v_count<=v_max_requests,
    'retry_after_seconds',case when v_count<=v_max_requests then 0 else greatest(1,ceil(extract(epoch from (v_window_start+make_interval(secs=>v_window_seconds)-v_now))::numeric)::integer) end
  );
end;
$$;
revoke all on function public.nexora_checkout_consume_public_rate_limit(text,text) from public,anon,authenticated;
grant execute on function public.nexora_checkout_consume_public_rate_limit(text,text) to service_role;

create or replace function public.nexora_checkout_public_begin_charge(
  p_token_hash text,p_request_hash text,p_payer_name text,p_payer_email text,p_payer_document text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_link public.nexora_checkout_links;
  v_connection public.nexora_merchant_provider_connections;
  v_result jsonb;
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
  if v_link.status not in ('active','processing') then
    return jsonb_build_object('status',v_link.status);
  end if;
  select * into v_connection from public.nexora_merchant_provider_connections c
    where c.business_id=v_link.business_id and c.owner_id=v_link.owner_id
      and c.acquirer_id=v_link.acquirer_id and c.status='active'
      and c.updated_at=v_link.connection_version for share;
  if not found then raise exception 'Provider route changed; ask the merchant for a new link.'; end if;

  if v_link.environment<>'production' then raise exception 'Only production checkout links are supported.'; end if;
  if to_regprocedure('public.nexora_provider_begin_charge(uuid,uuid,uuid,text,text,text,text,numeric,text,uuid,text,timestamptz)') is not null then
    execute 'select public.nexora_provider_begin_charge($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)'
      into v_result using v_link.owner_id,v_link.business_id,v_link.id,p_request_hash,
        trim(p_payer_name),nullif(lower(trim(coalesce(p_payer_email,''))),''),p_payer_document,
        v_link.amount_cents::numeric/100,v_link.description,v_link.acquirer_id,'production',v_link.connection_version;
  elsif v_link.provider_code='asaas_production'
    and to_regprocedure('public.nexora_asaas_begin_charge(uuid,uuid,uuid,text,text,text,text,numeric,text,uuid,text,timestamptz)') is not null then
    execute 'select public.nexora_asaas_begin_charge($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)'
      into v_result using v_link.owner_id,v_link.business_id,v_link.id,p_request_hash,
        trim(p_payer_name),nullif(lower(trim(coalesce(p_payer_email,''))),''),p_payer_document,
        v_link.amount_cents::numeric/100,v_link.description,v_link.acquirer_id,'production',v_link.connection_version;
  else
    raise exception 'Apply the provider-neutral payment attempt migration before creating a live checkout.';
  end if;
  update public.nexora_checkout_links set status='processing',
    transaction_id=nullif(v_result->>'transaction_id','')::uuid,updated_at=now()
    where id=v_link.id;
  return v_result || jsonb_build_object('checkout_link_id',v_link.id,'provider_code',v_link.provider_code);
end;
$$;
revoke all on function public.nexora_checkout_public_begin_charge(text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.nexora_checkout_public_begin_charge(text,text,text,text,text) to service_role;

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
  has_table_privilege('service_role',c.oid,'DELETE') as service_role_can_delete,
  array(select a.attname from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
    and has_column_privilege('service_role',c.oid,a.attname,'UPDATE') order by a.attnum) as service_role_update_columns
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname='nexora_checkout_links';

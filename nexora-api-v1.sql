-- Merchant API v1 foundation: idempotent hosted payment links and scoped reads.
-- Requires the provider credential, approved merchant, pricing, checkout-link,
-- and merchant API-key migrations. Does not enable payouts or settlement.
begin;

do $$ begin
  if to_regclass('public.nexora_merchant_api_keys') is null
     or to_regclass('public.nexora_checkout_links') is null
     or to_regclass('public.nexora_merchant_controls') is null
     or to_regclass('public.merchant_onboarding') is null
     or to_regclass('public.businesses') is null
     or to_regclass('public.nexora_acquirers') is null
     or to_regclass('public.nexora_merchant_provider_connections') is null
     or to_regclass('public.nexora_platform_provider_credentials') is null
     or to_regclass('public.nexora_pricing_rules') is null
     or to_regclass('public.nexora_audit_log') is null
     or to_regprocedure('public.nexora_account_active(uuid)') is null
     or to_regprocedure('public.nexora_merchant_api_key_authenticate(text,text)') is null
     or to_regprocedure('public.nexora_merchant_api_rate_limit(uuid,integer)') is null then
    raise exception 'Apply checkout and merchant API key migrations before API v1.';
  end if;
end $$;

create table if not exists public.nexora_api_idempotency (
  api_key_id uuid not null references public.nexora_merchant_api_keys(id) on delete restrict,
  idempotency_key text not null check (length(idempotency_key) between 16 and 128
    and idempotency_key ~ '^[A-Za-z0-9._:-]+$'),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  payment_link_id uuid references public.nexora_checkout_links(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key(api_key_id,idempotency_key)
);
alter table public.nexora_api_idempotency enable row level security;
revoke all on public.nexora_api_idempotency from public,anon,authenticated,service_role;

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
  v_routes integer;
  v_fee bigint;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_api_key_id is null or p_request_id is null or p_idempotency_key is null
     or length(p_idempotency_key) not between 16 and 128 or p_idempotency_key !~ '^[A-Za-z0-9._:-]+$'
     or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
     or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
     or p_amount_cents is null or p_amount_cents not between 100 and 99999999
     or p_description is null or length(trim(p_description)) not between 2 and 120 then
    raise exception 'Invalid payment link request.';
  end if;

  select * into v_key from public.nexora_merchant_api_keys k
    where k.id=p_api_key_id and k.status='active' and k.environment='production'
      and 'payments:write'=any(k.scopes) and (k.expires_at is null or k.expires_at>now())
      and exists(select 1 from public.nexora_merchant_controls c
        where c.business_id=k.business_id and c.owner_id=k.owner_id and c.api_enabled)
    for share;
  if not found then raise exception 'API key is not authorized for payment creation.'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_api_key_id::text||':'||p_idempotency_key,0));
  select * into v_existing from public.nexora_api_idempotency i
    where i.api_key_id=p_api_key_id and i.idempotency_key=p_idempotency_key for update;
  if found then
    if v_existing.request_hash<>p_request_hash then raise exception 'Idempotency key reused with a different request.'; end if;
    select * into v_link from public.nexora_checkout_links l where l.id=v_existing.payment_link_id;
    if not found then raise exception 'Idempotent resource is unavailable.'; end if;
    return jsonb_build_object('id',v_link.id,'status',v_link.status,'amount_cents',v_link.amount_cents,
      'currency','BRL','description',v_link.description,'expires_at',v_link.expires_at,'provider_code',v_link.provider_code,
      'created_at',v_link.created_at,'idempotent_replay',true);
  end if;

  if not exists(select 1 from public.merchant_onboarding k where k.user_id=v_key.owner_id and k.status='APPROVED')
     or not public.nexora_account_active(v_key.owner_id)
     or not exists(select 1 from public.nexora_merchant_controls c where c.business_id=v_key.business_id
       and c.owner_id=v_key.owner_id and c.payments_enabled) then
    raise exception 'Approved active merchant with receiving access is required.';
  end if;

  select count(*) into v_routes from public.nexora_merchant_provider_connections c
    where c.business_id=v_key.business_id and c.owner_id=v_key.owner_id and c.status='active';
  if v_routes<>1 then raise exception 'Exactly one active provider route is required.'; end if;
  select * into v_connection from public.nexora_merchant_provider_connections c
    where c.business_id=v_key.business_id and c.owner_id=v_key.owner_id and c.status='active' for share;
  select * into v_acquirer from public.nexora_acquirers a
    where a.id=v_connection.acquirer_id and a.environment='production'
      and a.status='enabled' and 'pix'=any(a.payment_methods);
  if not found then raise exception 'The assigned provider does not yet have an active API v1 adapter.'; end if;
  if not exists(select 1 from public.nexora_platform_provider_credentials c
      where c.acquirer_id=v_acquirer.id and c.environment='production' and c.status='active') then
    raise exception 'Provider credentials are not configured.';
  end if;

  select r.fixed_fee_cents+round(p_amount_cents::numeric*r.variable_fee_bps/10000)::bigint
    into v_fee from public.nexora_pricing_rules r
    where r.business_id=v_key.business_id and r.owner_id=v_key.owner_id and r.acquirer_id=v_acquirer.id
      and r.payment_method='pix' and r.effective_from<=now()
    order by r.effective_from desc limit 1;
  if not found or v_fee<0 or v_fee>=p_amount_cents then raise exception 'A valid Pix pricing rule is required.'; end if;

  insert into public.nexora_checkout_links(
    business_id,owner_id,acquirer_id,provider_code,environment,token_hash,amount_cents,description,connection_version,expires_at
  ) values (
    v_key.business_id,v_key.owner_id,v_acquirer.id,v_acquirer.code,'production',p_token_hash,p_amount_cents,
    trim(p_description),v_connection.updated_at,now()+interval '7 days'
  ) returning * into v_link;
  insert into public.nexora_api_idempotency(api_key_id,idempotency_key,request_hash,payment_link_id)
    values(p_api_key_id,p_idempotency_key,p_request_hash,v_link.id);
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(v_key.owner_id,'api.payment_link.created',v_link.id::text,jsonb_build_object(
      'api_key_id',p_api_key_id,'business_id',v_key.business_id,'acquirer_id',v_acquirer.id,
      'amount_cents',p_amount_cents,'provider_code',v_acquirer.code,'request_id',p_request_id
    ));
  return jsonb_build_object('id',v_link.id,'status',v_link.status,'amount_cents',v_link.amount_cents,
    'currency','BRL','description',v_link.description,'expires_at',v_link.expires_at,'provider_code',v_link.provider_code,
    'created_at',v_link.created_at,'idempotent_replay',false);
end;
$$;

create or replace function public.nexora_api_v1_list_payment_links(
  p_api_key_id uuid,p_limit integer default 25,p_cursor_created_at timestamptz default null,p_cursor_id uuid default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_key public.nexora_merchant_api_keys; v_rows jsonb; v_count integer; v_has_more boolean; v_next jsonb;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_api_key_id is null or p_limit is null or p_limit not between 1 and 100
     or ((p_cursor_created_at is null)<>(p_cursor_id is null)) then raise exception 'Invalid pagination request.'; end if;
  select * into v_key from public.nexora_merchant_api_keys k
    where k.id=p_api_key_id and k.status='active' and k.environment='production'
      and 'payments:read'=any(k.scopes) and (k.expires_at is null or k.expires_at>now())
      and public.nexora_account_active(k.owner_id)
      and exists(select 1 from public.merchant_onboarding m where m.user_id=k.owner_id and m.status='APPROVED')
      and exists(select 1 from public.nexora_merchant_controls c
        where c.business_id=k.business_id and c.owner_id=k.owner_id and c.api_enabled);
  if not found then raise exception 'API key is not authorized to read payment links.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id',q.id,'status',q.status,'amount_cents',q.amount_cents,'currency','BRL','description',q.description,
      'provider_code',q.provider_code,'expires_at',q.expires_at,'created_at',q.created_at,'paid_at',q.paid_at
    ) order by q.created_at desc,q.id desc),'[]'::jsonb),count(*)
    into v_rows,v_count
    from (select l.id,l.status,l.amount_cents,l.description,l.provider_code,l.expires_at,l.created_at,l.paid_at
      from public.nexora_checkout_links l
      where l.business_id=v_key.business_id and l.owner_id=v_key.owner_id
        and (p_cursor_created_at is null or (l.created_at,l.id)<(p_cursor_created_at,p_cursor_id))
      order by l.created_at desc,l.id desc limit p_limit+1) q;
  v_has_more:=v_count>p_limit;
  if v_has_more then
    v_rows:=(select coalesce(jsonb_agg(value order by ordinality),'[]'::jsonb)
      from jsonb_array_elements(v_rows) with ordinality where ordinality<=p_limit);
    v_next:=v_rows->(p_limit-1);
    v_next:=jsonb_build_object('created_at',v_next->>'created_at','id',v_next->>'id');
  end if;
  return jsonb_build_object('data',v_rows,'has_more',v_has_more,'next_cursor',v_next);
end;
$$;

create or replace function public.nexora_api_v1_get_payment_link(p_api_key_id uuid,p_link_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_key public.nexora_merchant_api_keys; v_link public.nexora_checkout_links;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_api_key_id is null or p_link_id is null then raise exception 'Invalid payment link request.'; end if;
  select * into v_key from public.nexora_merchant_api_keys k
    where k.id=p_api_key_id and k.status='active' and k.environment='production'
      and 'payments:read'=any(k.scopes) and (k.expires_at is null or k.expires_at>now())
      and public.nexora_account_active(k.owner_id)
      and exists(select 1 from public.merchant_onboarding m where m.user_id=k.owner_id and m.status='APPROVED')
      and exists(select 1 from public.nexora_merchant_controls c
        where c.business_id=k.business_id and c.owner_id=k.owner_id and c.api_enabled);
  if not found then raise exception 'API key is not authorized to read payment links.'; end if;
  select * into v_link from public.nexora_checkout_links l
    where l.id=p_link_id and l.business_id=v_key.business_id and l.owner_id=v_key.owner_id;
  if not found then return null; end if;
  return jsonb_build_object('id',v_link.id,'status',v_link.status,'amount_cents',v_link.amount_cents,
    'currency','BRL','description',v_link.description,'provider_code',v_link.provider_code,
    'expires_at',v_link.expires_at,'created_at',v_link.created_at,'paid_at',v_link.paid_at);
end;
$$;

revoke all on function public.nexora_api_v1_create_payment_link(uuid,uuid,text,text,text,bigint,text) from public,anon,authenticated;
revoke all on function public.nexora_api_v1_list_payment_links(uuid,integer,timestamptz,uuid) from public,anon,authenticated;
revoke all on function public.nexora_api_v1_get_payment_link(uuid,uuid) from public,anon,authenticated;
grant execute on function public.nexora_api_v1_create_payment_link(uuid,uuid,text,text,text,bigint,text) to service_role;
grant execute on function public.nexora_api_v1_list_payment_links(uuid,integer,timestamptz,uuid) to service_role;
grant execute on function public.nexora_api_v1_get_payment_link(uuid,uuid) to service_role;

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
where n.nspname='public' and c.relname='nexora_api_idempotency';

select p.proname as function_name,
  has_function_privilege('anon',p.oid,'EXECUTE') as anon_can_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_can_execute,
  has_function_privilege('service_role',p.oid,'EXECUTE') as service_role_can_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname like 'nexora_api_v1_%' order by p.proname;

-- Fix API v1 service role authentication check and rate limit return type across all API RPCs
begin;

-- 1. nexora_merchant_api_key_authenticate
create or replace function public.nexora_merchant_api_key_authenticate(p_key_prefix text, p_key_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.nexora_merchant_api_keys;
begin
  if current_user not in ('service_role', 'postgres', 'supabase_admin')
     and coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'Backend service role required.';
  end if;
  if p_key_prefix is null or p_key_prefix !~ '^nx_(live|test)_[A-Za-z0-9_-]{8,16}$'
    or p_key_hash is null or p_key_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid API key credentials.';
  end if;
  select * into v_row from public.nexora_merchant_api_keys
    where key_prefix=p_key_prefix and key_hash=p_key_hash and status='active'
      and (expires_at is null or expires_at>now());
  if not found then return null; end if;
  update public.nexora_merchant_api_keys set last_used_at=now() where id=v_row.id;
  return jsonb_build_object('id',v_row.id,'business_id',v_row.business_id,'owner_id',v_row.owner_id,
    'environment',v_row.environment,'scopes',v_row.scopes,'key_prefix',v_row.key_prefix);
end;
$$;
revoke all on function public.nexora_merchant_api_key_authenticate(text, text) from public, anon, authenticated;
grant execute on function public.nexora_merchant_api_key_authenticate(text, text) to service_role;

-- 2. nexora_merchant_api_rate_limit (drop first to change return type from table to jsonb)
drop function if exists public.nexora_merchant_api_rate_limit(uuid, integer);
create or replace function public.nexora_merchant_api_rate_limit(p_api_key_id uuid, p_limit integer default 60)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_count integer; v_started timestamptz; v_now timestamptz:=clock_timestamp();
begin
  if current_user not in ('service_role', 'postgres', 'supabase_admin')
     and coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'Backend service role required.';
  end if;
  if p_api_key_id is null or p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'Invalid rate limit request.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_api_key_id::text, 0));
  select request_count, window_started_at into v_count, v_started
    from public.nexora_merchant_api_rate_limits where api_key_id=p_api_key_id;
  if not found or v_started <= v_now - interval '60 seconds' then
    insert into public.nexora_merchant_api_rate_limits(api_key_id, window_started_at, request_count, updated_at)
      values(p_api_key_id, v_now, 1, v_now)
      on conflict (api_key_id) do update set window_started_at=v_now, request_count=1, updated_at=v_now;
    return jsonb_build_object('allowed', true, 'limit', p_limit, 'remaining', greatest(0, p_limit - 1), 'retry_after_seconds', 0);
  end if;
  if v_count >= p_limit then
    return jsonb_build_object('allowed', false, 'limit', p_limit, 'remaining', 0,
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_started + interval '60 seconds' - v_now)))::integer));
  end if;
  update public.nexora_merchant_api_rate_limits set request_count=request_count+1, updated_at=v_now where api_key_id=p_api_key_id;
  return jsonb_build_object('allowed', true, 'limit', p_limit, 'remaining', greatest(0, p_limit - (v_count + 1)), 'retry_after_seconds', 0);
end;
$$;
revoke all on function public.nexora_merchant_api_rate_limit(uuid, integer) from public, anon, authenticated;
grant execute on function public.nexora_merchant_api_rate_limit(uuid, integer) to service_role;

-- 3. nexora_api_v1_create_payment_link
create or replace function public.nexora_api_v1_create_payment_link(
  p_api_key_id uuid, p_request_id uuid, p_idempotency_key text, p_request_hash text, p_token_hash text,
  p_amount_cents bigint, p_description text
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
  if current_user not in ('service_role', 'postgres', 'supabase_admin')
     and coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'Backend service role required.';
  end if;
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

-- 4. nexora_api_v1_get_payment_link
create or replace function public.nexora_api_v1_get_payment_link(p_api_key_id uuid, p_link_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_key public.nexora_merchant_api_keys; v_link public.nexora_checkout_links;
begin
  if current_user not in ('service_role', 'postgres', 'supabase_admin')
     and coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'Backend service role required.';
  end if;
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

-- 5. nexora_api_v1_list_payment_links
create or replace function public.nexora_api_v1_list_payment_links(
  p_api_key_id uuid, p_limit integer default 25, p_cursor_created_at timestamptz default null, p_cursor_id uuid default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_key public.nexora_merchant_api_keys;
  v_rows jsonb;
  v_count integer;
  v_has_more boolean;
  v_next jsonb:=null;
begin
  if current_user not in ('service_role', 'postgres', 'supabase_admin')
     and coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'Backend service role required.';
  end if;
  if p_api_key_id is null or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'Invalid payment link query.';
  end if;
  select * into v_key from public.nexora_merchant_api_keys k
    where k.id=p_api_key_id and k.status='active' and (k.expires_at is null or k.expires_at>now());
  if not found then raise exception 'Invalid API key.'; end if;
  if not ('payments:read'=any(v_key.scopes)) then raise exception 'Scope payments:read required.'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id',q.id,'status',q.status,'amount_cents',q.amount_cents,'currency','BRL','description',q.description,
      'provider_code',q.provider_code,'expires_at',q.expires_at,'created_at',q.created_at,'paid_at',q.paid_at
    ) order by q.created_at desc,q.id desc),'[]'::jsonb), count(*)
    into v_rows, v_count
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
revoke all on function public.nexora_api_v1_list_payment_links(uuid,integer,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.nexora_api_v1_list_payment_links(uuid,integer,timestamptz,uuid) to service_role;

notify pgrst,'reload schema';
commit;

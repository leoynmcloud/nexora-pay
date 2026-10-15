-- Migration: nexora-reusable-checkout-orders.sql
-- Enables scalable, reusable checkout links with independent per-buyer child orders.
-- When a merchant creates a checkout link, it acts as a master reusable link.
-- Each buyer payment attempt spawns an isolated child order with its own transaction and order_token,
-- leaving the master checkout link active for unlimited concurrent buyers.
begin;

do $$ begin
  if to_regclass('public.nexora_checkout_links') is null
     or to_regclass('public.nexora_payment_attempts') is null
     or to_regclass('public.nexora_transactions') is null then
    raise exception 'Apply hosted checkout and provider attempts migrations first.';
  end if;
end $$;

-- 1. Add parent_link_id to nexora_checkout_links
alter table public.nexora_checkout_links
  add column if not exists parent_link_id uuid references public.nexora_checkout_links(id) on delete cascade;

create index if not exists nexora_checkout_links_parent_id_idx
  on public.nexora_checkout_links(parent_link_id)
  where parent_link_id is not null;

-- Grant permissions for service_role to insert child orders
grant insert on public.nexora_checkout_links to service_role;
grant select, update on public.nexora_checkout_links to service_role;

-- 2. Update guard trigger to recognize parent_link_id as immutable
create or replace function public.nexora_checkout_link_guard_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.id is distinct from old.id or new.business_id is distinct from old.business_id
    or new.owner_id is distinct from old.owner_id or new.acquirer_id is distinct from old.acquirer_id
    or new.provider_code is distinct from old.provider_code or new.environment is distinct from old.environment
    or new.token_hash is distinct from old.token_hash or new.amount_cents is distinct from old.amount_cents
    or new.description is distinct from old.description or new.connection_version is distinct from old.connection_version
    or new.expires_at is distinct from old.expires_at or new.created_at is distinct from old.created_at
    or new.parent_link_id is distinct from old.parent_link_id then
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

-- 3. Dedicated RPC to spawn an isolated child order from an active master link
create or replace function public.nexora_checkout_spawn_order(
  p_parent_token_hash text,
  p_order_token_hash text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_parent public.nexora_checkout_links;
  v_child public.nexora_checkout_links;
  v_business_name text;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_parent_token_hash is null or p_parent_token_hash !~ '^[a-f0-9]{64}$'
    or p_order_token_hash is null or p_order_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid checkout token digests.';
  end if;

  select * into v_parent from public.nexora_checkout_links
    where token_hash=p_parent_token_hash and parent_link_id is null;
  if not found then raise exception 'Master checkout link not found.'; end if;
  if v_parent.status<>'active' or v_parent.expires_at<=now() then
    raise exception 'Master checkout link is not available.';
  end if;

  insert into public.nexora_checkout_links(
    business_id, owner_id, acquirer_id, provider_code, environment,
    token_hash, amount_cents, description, connection_version,
    expires_at, parent_link_id, status
  ) values (
    v_parent.business_id, v_parent.owner_id, v_parent.acquirer_id, v_parent.provider_code, v_parent.environment,
    p_order_token_hash, v_parent.amount_cents, v_parent.description, v_parent.connection_version,
    least(v_parent.expires_at, now() + interval '24 hours'), v_parent.id, 'active'
  ) returning * into v_child;

  select b.name into v_business_name
    from public.businesses b
    where b.id=v_child.business_id and b.owner_id=v_child.owner_id;

  return jsonb_build_object(
    'id', v_child.id,
    'parent_link_id', v_parent.id,
    'amount_cents', v_child.amount_cents,
    'description', v_child.description,
    'status', v_child.status,
    'expires_at', v_child.expires_at,
    'provider_code', v_child.provider_code,
    'merchant_name', v_business_name
  );
end;
$$;
revoke all on function public.nexora_checkout_spawn_order(text,text) from public,anon,authenticated;
grant execute on function public.nexora_checkout_spawn_order(text,text) to service_role;

-- 4. High-capacity rate limiting for master links, standard rate limiting for orders
create or replace function public.nexora_checkout_consume_public_rate_limit(
  p_token_hash text,p_action text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_link public.nexora_checkout_links;
  v_now timestamptz := clock_timestamp();
  v_window_seconds integer;
  v_max_requests integer;
  v_window_start timestamptz;
  v_count integer;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
    or p_action is null or p_action not in ('view','pay') then raise exception 'Invalid checkout rate limit request.'; end if;

  select * into v_link from public.nexora_checkout_links
    where token_hash=p_token_hash and expires_at>v_now;
  if not found then return jsonb_build_object('allowed',false,'retry_after_seconds',0); end if;

  if v_link.parent_link_id is null then
    -- Master link: high capacity for multiple concurrent buyers
    if p_action='view' then
      v_window_seconds := 60;
      v_max_requests := 300;
    else
      v_window_seconds := 600;
      v_max_requests := 120;
    end if;
  else
    -- Child order: strict bounds for single buyer attempt
    if p_action='view' then
      v_window_seconds := 60;
      v_max_requests := 30;
    else
      v_window_seconds := 600;
      v_max_requests := 5;
    end if;
  end if;

  v_window_start := to_timestamp(floor(extract(epoch from v_now)/v_window_seconds)*v_window_seconds);

  insert into public.nexora_checkout_public_rate_limits(
    checkout_link_id,action,window_started_at,request_count
  ) values (v_link.id,p_action,v_window_start,1)
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
      where checkout_link_id=v_link.id and action=p_action;
  end if;

  return jsonb_build_object(
    'allowed',v_count<=v_max_requests,
    'retry_after_seconds',case when v_count<=v_max_requests then 0 else greatest(1,ceil(extract(epoch from (v_window_start+make_interval(secs=>v_window_seconds)-v_now))::numeric)::integer) end
  );
end;
$$;
revoke all on function public.nexora_checkout_consume_public_rate_limit(text,text) from public,anon,authenticated;
grant execute on function public.nexora_checkout_consume_public_rate_limit(text,text) to service_role;

-- 5. Updated public snapshot returning parent_link_id and is_reusable
create or replace function public.nexora_checkout_public_snapshot(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_link public.nexora_checkout_links;
  v_business_name text;
  v_status text;
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
  return jsonb_build_object(
    'id',v_link.id,
    'parent_link_id',v_link.parent_link_id,
    'is_reusable',(v_link.parent_link_id is null and v_link.transaction_id is null),
    'transaction_id',v_link.transaction_id,
    'merchant_name',v_business_name,
    'amount_cents',v_link.amount_cents,
    'description',v_link.description,
    'status',v_status,
    'expires_at',v_link.expires_at,
    'provider_code',v_link.provider_code,
    'payment_methods',case when v_link.provider_code ~ '^mercadopago' then array['pix','credit_card']::text[] else array['pix']::text[] end
  );
end;
$$;
revoke all on function public.nexora_checkout_public_snapshot(text) from public,anon,authenticated;
grant execute on function public.nexora_checkout_public_snapshot(text) to service_role;

commit;

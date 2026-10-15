-- Merchant API key lifecycle. Raw credentials are returned once and never stored.
begin;

do $$ begin
  if to_regclass('public.businesses') is null or to_regclass('public.nexora_audit_log') is null
     or to_regclass('public.nexora_merchant_controls') is null
     or to_regclass('public.merchant_onboarding') is null
     or to_regprocedure('public.nexora_account_active(uuid)') is null
     or to_regprocedure('public.nexora_admin_set_merchant_controls(uuid,boolean,boolean,text,numeric,numeric,numeric,numeric)') is null then
    raise exception 'Apply merchant, audit-log, and account-security migrations first.';
  end if;
end $$;

alter table public.nexora_merchant_controls
  add column if not exists api_enabled boolean not null default false;

create table if not exists public.nexora_merchant_api_keys (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  owner_id uuid not null,
  key_prefix text not null unique check (key_prefix ~ '^nx_(live|test)_[A-Za-z0-9_-]{8,16}$'),
  key_hash text not null unique check (key_hash ~ '^[a-f0-9]{64}$'),
  name text not null check (length(trim(name)) between 2 and 80),
  environment text not null check (environment in ('sandbox','production')),
  scopes text[] not null check (cardinality(scopes) between 1 and 8),
  status text not null default 'active' check (status in ('active','revoked')),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  foreign key (business_id,owner_id) references public.businesses(id,owner_id) on delete restrict,
  check ((environment='production' and key_prefix like 'nx_live_%') or (environment='sandbox' and key_prefix like 'nx_test_%')),
  check ((status='revoked') = (revoked_at is not null))
);
create index if not exists nexora_merchant_api_keys_owner
  on public.nexora_merchant_api_keys(owner_id,business_id,created_at desc);
create index if not exists nexora_merchant_api_keys_active_lookup
  on public.nexora_merchant_api_keys(key_prefix) where status='active';

alter table public.nexora_merchant_api_keys enable row level security;
revoke all on public.nexora_merchant_api_keys from public,anon,authenticated,service_role;

-- One atomic fixed window per key. No user role can inspect or mutate counters.
create table if not exists public.nexora_merchant_api_rate_limits (
  api_key_id uuid primary key references public.nexora_merchant_api_keys(id) on delete cascade,
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  updated_at timestamptz not null default now()
);
alter table public.nexora_merchant_api_rate_limits enable row level security;
revoke all on public.nexora_merchant_api_rate_limits from public,anon,authenticated,service_role;

create or replace function public.nexora_merchant_api_key_create(
  p_business_id uuid,p_key_prefix text,p_key_hash text,p_name text,p_environment text,p_scopes text[]
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid(); v_id uuid; v_scopes text[]; v_business_id uuid;
begin
  if coalesce(auth.jwt()->>'role','')<>'authenticated' or v_owner is null then raise exception 'Merchant session required.'; end if;
  if p_business_id is null or p_key_prefix is null or p_key_prefix !~ '^nx_(live|test)_[A-Za-z0-9_-]{8,16}$'
    or p_key_hash is null or p_key_hash !~ '^[a-f0-9]{64}$'
    or nullif(trim(p_name),'') is null or length(trim(p_name))>80
    or p_environment is null or p_environment not in ('sandbox','production')
    or (p_environment='production' and p_key_prefix not like 'nx_live_%')
    or (p_environment='sandbox' and p_key_prefix not like 'nx_test_%')
    or p_scopes is null or cardinality(p_scopes) not between 1 and 8
    or exists(select 1 from unnest(p_scopes) as s(value) where value not in ('payments:read','payments:write')) then
    raise exception 'Invalid API key request.';
  end if;
  -- Serialize key creation per workspace so concurrent requests cannot bypass the active-key cap.
  select b.id into v_business_id from public.businesses b
    where b.id=p_business_id and b.owner_id=v_owner for update;
  if not found then
    raise exception 'Workspace access denied.';
  end if;
  if p_environment='production' and (
    not exists(select 1 from public.merchant_onboarding k where k.user_id=v_owner and k.status='APPROVED')
    or not public.nexora_account_active(v_owner)
    or not exists(select 1 from public.nexora_merchant_controls c
      where c.business_id=p_business_id and c.owner_id=v_owner and c.api_enabled)
  ) then raise exception 'Production keys require an approved, active merchant.'; end if;
  if (select count(*) from public.nexora_merchant_api_keys k where k.owner_id=v_owner
      and k.business_id=p_business_id and k.status='active')>=20 then
    raise exception 'Maximum active API key limit reached.';
  end if;
  v_scopes:=array(select distinct value from unnest(p_scopes) as s(value) order by value);
  insert into public.nexora_merchant_api_keys(business_id,owner_id,key_prefix,key_hash,name,environment,scopes)
    values(p_business_id,v_owner,p_key_prefix,p_key_hash,trim(p_name),p_environment,v_scopes) returning id into v_id;
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(v_owner,'merchant.api_key.created',v_id::text,jsonb_build_object(
      'business_id',p_business_id,'key_prefix',p_key_prefix,'environment',p_environment,'scopes',v_scopes
    ));
  return jsonb_build_object('id',v_id,'key_prefix',p_key_prefix,'name',trim(p_name),
    'environment',p_environment,'scopes',v_scopes,'status','active','created_at',now());
end;
$$;

create or replace function public.nexora_merchant_api_key_list(p_business_id uuid)
returns table(id uuid,key_prefix text,name text,environment text,scopes text[],status text,
  created_at timestamptz,last_used_at timestamptz,expires_at timestamptz,revoked_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.jwt()->>'role','')<>'authenticated' or auth.uid() is null then raise exception 'Merchant session required.'; end if;
  return query select k.id,k.key_prefix,k.name,k.environment,k.scopes,k.status,k.created_at,k.last_used_at,k.expires_at,k.revoked_at
    from public.nexora_merchant_api_keys k
    where k.business_id=p_business_id and k.owner_id=auth.uid()
    order by k.created_at desc limit 100;
end;
$$;

create or replace function public.nexora_merchant_api_key_revoke(p_key_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_business uuid; v_prefix text;
begin
  if coalesce(auth.jwt()->>'role','')<>'authenticated' or auth.uid() is null then raise exception 'Merchant session required.'; end if;
  update public.nexora_merchant_api_keys k set status='revoked',revoked_at=now()
    where k.id=p_key_id and k.owner_id=auth.uid() and k.status='active'
    returning k.business_id,k.key_prefix into v_business,v_prefix;
  if v_business is null then raise exception 'Active API key not found.'; end if;
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(auth.uid(),'merchant.api_key.revoked',p_key_id::text,jsonb_build_object('business_id',v_business,'key_prefix',v_prefix));
end;
$$;

create or replace function public.nexora_merchant_api_key_rotate(
  p_key_id uuid,p_key_prefix text,p_key_hash text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_old public.nexora_merchant_api_keys; v_new_id uuid; v_new_prefix text;
begin
  if coalesce(auth.jwt()->>'role','')<>'authenticated' or auth.uid() is null then raise exception 'Merchant session required.'; end if;
  if p_key_id is null or p_key_prefix is null or p_key_prefix !~ '^nx_(live|test)_[A-Za-z0-9_-]{8,16}$'
    or p_key_hash is null or p_key_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid API key rotation.'; end if;
  select * into v_old from public.nexora_merchant_api_keys k
    where k.id=p_key_id and k.owner_id=auth.uid() and k.status='active' for update;
  if not found then raise exception 'Active API key not found.'; end if;
  if (v_old.environment='production' and p_key_prefix not like 'nx_live_%')
    or (v_old.environment='sandbox' and p_key_prefix not like 'nx_test_%') then raise exception 'Environment mismatch.'; end if;
  update public.nexora_merchant_api_keys set status='revoked',revoked_at=now() where id=v_old.id;
  v_new_prefix:=p_key_prefix;
  insert into public.nexora_merchant_api_keys(business_id,owner_id,key_prefix,key_hash,name,environment,scopes)
    values(v_old.business_id,v_old.owner_id,v_new_prefix,p_key_hash,v_old.name,v_old.environment,v_old.scopes)
    returning id into v_new_id;
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(auth.uid(),'merchant.api_key.rotated',v_old.id::text,jsonb_build_object(
      'business_id',v_old.business_id,'old_prefix',v_old.key_prefix,'new_key_id',v_new_id,'new_prefix',v_new_prefix
    ));
  return jsonb_build_object('id',v_new_id,'key_prefix',v_new_prefix,'name',v_old.name,
    'environment',v_old.environment,'scopes',v_old.scopes,'status','active','created_at',now());
end;
$$;

-- Extend the admin controls payload while preserving the existing RPC signature.
create or replace function public.nexora_admin_merchant_controls()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_nexora_super_admin() then raise exception 'Acesso restrito ao Painel Nexora Pay.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'owner_id',b.owner_id,'business_id',b.id,'business_name',b.name,'email',u.email,
    'payments_enabled',coalesce(m.payments_enabled,true),'withdrawals_enabled',coalesce(m.withdrawals_enabled,true),
    'api_enabled',coalesce(m.api_enabled,false),'withdrawal_mode',coalesce(m.withdrawal_mode,'manual'),
    'max_transfer_amount',coalesce(m.max_transfer_amount,5000),'daily_transfer_limit',coalesce(m.daily_transfer_limit,20000),
    'alert_threshold_amount',coalesce(m.alert_threshold_amount,5000),'reserve_percentage',coalesce(m.reserve_percentage,0),
    'updated_at',m.updated_at) order by b.name)
    from public.businesses b join public.merchant_onboarding k on k.user_id=b.owner_id and k.status='APPROVED'
    join auth.users u on u.id=b.owner_id left join public.nexora_merchant_controls m on m.business_id=b.id and m.owner_id=b.owner_id),'[]'::jsonb);
end;
$$;

create or replace function public.nexora_admin_set_merchant_controls(
  p_owner_id uuid,p_payments_enabled boolean,p_withdrawals_enabled boolean,p_api_enabled boolean,p_withdrawal_mode text,
  p_max_transfer_amount numeric,p_daily_transfer_limit numeric,p_alert_threshold_amount numeric,p_reserve_percentage numeric
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_business uuid;
begin
  if not public.is_nexora_super_admin() then raise exception 'Acesso restrito ao Painel Nexora Pay.'; end if;
  if p_api_enabled is null then raise exception 'API control must be explicit.'; end if;
  perform public.nexora_admin_set_merchant_controls(
    p_owner_id,p_payments_enabled,p_withdrawals_enabled,p_withdrawal_mode,
    p_max_transfer_amount,p_daily_transfer_limit,p_alert_threshold_amount,p_reserve_percentage
  );
  select id into v_business from public.businesses where owner_id=p_owner_id order by id limit 1;
  update public.nexora_merchant_controls set api_enabled=p_api_enabled,updated_by=auth.uid(),updated_at=now()
    where business_id=v_business and owner_id=p_owner_id;
  if not found then raise exception 'Merchant control row not found.'; end if;
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(auth.uid(),'merchant.api_access_updated',p_owner_id::text,jsonb_build_object(
      'business_id',v_business,'api_enabled',p_api_enabled
    ));
end;
$$;

-- Backend-only credential verification for the forthcoming /api/v1 gateway.
-- The raw secret is never returned; valid calls update last_used_at atomically.
create or replace function public.nexora_merchant_api_key_authenticate(p_key_prefix text,p_key_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_key public.nexora_merchant_api_keys;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_key_prefix is null or p_key_prefix !~ '^nx_(live|test)_[A-Za-z0-9_-]{8,16}$'
    or p_key_hash is null or p_key_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid API key credentials.'; end if;
  update public.nexora_merchant_api_keys k set last_used_at=now()
    where k.key_prefix=p_key_prefix and k.key_hash=p_key_hash and k.status='active'
      and (k.expires_at is null or k.expires_at>now())
      and (k.environment<>'production' or (
        public.nexora_account_active(k.owner_id)
        and exists(select 1 from public.merchant_onboarding m where m.user_id=k.owner_id and m.status='APPROVED')
        and exists(select 1 from public.nexora_merchant_controls c
          where c.business_id=k.business_id and c.owner_id=k.owner_id and c.api_enabled)
      ))
    returning k.* into v_key;
  if not found then return null; end if;
  return jsonb_build_object('id',v_key.id,'business_id',v_key.business_id,'owner_id',v_key.owner_id,
    'environment',v_key.environment,'scopes',v_key.scopes);
end;
$$;

-- Atomic per-key 60-second window; callers enforce the returned allowed flag.
create or replace function public.nexora_merchant_api_rate_limit(p_api_key_id uuid,p_limit integer default 60)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_count integer; v_started timestamptz; v_now timestamptz:=clock_timestamp();
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_api_key_id is null or p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'Invalid API rate limit request.';
  end if;
  if not exists(select 1 from public.nexora_merchant_api_keys k
    where k.id=p_api_key_id and k.status='active' and (k.expires_at is null or k.expires_at>v_now)) then
    return jsonb_build_object('allowed',false,'limit',p_limit,'remaining',0,'retry_after_seconds',0);
  end if;
  insert into public.nexora_merchant_api_rate_limits(api_key_id,window_started_at,request_count,updated_at)
    values(p_api_key_id,v_now,1,v_now)
  on conflict(api_key_id) do update set
    window_started_at=case when public.nexora_merchant_api_rate_limits.window_started_at<=v_now-interval '60 seconds'
      then v_now else public.nexora_merchant_api_rate_limits.window_started_at end,
    request_count=case when public.nexora_merchant_api_rate_limits.window_started_at<=v_now-interval '60 seconds'
      then 1 else public.nexora_merchant_api_rate_limits.request_count+1 end,
    updated_at=v_now
  returning request_count,window_started_at into v_count,v_started;
  return jsonb_build_object('allowed',v_count<=p_limit,'limit',p_limit,
    'remaining',greatest(0,p_limit-v_count),
    'retry_after_seconds',case when v_count<=p_limit then 0 else greatest(1,ceil(extract(epoch from (v_started+interval '60 seconds'-v_now)))::integer) end);
end;
$$;

revoke all on function public.nexora_merchant_api_key_create(uuid,text,text,text,text,text[]) from public,anon;
revoke all on function public.nexora_merchant_api_key_list(uuid) from public,anon;
revoke all on function public.nexora_merchant_api_key_revoke(uuid) from public,anon;
revoke all on function public.nexora_merchant_api_key_rotate(uuid,text,text) from public,anon;
revoke all on function public.nexora_merchant_api_key_authenticate(text,text) from public,anon,authenticated;
revoke all on function public.nexora_merchant_api_rate_limit(uuid,integer) from public,anon,authenticated;
revoke all on function public.nexora_admin_merchant_controls() from public,anon;
revoke all on function public.nexora_admin_set_merchant_controls(uuid,boolean,boolean,boolean,text,numeric,numeric,numeric,numeric) from public,anon;
grant execute on function public.nexora_merchant_api_key_create(uuid,text,text,text,text,text[]) to authenticated;
grant execute on function public.nexora_merchant_api_key_list(uuid) to authenticated;
grant execute on function public.nexora_merchant_api_key_revoke(uuid) to authenticated;
grant execute on function public.nexora_merchant_api_key_rotate(uuid,text,text) to authenticated;
grant execute on function public.nexora_merchant_api_key_authenticate(text,text) to service_role;
grant execute on function public.nexora_merchant_api_rate_limit(uuid,integer) to service_role;
grant execute on function public.nexora_admin_merchant_controls() to authenticated;
grant execute on function public.nexora_admin_set_merchant_controls(uuid,boolean,boolean,boolean,text,numeric,numeric,numeric,numeric) to authenticated;

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
where n.nspname='public' and c.relname='nexora_merchant_api_keys';

select p.proname as function_name,
  has_function_privilege('anon',p.oid,'EXECUTE') as anon_can_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_can_execute,
  has_function_privilege('service_role',p.oid,'EXECUTE') as service_role_can_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in (
  'nexora_merchant_api_key_create','nexora_merchant_api_key_list',
  'nexora_merchant_api_key_revoke','nexora_merchant_api_key_rotate',
  'nexora_merchant_api_key_authenticate','nexora_merchant_api_rate_limit'
) order by p.proname;

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
where n.nspname='public' and c.relname='nexora_merchant_api_rate_limits';

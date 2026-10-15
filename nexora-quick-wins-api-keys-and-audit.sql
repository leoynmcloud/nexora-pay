-- ==============================================================================
-- Nexora Pay - Quick Wins: Auditoria Imutável (#37), Chaves de API (#36) e Controles (#5)
-- ==============================================================================

begin;

-- ==============================================================================
-- PARTE 1: Trilha de Auditoria Imutável (Append-Only) - Requisito #37
-- ==============================================================================

alter table public.nexora_audit_log enable row level security;
revoke all on public.nexora_audit_log from public,anon,authenticated,service_role;
grant select,insert on public.nexora_audit_log to service_role;

do $$ begin
  execute 'revoke all on sequence public.nexora_audit_log_id_seq from public,anon,authenticated,service_role';
  execute 'grant usage,select on sequence public.nexora_audit_log_id_seq to service_role';
exception when undefined_table then
  null; -- Sequence name managed internally by identity
end $$;

create or replace function public.nexora_audit_log_reject_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode='55000',message='Administrative audit events are append-only.';
end;
$$;
revoke all on function public.nexora_audit_log_reject_mutation() from public,anon,authenticated,service_role;

drop trigger if exists nexora_audit_log_reject_row_mutation on public.nexora_audit_log;
create trigger nexora_audit_log_reject_row_mutation
  before update or delete on public.nexora_audit_log
  for each row execute function public.nexora_audit_log_reject_mutation();

drop trigger if exists nexora_audit_log_reject_truncate on public.nexora_audit_log;
create trigger nexora_audit_log_reject_truncate
  before truncate on public.nexora_audit_log
  for each statement execute function public.nexora_audit_log_reject_mutation();

-- ==============================================================================
-- PARTE 2: Chaves de API de Merchants com Hash SHA-256 e Rate Limit - Requisito #36
-- ==============================================================================

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

create table if not exists public.nexora_merchant_api_rate_limits (
  api_key_id uuid primary key references public.nexora_merchant_api_keys(id) on delete cascade,
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  updated_at timestamptz not null default now()
);

alter table public.nexora_merchant_api_rate_limits enable row level security;
revoke all on public.nexora_merchant_api_rate_limits from public,anon,authenticated,service_role;

drop function if exists public.nexora_merchant_api_key_create(uuid,text,text,text,text,text[]);
create or replace function public.nexora_merchant_api_key_create(
  p_business_id uuid,p_key_prefix text,p_key_hash text,p_name text,p_environment text,p_scopes text[]
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid(); v_id uuid; v_scopes text[]; v_business_id uuid;
begin
  if coalesce(auth.jwt()->>'role','')<>'authenticated' or v_owner is null then raise exception 'Merchant session required.'; end if;
  if p_business_id is null or p_key_prefix is null or p_key_prefix !~ '^nx_(live|test)_[A-Za-z0-9_-]{8,16}$'
     or p_key_hash is null or p_key_hash !~ '^[a-f0-9]{64}$'
     or p_name is null or length(trim(p_name)) not between 2 and 80
     or p_environment is null or p_environment not in ('sandbox','production')
     or p_scopes is null or cardinality(p_scopes)=0 then
    raise exception 'Invalid API key parameters.';
  end if;
  if (p_environment='production' and p_key_prefix not like 'nx_live_%')
     or (p_environment='sandbox' and p_key_prefix not like 'nx_test_%') then
    raise exception 'API key prefix does not match environment.';
  end if;
  select array_agg(distinct s) into v_scopes from unnest(p_scopes) as s where s in ('payments:read','payments:write');
  if v_scopes is null or cardinality(v_scopes)<cardinality(p_scopes) then
    raise exception 'Unsupported API key scope.';
  end if;
  select b.id into v_business_id from public.businesses b where b.id=p_business_id and b.owner_id=v_owner;
  if v_business_id is null then raise exception 'Merchant workspace not found.'; end if;
  if not exists(select 1 from public.merchant_onboarding k where k.user_id=v_owner and k.status='APPROVED')
     or not public.nexora_account_active(v_owner) then
    raise exception 'Approved active merchant is required.';
  end if;
  if p_environment='production' and not exists(
    select 1 from public.nexora_merchant_controls c
    where c.business_id=p_business_id and c.owner_id=v_owner and c.api_enabled
  ) then
    raise exception 'Production API access is disabled by administrator.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_owner::text||':'||p_business_id::text,0));
  if (select count(*) from public.nexora_merchant_api_keys where business_id=p_business_id and status='active') >= 20 then
    raise exception 'Maximum of 20 active API keys reached.';
  end if;

  insert into public.nexora_merchant_api_keys(
    business_id,owner_id,key_prefix,key_hash,name,environment,scopes,status
  ) values (
    p_business_id,v_owner,p_key_prefix,p_key_hash,trim(p_name),p_environment,v_scopes,'active'
  ) returning id into v_id;

  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(v_owner,'merchant.api_key.created',v_id::text,
      jsonb_build_object('business_id',p_business_id,'environment',p_environment,'scopes',v_scopes,'key_prefix',p_key_prefix));

  return jsonb_build_object('id',v_id,'key_prefix',p_key_prefix,'name',trim(p_name),'environment',p_environment,'scopes',v_scopes,'status','active');
end;
$$;
revoke all on function public.nexora_merchant_api_key_create(uuid,text,text,text,text,text[]) from public,anon,service_role;
grant execute on function public.nexora_merchant_api_key_create(uuid,text,text,text,text,text[]) to authenticated;

drop function if exists public.nexora_merchant_api_key_list(uuid);
create or replace function public.nexora_merchant_api_key_list(p_business_id uuid)
returns table(
  id uuid,key_prefix text,name text,environment text,scopes text[],status text,
  created_at timestamptz,last_used_at timestamptz,expires_at timestamptz,revoked_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.jwt()->>'role','')<>'authenticated' or auth.uid() is null then raise exception 'Merchant session required.'; end if;
  return query select k.id,k.key_prefix,k.name,k.environment,k.scopes,k.status,k.created_at,k.last_used_at,k.expires_at,k.revoked_at
    from public.nexora_merchant_api_keys k
    where k.business_id=p_business_id and k.owner_id=auth.uid()
    order by k.created_at desc limit 100;
end;
$$;
revoke all on function public.nexora_merchant_api_key_list(uuid) from public,anon,service_role;
grant execute on function public.nexora_merchant_api_key_list(uuid) to authenticated;

drop function if exists public.nexora_merchant_api_key_revoke(uuid);
create or replace function public.nexora_merchant_api_key_revoke(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_owner uuid:=auth.uid(); v_business_id uuid;
begin
  if coalesce(auth.jwt()->>'role','')<>'authenticated' or v_owner is null then raise exception 'Merchant session required.'; end if;
  update public.nexora_merchant_api_keys set status='revoked',revoked_at=now()
    where id=p_id and owner_id=v_owner and status='active'
    returning business_id into v_business_id;
  if v_business_id is null then raise exception 'Active API key not found.'; end if;
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(v_owner,'merchant.api_key.revoked',p_id::text,jsonb_build_object('business_id',v_business_id));
end;
$$;
revoke all on function public.nexora_merchant_api_key_revoke(uuid) from public,anon,service_role;
grant execute on function public.nexora_merchant_api_key_revoke(uuid) to authenticated;

drop function if exists public.nexora_merchant_api_key_rotate(uuid,text,text);
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
revoke all on function public.nexora_merchant_api_key_rotate(uuid,text,text) from public,anon,service_role;
grant execute on function public.nexora_merchant_api_key_rotate(uuid,text,text) to authenticated;

drop function if exists public.nexora_merchant_api_key_authenticate(text,text);
create or replace function public.nexora_merchant_api_key_authenticate(p_key_prefix text,p_key_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.nexora_merchant_api_keys;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  select * into v_row from public.nexora_merchant_api_keys
    where key_prefix=p_key_prefix and key_hash=p_key_hash and status='active'
      and (expires_at is null or expires_at>now());
  if not found then return null; end if;
  update public.nexora_merchant_api_keys set last_used_at=now() where id=v_row.id;
  return jsonb_build_object('id',v_row.id,'business_id',v_row.business_id,'owner_id',v_row.owner_id,
    'environment',v_row.environment,'scopes',v_row.scopes,'key_prefix',v_row.key_prefix);
end;
$$;
revoke all on function public.nexora_merchant_api_key_authenticate(text,text) from public,anon,authenticated;
grant execute on function public.nexora_merchant_api_key_authenticate(text,text) to service_role;

drop function if exists public.nexora_merchant_api_rate_limit(uuid,integer);
create or replace function public.nexora_merchant_api_rate_limit(p_api_key_id uuid,p_limit integer default 60)
returns table(allowed boolean,remaining integer,retry_after integer) language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := clock_timestamp();
  v_window timestamptz;
  v_count integer;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_api_key_id::text,0));
  select window_started_at,request_count into v_window,v_count
    from public.nexora_merchant_api_rate_limits where api_key_id=p_api_key_id;
  if not found or v_window <= v_now - interval '60 seconds' then
    insert into public.nexora_merchant_api_rate_limits(api_key_id,window_started_at,request_count,updated_at)
      values(p_api_key_id,v_now,1,v_now)
      on conflict (api_key_id) do update set window_started_at=v_now,request_count=1,updated_at=v_now;
    return query select true,greatest(p_limit-1,0),0;
    return;
  end if;
  if v_count >= p_limit then
    return query select false,0,greatest(1,ceil(extract(epoch from (v_window + interval '60 seconds' - v_now))))::integer;
    return;
  end if;
  update public.nexora_merchant_api_rate_limits set request_count=request_count+1,updated_at=v_now where api_key_id=p_api_key_id;
  return query select true,greatest(p_limit-(v_count+1),0),0;
end;
$$;
revoke all on function public.nexora_merchant_api_rate_limit(uuid,integer) from public,anon,authenticated;
grant execute on function public.nexora_merchant_api_rate_limit(uuid,integer) to service_role;

notify pgrst,'reload schema';
commit;

-- Consulta de verificação consolidada:
select 'audit_log_append_only_trigger' as check_item, count(*)::text as result
from pg_trigger where tgname = 'nexora_audit_log_reject_row_mutation'
union all
select 'api_keys_table_rls', relrowsecurity::text
from pg_class where relname = 'nexora_merchant_api_keys'
union all
select 'rate_limits_table_rls', relrowsecurity::text
from pg_class where relname = 'nexora_merchant_api_rate_limits'
union all
select 'api_key_list_function', count(*)::text
from pg_proc where proname = 'nexora_merchant_api_key_list'
union all
select 'merchant_controls_count', count(*)::text
from information_schema.columns
where table_schema = 'public' and table_name = 'nexora_merchant_controls'
  and column_name in ('payments_enabled','withdrawals_enabled','pix_out_enabled','balance_movements_blocked','api_enabled')
union all
select 'pricing_rules_count', count(*)::text
from public.nexora_pricing_rules where effective_from <= now()
union all
select 'mercadopago_status', status::text
from public.nexora_acquirers where code = 'mercadopago_production';

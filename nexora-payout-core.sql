-- Provider-neutral payout reservation, review, one-shot dispatch claim, and
-- immutable provider transfer events. Real payouts stay disabled by default;
-- deployment also requires the Edge Function flag and an explicitly enabled
-- provider route. Apply only after KYC, provider routes, the production ledger,
-- ledger hardening, and central credentials are installed.
begin;

do $$ begin
  if to_regclass('public.businesses') is null
     or to_regclass('public.merchant_onboarding') is null
     or to_regclass('public.nexora_merchant_controls') is null
     or to_regclass('public.nexora_merchant_provider_connections') is null
     or to_regclass('public.nexora_platform_provider_credentials') is null
     or to_regclass('public.nexora_acquirers') is null
     or to_regclass('public.nexora_audit_log') is null
     or to_regclass('public.nexora_admins') is null
     or to_regclass('public.nexora_ledger_accounts') is null
     or to_regclass('public.nexora_ledger_entries') is null
     or to_regprocedure('public.nexora_account_active(uuid)') is null
     or to_regprocedure('public.nexora_ledger_reject_mutation()') is null
     or to_regprocedure('public.nexora_ledger_post_journal(uuid,uuid,uuid,text,text,text,text,jsonb,jsonb)') is null then
    raise exception 'Apply KYC, provider credentials/routes, production ledger, and ledger hardening first.';
  end if;
  if not exists(select 1 from pg_attribute where attrelid='public.nexora_merchant_controls'::regclass
      and attname='pix_out_enabled' and not attisdropped)
     or not exists(select 1 from pg_attribute where attrelid='public.nexora_merchant_controls'::regclass
      and attname='balance_movements_blocked' and not attisdropped) then
    raise exception 'Apply nexora-merchant-independent-controls.sql before payout core.';
  end if;
end $$;

create table if not exists public.nexora_payout_runtime (
  id boolean primary key default true check (id),
  production_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.nexora_payout_runtime(id,production_enabled) values(true,false)
  on conflict(id) do nothing;
alter table public.nexora_payout_runtime enable row level security;
revoke all on public.nexora_payout_runtime from public,anon,authenticated,service_role;
grant select on public.nexora_payout_runtime to service_role;

create unique index if not exists nexora_provider_credentials_acquirer_environment_id_unique
  on public.nexora_platform_provider_credentials(acquirer_id,environment,id);

-- Provider capabilities are configuration, not inferred from a provider name.
-- A connector can be ready in code while remaining operationally disabled.
create table if not exists public.nexora_payout_connector_catalog (
  adapter_code text primary key check (adapter_code ~ '^[a-z][a-z0-9_-]{1,49}$'),
  pix_out_supported boolean not null default false,
  implementation_ready boolean not null default false,
  created_at timestamptz not null default now()
);
insert into public.nexora_payout_connector_catalog(adapter_code,pix_out_supported,implementation_ready)
  values('asaas',true,true),('mercadopago',true,true)
  on conflict(adapter_code) do update set
    pix_out_supported=excluded.pix_out_supported,
    implementation_ready=excluded.implementation_ready;
alter table public.nexora_payout_connector_catalog enable row level security;
revoke all on public.nexora_payout_connector_catalog from public,anon,authenticated,service_role;
grant select on public.nexora_payout_connector_catalog to service_role;

create table if not exists public.nexora_payout_provider_adapters (
  provider_code text not null references public.nexora_acquirers(code) on delete restrict,
  environment text not null check (environment in ('sandbox','production')),
  adapter_code text not null references public.nexora_payout_connector_catalog(adapter_code) on delete restrict,
  pix_out_enabled boolean not null default false,
  adapter_ready boolean not null default false,
  status text not null default 'disabled' check (status in ('enabled','disabled','degraded')),
  updated_at timestamptz not null default now(),
  primary key(provider_code,environment),
  unique(provider_code,environment,adapter_code)
);
insert into public.nexora_payout_provider_adapters(provider_code,environment,adapter_code,pix_out_enabled,adapter_ready,status)
  select 'asaas_production','production','asaas',true,true,'disabled'
  where exists(select 1 from public.nexora_acquirers where code='asaas_production' and environment='production')
  on conflict(provider_code,environment) do nothing;
insert into public.nexora_payout_provider_adapters(provider_code,environment,adapter_code,pix_out_enabled,adapter_ready,status)
  select 'mercadopago_production','production','mercadopago',true,true,'disabled'
  where exists(select 1 from public.nexora_acquirers where code='mercadopago_production' and environment='production')
  on conflict(provider_code,environment) do nothing;
alter table public.nexora_payout_provider_adapters enable row level security;
revoke all on public.nexora_payout_provider_adapters from public,anon,authenticated,service_role;
grant select on public.nexora_payout_provider_adapters to service_role;

create table if not exists public.nexora_payouts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  business_id uuid not null,
  request_id uuid not null,
  request_sha256 text not null check (request_sha256 ~ '^[a-f0-9]{64}$'),
  amount_cents bigint not null check (amount_cents between 1 and 999999999999),
  destination_type text not null check (destination_type in ('CPF','CNPJ','EMAIL','PHONE','EVP')),
  destination_ciphertext text not null check (length(destination_ciphertext) between 30 and 12000
    and destination_ciphertext ~ '^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$'),
  destination_key_version integer not null check (destination_key_version > 0),
  destination_sha256 text not null check (destination_sha256 ~ '^[a-f0-9]{64}$'),
  acquirer_id uuid not null references public.nexora_acquirers(id) on delete restrict,
  provider_code text not null check (provider_code ~ '^[a-z][a-z0-9_-]{1,79}$'),
  adapter_code text not null check (adapter_code ~ '^[a-z][a-z0-9_-]{1,49}$'),
  environment text not null check (environment='production'),
  provider_credential_id uuid not null references public.nexora_platform_provider_credentials(id) on delete restrict,
  external_reference text not null unique check (external_reference ~ '^NX-PAYOUT-[A-Za-z0-9-]{16,80}$'),
  provider_batch_id text check (provider_batch_id is null or provider_batch_id ~ '^[A-Za-z0-9-]{8,100}$'),
  provider_transfer_id text check (provider_transfer_id is null or provider_transfer_id ~ '^[A-Za-z0-9-]{8,100}$'),
  status text not null check (status in (
    'RESERVED','APPROVED','PROCESSING','RISK_REVIEW','OUTCOME_UNKNOWN',
    'COMPLETED','FAILED','CANCELLED','REJECTED'
  )),
  failure_code text check (failure_code is null or failure_code ~ '^[a-z0-9_]{1,80}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id,business_id,request_id),
  foreign key(business_id,owner_id) references public.businesses(id,owner_id) on delete restrict,
  foreign key(acquirer_id,environment,provider_credential_id)
    references public.nexora_platform_provider_credentials(acquirer_id,environment,id) on delete restrict
);
alter table public.nexora_payouts add column if not exists provider_batch_id text;
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.nexora_payouts'::regclass and conname='nexora_payouts_provider_batch_id_check') then
    alter table public.nexora_payouts add constraint nexora_payouts_provider_batch_id_check
      check (provider_batch_id is null or provider_batch_id ~ '^[A-Za-z0-9-]{8,100}$');
  end if;
end $$;
-- Provider-generated IDs are only unique inside a provider namespace.
-- Remove legacy global uniqueness before installing provider-scoped indexes.
alter table public.nexora_payouts drop constraint if exists nexora_payouts_provider_transfer_id_key;
drop index if exists public.nexora_payouts_provider_batch_id_unique;
create unique index if not exists nexora_payouts_provider_batch_identity_unique
  on public.nexora_payouts(provider_code,provider_batch_id) where provider_batch_id is not null;
create unique index if not exists nexora_payouts_provider_transfer_identity_unique
  on public.nexora_payouts(provider_code,provider_transfer_id) where provider_transfer_id is not null;
alter table public.nexora_payouts add column if not exists adapter_code text;
update public.nexora_payouts set adapter_code='asaas' where adapter_code is null and provider_code='asaas_production';
do $$ begin
  if exists(select 1 from public.nexora_payouts where adapter_code is null) then
    raise exception 'Backfill adapter_code for existing payout rows before applying the adapter registry.';
  end if;
end $$;
alter table public.nexora_payouts alter column adapter_code set not null;
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.nexora_payouts'::regclass and conname='nexora_payouts_provider_adapter_fk') then
    alter table public.nexora_payouts add constraint nexora_payouts_provider_adapter_fk
      foreign key(provider_code,environment,adapter_code) references public.nexora_payout_provider_adapters(provider_code,environment,adapter_code) on delete restrict;
  end if;
end $$;
create index if not exists nexora_payouts_business_created
  on public.nexora_payouts(business_id,created_at desc);
create index if not exists nexora_payouts_status_created
  on public.nexora_payouts(status,created_at) where status in ('RESERVED','APPROVED','PROCESSING','RISK_REVIEW','OUTCOME_UNKNOWN');
alter table public.nexora_payouts enable row level security;
revoke all on public.nexora_payouts from public,anon,authenticated,service_role;
grant select on public.nexora_payouts to service_role;

create or replace function public.nexora_payout_guard_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.owner_id is distinct from old.owner_id or new.business_id is distinct from old.business_id
     or new.request_id is distinct from old.request_id or new.request_sha256 is distinct from old.request_sha256
     or new.amount_cents is distinct from old.amount_cents or new.destination_type is distinct from old.destination_type
     or new.destination_ciphertext is distinct from old.destination_ciphertext
     or new.destination_key_version is distinct from old.destination_key_version
     or new.destination_sha256 is distinct from old.destination_sha256
     or new.acquirer_id is distinct from old.acquirer_id or new.provider_code is distinct from old.provider_code
     or new.adapter_code is distinct from old.adapter_code
     or new.environment is distinct from old.environment or new.provider_credential_id is distinct from old.provider_credential_id
     or new.external_reference is distinct from old.external_reference
     or (old.provider_batch_id is not null and new.provider_batch_id is distinct from old.provider_batch_id)
     or (old.provider_transfer_id is not null and new.provider_transfer_id is distinct from old.provider_transfer_id)
     or (old.status in ('COMPLETED','FAILED','CANCELLED','REJECTED') and new.status is distinct from old.status) then
    raise exception 'Payout identity and terminal states are immutable.';
  end if;
  return new;
end;
$$;
revoke all on function public.nexora_payout_guard_update() from public,anon,authenticated,service_role;
drop trigger if exists nexora_payout_guard_update on public.nexora_payouts;
create trigger nexora_payout_guard_update before update on public.nexora_payouts
  for each row execute function public.nexora_payout_guard_update();

create table if not exists public.nexora_payout_provider_events (
  id uuid primary key default gen_random_uuid(),
  payout_id uuid not null references public.nexora_payouts(id) on delete restrict,
  provider_code text not null check (provider_code ~ '^[a-z][a-z0-9_-]{1,79}$'),
  provider_event_id text not null check (length(trim(provider_event_id)) between 1 and 255),
  provider_event_type text not null check (length(trim(provider_event_type)) between 1 and 100),
  provider_batch_id text check (provider_batch_id is null or provider_batch_id ~ '^[A-Za-z0-9-]{8,100}$'),
  provider_transfer_id text not null check (provider_transfer_id ~ '^[A-Za-z0-9-]{8,100}$'),
  raw_provider_status text not null check (length(trim(raw_provider_status)) between 1 and 80),
  normalized_status text not null check (normalized_status in ('PROCESSING','RISK_REVIEW','COMPLETED','FAILED')),
  amount_cents bigint not null check (amount_cents > 0),
  payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  received_at timestamptz not null default now(),
  unique(provider_code,provider_event_id)
);
create index if not exists nexora_payout_events_payout_time
  on public.nexora_payout_provider_events(payout_id,received_at desc);
alter table public.nexora_payout_provider_events enable row level security;
revoke all on public.nexora_payout_provider_events from public,anon,authenticated,service_role;
grant select on public.nexora_payout_provider_events to service_role;
drop trigger if exists nexora_payout_events_immutable on public.nexora_payout_provider_events;
create trigger nexora_payout_events_immutable
  before update or delete on public.nexora_payout_provider_events
  for each row execute function public.nexora_ledger_reject_mutation();

alter table public.nexora_payout_provider_events add column if not exists provider_batch_id text;
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.nexora_payout_provider_events'::regclass and conname='nexora_payout_provider_events_provider_batch_id_check') then
    alter table public.nexora_payout_provider_events add constraint nexora_payout_provider_events_provider_batch_id_check
      check (provider_batch_id is null or provider_batch_id ~ '^[A-Za-z0-9-]{8,100}$');
  end if;
end $$;

create or replace function public.nexora_payout_reserve(
  p_owner_id uuid,p_business_id uuid,p_request_id uuid,p_request_sha256 text,
  p_amount_cents bigint,p_destination_type text,p_destination_ciphertext text,
  p_destination_key_version integer,p_destination_sha256 text
)
returns table(payout_id uuid,external_reference text,status text)
language plpgsql security definer set search_path = '' as $$
declare
  v_payout public.nexora_payouts;
  v_acquirer uuid; v_provider text; v_adapter text; v_environment text; v_credential uuid;
  v_available bigint; v_limit bigint; v_daily_limit bigint; v_used bigint;
  v_request_hash text; v_external_reference text; v_enabled boolean;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_owner_id is null or p_business_id is null or p_request_id is null
     or p_request_sha256 is null or p_request_sha256 !~ '^[a-f0-9]{64}$'
     or p_destination_sha256 is null or p_destination_sha256 !~ '^[a-f0-9]{64}$'
     or p_amount_cents is null or p_amount_cents<=0 or p_amount_cents>999999999999
     or p_destination_type is null or p_destination_type not in ('CPF','CNPJ','EMAIL','PHONE','EVP')
     or p_destination_ciphertext is null or p_destination_ciphertext !~ '^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$'
     or p_destination_key_version is null or p_destination_key_version<>1
     or length(p_destination_ciphertext)>12000 then raise exception 'Invalid payout request.'; end if;

  select production_enabled into v_enabled from public.nexora_payout_runtime where id=true;
  if coalesce(v_enabled,false) is not true then raise exception 'Real payouts are disabled.'; end if;
  perform 1 from public.businesses b where b.id=p_business_id and b.owner_id=p_owner_id for update;
  if not found then raise exception 'Merchant workspace not found.'; end if;

  select p.* into v_payout from public.nexora_payouts p
   where p.owner_id=p_owner_id and p.business_id=p_business_id and p.request_id=p_request_id for update;
  if found then
    if v_payout.request_sha256<>p_request_sha256 then raise exception 'Idempotency key reused for a different payout.'; end if;
    return query select v_payout.id,v_payout.external_reference,v_payout.status; return;
  end if;
  if not exists(select 1 from public.merchant_onboarding m where m.user_id=p_owner_id and m.status='APPROVED')
     or not public.nexora_account_active(p_owner_id) then raise exception 'Merchant is not approved and active.'; end if;
  select round(c.max_transfer_amount*100)::bigint,round(c.daily_transfer_limit*100)::bigint
    into v_limit,v_daily_limit from public.nexora_merchant_controls c
    where c.business_id=p_business_id and c.owner_id=p_owner_id and c.withdrawals_enabled
      and c.pix_out_enabled and not c.balance_movements_blocked for update;
  if not found then raise exception 'Merchant withdrawals or Pix OUT are disabled, or outgoing movements are blocked.'; end if;
  if p_amount_cents>v_limit then raise exception 'Payout exceeds the per-transfer limit.'; end if;
  select c.acquirer_id,a.code,pa.adapter_code,a.environment,k.id into v_acquirer,v_provider,v_adapter,v_environment,v_credential
    from public.nexora_merchant_provider_connections c
    join public.nexora_acquirers a on a.id=c.acquirer_id and a.status='enabled'
    join public.nexora_payout_provider_adapters pa on pa.provider_code=a.code and pa.environment=a.environment
      and pa.pix_out_enabled and pa.adapter_ready and pa.status='enabled'
    join public.nexora_payout_connector_catalog pc on pc.adapter_code=pa.adapter_code
      and pc.pix_out_supported and pc.implementation_ready
    join public.nexora_platform_provider_credentials k on k.acquirer_id=a.id and k.environment=a.environment and k.status='active'
    where c.business_id=p_business_id and c.owner_id=p_owner_id and c.status='active'
      and a.environment='production'
    order by c.updated_at desc limit 1;
  if not found then raise exception 'No approved production payout route is configured.'; end if;

  select coalesce(sum(case when e.side='credit' then e.amount_cents else -e.amount_cents end),0)::bigint
    into v_available from public.nexora_ledger_entries e
    join public.nexora_ledger_accounts a on a.id=e.account_id and a.business_id=e.business_id and a.owner_id=e.owner_id
    where e.owner_id=p_owner_id and e.business_id=p_business_id and a.account_code='merchant_available';
  if p_amount_cents>v_available then raise exception 'Insufficient available ledger balance.'; end if;
  select coalesce(sum(p.amount_cents),0) into v_used from public.nexora_payouts p
    where p.business_id=p_business_id and p.created_at >= (date_trunc('day',now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo')
      and p.status not in ('FAILED','CANCELLED','REJECTED');
  if v_used+p_amount_cents>v_daily_limit then raise exception 'Payout exceeds the daily limit.'; end if;

  -- The authenticated Edge Function computes this digest over canonical intent;
  -- using that value avoids any dependency on database crypto extensions.
  v_request_hash:=p_request_sha256;
  v_external_reference:='NX-PAYOUT-'||gen_random_uuid()::text;
  insert into public.nexora_payouts(
    owner_id,business_id,request_id,request_sha256,amount_cents,destination_type,destination_ciphertext,destination_key_version,
    destination_sha256,acquirer_id,provider_code,adapter_code,environment,provider_credential_id,external_reference,status
  ) values(
    p_owner_id,p_business_id,p_request_id,p_request_sha256,p_amount_cents,p_destination_type,p_destination_ciphertext,p_destination_key_version,
    p_destination_sha256,v_acquirer,v_provider,v_adapter,v_environment,v_credential,v_external_reference,'RESERVED'
  ) returning * into v_payout;
  perform public.nexora_ledger_post_journal(
    p_owner_id,p_business_id,null,'payout.reserved','payout.reserve:'||v_payout.id::text,v_request_hash,
    'Funds reserved for payout request.',
    jsonb_build_array(
      jsonb_build_object('account_code','merchant_available','side','debit','amount_cents',p_amount_cents),
      jsonb_build_object('account_code','merchant_reserved','side','credit','amount_cents',p_amount_cents)
      ),jsonb_build_object('payout_id',v_payout.id,'provider_code',v_provider,'adapter_code',v_adapter,'external_reference',v_external_reference)
  );
  return query select v_payout.id,v_payout.external_reference,v_payout.status;
end;
$$;
revoke all on function public.nexora_payout_reserve(uuid,uuid,uuid,text,bigint,text,text,integer,text) from public,anon,authenticated;
grant execute on function public.nexora_payout_reserve(uuid,uuid,uuid,text,bigint,text,text,integer,text) to service_role;

drop function if exists public.nexora_payout_merchant_list(uuid,uuid,integer);
create or replace function public.nexora_payout_merchant_list(
  p_owner_id uuid,p_business_id uuid,p_limit integer default 50,
  p_before_created_at timestamptz default null,p_before_payout_id uuid default null
)
returns table(
  payout_id uuid,amount_cents bigint,status text,provider_code text,
  external_reference text,created_at timestamptz,updated_at timestamptz,has_more boolean
)
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role'
     or p_owner_id is null or p_business_id is null
     or not exists(select 1 from public.businesses b where b.id=p_business_id and b.owner_id=p_owner_id) then
    raise exception 'Merchant workspace not found.';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'Invalid payout page size.'; end if;
  if (p_before_created_at is null) <> (p_before_payout_id is null) then
    raise exception 'Both pagination cursor fields must be supplied together.';
  end if;
  return query
    with candidates as materialized (
      select p.id,p.amount_cents,p.status,p.provider_code,p.external_reference,p.created_at,p.updated_at
      from public.nexora_payouts p
      where p.owner_id=p_owner_id and p.business_id=p_business_id
        and (p_before_created_at is null or (p.created_at,p.id)<(p_before_created_at,p_before_payout_id))
      order by p.created_at desc,p.id desc limit p_limit+1
    ), numbered as (
      select c.*,row_number() over(order by c.created_at desc,c.id desc) as row_number,
        count(*) over() as page_count
      from candidates c
    )
    select n.id,n.amount_cents,n.status,n.provider_code,n.external_reference,n.created_at,n.updated_at,
      n.page_count>p_limit
    from numbered n where n.row_number<=p_limit
    order by n.created_at desc,n.id desc;
end;
$$;
revoke all on function public.nexora_payout_merchant_list(uuid,uuid,integer,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.nexora_payout_merchant_list(uuid,uuid,integer,timestamptz,uuid) to service_role;

drop function if exists public.nexora_payout_apply_provider_event(text,text,text,text,text,text,text,bigint,text);
create or replace function public.nexora_payout_apply_provider_event(
  p_provider_code text,p_external_reference text,p_provider_event_id text,p_provider_event_type text,
  p_provider_transfer_id text,p_raw_provider_status text,p_normalized_status text,
  p_amount_cents bigint,p_payload_sha256 text,p_provider_batch_id text default null
)
returns text language plpgsql security definer set search_path = '' as $$
declare v_payout public.nexora_payouts; v_inserted uuid; v_hash text; v_status text;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_provider_code is null or p_provider_code !~ '^[a-z][a-z0-9_-]{1,79}$'
     or p_external_reference is null or p_external_reference !~ '^NX-PAYOUT-[A-Za-z0-9-]{16,80}$'
     or p_provider_event_id is null or length(p_provider_event_id) not between 1 and 255
     or p_provider_event_type is null or length(p_provider_event_type) not between 1 and 100
     or p_provider_transfer_id is null or p_provider_transfer_id !~ '^[A-Za-z0-9-]{8,100}$'
     or (p_provider_batch_id is not null and p_provider_batch_id !~ '^[A-Za-z0-9-]{8,100}$')
     or p_raw_provider_status is null or length(p_raw_provider_status) not between 1 and 80
     or p_normalized_status is null
     or p_normalized_status not in ('PROCESSING','RISK_REVIEW','COMPLETED','FAILED')
     or p_amount_cents is null or p_amount_cents<=0
     or p_payload_sha256 is null or p_payload_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid provider payout event.';
  end if;
  -- Provider-specific event names/statuses are normalized by the selected
  -- connector before this core RPC. Never bake an acquirer's vocabulary here.
  select * into v_payout from public.nexora_payouts p where p.external_reference=p_external_reference for update;
  if not found or v_payout.provider_code<>p_provider_code or v_payout.amount_cents<>p_amount_cents
     or (v_payout.provider_batch_id is not null and v_payout.provider_batch_id is distinct from p_provider_batch_id)
     or (v_payout.provider_transfer_id is not null and v_payout.provider_transfer_id<>p_provider_transfer_id) then
    raise exception 'Provider payout identity mismatch.';
  end if;
  if v_payout.adapter_code='mercadopago' and p_provider_batch_id is null then
    raise exception 'Mercado Pago payout batch ID is required.';
  end if;
  insert into public.nexora_payout_provider_events(
    payout_id,provider_code,provider_event_id,provider_event_type,provider_batch_id,provider_transfer_id,
    raw_provider_status,normalized_status,amount_cents,payload_sha256
  ) values(v_payout.id,p_provider_code,p_provider_event_id,p_provider_event_type,p_provider_batch_id,p_provider_transfer_id,
    p_raw_provider_status,p_normalized_status,p_amount_cents,p_payload_sha256)
  on conflict(provider_code,provider_event_id) do nothing returning id into v_inserted;
  if v_inserted is null then
    if not exists(select 1 from public.nexora_payout_provider_events e where e.provider_code=p_provider_code
      and e.provider_event_id=p_provider_event_id and e.payout_id=v_payout.id
      and e.payload_sha256=p_payload_sha256 and e.provider_batch_id is not distinct from p_provider_batch_id
      and e.provider_transfer_id=p_provider_transfer_id) then
      raise exception 'Provider event ID collision.';
    end if;
    return v_payout.status;
  end if;
  if v_payout.status in ('COMPLETED','FAILED','CANCELLED','REJECTED') then return v_payout.status; end if;
  if p_normalized_status='PROCESSING' then
    if v_payout.status in ('RESERVED','APPROVED','OUTCOME_UNKNOWN') then v_status:='PROCESSING'; else v_status:=v_payout.status; end if;
  elsif p_normalized_status='RISK_REVIEW' then v_status:='RISK_REVIEW';
  elsif p_normalized_status='COMPLETED' then
    v_status:='COMPLETED';
    v_hash:=p_payload_sha256;
    perform public.nexora_ledger_post_journal(v_payout.owner_id,v_payout.business_id,null,'payout.completed',
      'payout.completed:'||v_payout.id::text,v_hash,'Provider confirmed payout completion.',
      jsonb_build_array(jsonb_build_object('account_code','merchant_reserved','side','debit','amount_cents',p_amount_cents),
        jsonb_build_object('account_code','provider_clearing','side','credit','amount_cents',p_amount_cents)),
      jsonb_build_object('payout_id',v_payout.id,'provider_event_id',p_provider_event_id));
  else
    v_status:='FAILED';
    v_hash:=p_payload_sha256;
    perform public.nexora_ledger_post_journal(v_payout.owner_id,v_payout.business_id,null,'payout.failed',
      'payout.failed:'||v_payout.id::text,v_hash,'Provider confirmed payout failure; funds released.',
      jsonb_build_array(jsonb_build_object('account_code','merchant_reserved','side','debit','amount_cents',p_amount_cents),
        jsonb_build_object('account_code','merchant_available','side','credit','amount_cents',p_amount_cents)),
      jsonb_build_object('payout_id',v_payout.id,'provider_event_id',p_provider_event_id));
  end if;
  update public.nexora_payouts set status=v_status,provider_batch_id=coalesce(provider_batch_id,p_provider_batch_id),
    provider_transfer_id=p_provider_transfer_id,
    failure_code=case when v_status='FAILED' then 'provider_transfer_failed' else null end,updated_at=now()
    where id=v_payout.id;
  return v_status;
end;
$$;
revoke all on function public.nexora_payout_apply_provider_event(text,text,text,text,text,text,text,bigint,text,text) from public,anon,authenticated;
grant execute on function public.nexora_payout_apply_provider_event(text,text,text,text,text,text,text,bigint,text,text) to service_role;

create table if not exists public.nexora_payout_admin_events (
  id uuid primary key default gen_random_uuid(),
  payout_id uuid not null references public.nexora_payouts(id) on delete restrict,
  actor_id uuid not null references auth.users(id) on delete restrict,
  action text not null check (action in ('approved','rejected','dispatch_started','reconciled')),
  from_status text not null,
  to_status text not null,
  reason text not null check (length(trim(reason)) between 10 and 500),
  created_at timestamptz not null default now()
);
alter table public.nexora_payout_admin_events drop constraint if exists nexora_payout_admin_events_action_check;
alter table public.nexora_payout_admin_events add constraint nexora_payout_admin_events_action_check
  check (action in ('approved','rejected','dispatch_started','reconciled'));
create index if not exists nexora_payout_admin_events_payout_time
  on public.nexora_payout_admin_events(payout_id,created_at desc);
alter table public.nexora_payout_admin_events enable row level security;
revoke all on public.nexora_payout_admin_events from public,anon,authenticated,service_role;
grant select on public.nexora_payout_admin_events to service_role;
drop trigger if exists nexora_payout_admin_events_immutable on public.nexora_payout_admin_events;
create trigger nexora_payout_admin_events_immutable
  before update or delete on public.nexora_payout_admin_events
  for each row execute function public.nexora_ledger_reject_mutation();

drop function if exists public.nexora_payout_admin_list(uuid,integer);
create or replace function public.nexora_payout_admin_list(p_actor_id uuid,p_limit integer default 100)
returns table(
  payout_id uuid,business_id uuid,business_name text,merchant_email text,
  amount_cents bigint,status text,provider_code text,adapter_code text,created_at timestamptz,
  updated_at timestamptz,provider_batch_id text,provider_transfer_id text,external_reference text
)
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role'
     or p_actor_id is null or not exists(
       select 1 from public.nexora_admins a join auth.users u
         on lower(trim(u.email))=lower(trim(a.email))
       where u.id=p_actor_id and a.role='super_admin'
         and public.nexora_account_active(p_actor_id)
     ) then raise exception 'MFA Super Admin session required.'; end if;
  if p_limit is null or p_limit not between 1 and 200 then raise exception 'Invalid payout page size.'; end if;
  return query
    select p.id,p.business_id,b.name::text,u.email::text,p.amount_cents,p.status::text,p.provider_code::text,p.adapter_code::text,
      p.created_at,p.updated_at,p.provider_batch_id::text,p.provider_transfer_id::text,p.external_reference::text
    from public.nexora_payouts p
    join public.businesses b on b.id=p.business_id and b.owner_id=p.owner_id
    join auth.users u on u.id=p.owner_id
    order by p.created_at desc,p.id desc limit p_limit;
end;
$$;
revoke all on function public.nexora_payout_admin_list(uuid,integer) from public,anon,authenticated;
grant execute on function public.nexora_payout_admin_list(uuid,integer) to service_role;

create or replace function public.nexora_payout_admin_review(
  p_actor_id uuid,p_payout_id uuid,p_decision text,p_reason text,p_request_sha256 text
)
returns text language plpgsql security definer set search_path = '' as $$
declare v_payout public.nexora_payouts; v_status text; v_action text;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role'
     or p_actor_id is null or not exists(
       select 1 from public.nexora_admins a join auth.users u
         on lower(trim(u.email))=lower(trim(a.email))
       where u.id=p_actor_id and a.role='super_admin'
         and public.nexora_account_active(p_actor_id)
     ) then raise exception 'MFA Super Admin session required.'; end if;
  if p_payout_id is null or p_decision is null or p_decision not in ('approve','reject')
     or p_reason is null or length(trim(p_reason)) not between 10 and 500
     or p_request_sha256 is null or p_request_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid payout review.';
  end if;
  select * into v_payout from public.nexora_payouts p where p.id=p_payout_id for update;
  if not found then raise exception 'Payout request not found.'; end if;
  v_action:=case when p_decision='approve' then 'approved' else 'rejected' end;
  if (p_decision='approve' and v_payout.status='APPROVED')
     or (p_decision='reject' and v_payout.status='REJECTED') then return v_payout.status; end if;
  if v_payout.status not in ('RESERVED','APPROVED')
     or (p_decision='approve' and v_payout.status<>'RESERVED')
     or v_payout.provider_transfer_id is not null or v_payout.provider_batch_id is not null then
    raise exception 'Payout is no longer awaiting administrative review.';
  end if;
  v_status:=case when p_decision='approve' then 'APPROVED' else 'REJECTED' end;
  if p_decision='reject' then
    perform public.nexora_ledger_post_journal(
      v_payout.owner_id,v_payout.business_id,null,'payout.rejected',
      'payout.rejected:'||v_payout.id::text,p_request_sha256,
      'Reserved funds released after administrative payout rejection.',
      jsonb_build_array(
        jsonb_build_object('account_code','merchant_reserved','side','debit','amount_cents',v_payout.amount_cents),
        jsonb_build_object('account_code','merchant_available','side','credit','amount_cents',v_payout.amount_cents)
      ),jsonb_build_object('payout_id',v_payout.id,'review_actor_id',p_actor_id)
    );
  end if;
  update public.nexora_payouts set status=v_status,
    failure_code=case when p_decision='reject' then 'admin_rejected' else null end,updated_at=now()
    where id=v_payout.id;
  insert into public.nexora_payout_admin_events(payout_id,actor_id,action,from_status,to_status,reason)
    values(v_payout.id,p_actor_id,v_action,v_payout.status,v_status,trim(p_reason));
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(p_actor_id,'payout.admin_'||v_action,v_payout.id::text,
      jsonb_build_object('business_id',v_payout.business_id,'amount_cents',v_payout.amount_cents,
        'from_status',v_payout.status,'to_status',v_status,'reason',trim(p_reason)));
  return v_status;
end;
$$;
revoke all on function public.nexora_payout_admin_review(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.nexora_payout_admin_review(uuid,uuid,text,text,text) to service_role;

-- Reconciliation is a read-only provider GET followed by this atomic,
-- idempotent status write + operator audit record. It never sends a payout.
create or replace function public.nexora_payout_admin_reconcile_event(
  p_actor_id uuid,p_payout_id uuid,p_reason text,p_provider_code text,
  p_provider_event_id text,p_provider_event_type text,p_provider_batch_id text,
  p_provider_transfer_id text,p_raw_provider_status text,p_normalized_status text,
  p_amount_cents bigint,p_payload_sha256 text
)
returns text language plpgsql security definer set search_path = '' as $$
declare v_payout public.nexora_payouts; v_status text;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role'
     or p_actor_id is null or not exists(
       select 1 from public.nexora_admins a join auth.users u
         on lower(trim(u.email))=lower(trim(a.email))
       where u.id=p_actor_id and a.role='super_admin'
         and public.nexora_account_active(p_actor_id)
     ) then raise exception 'MFA Super Admin session required.'; end if;
  if p_payout_id is null or p_reason is null or length(trim(p_reason)) not between 10 and 500 then
    raise exception 'Invalid payout reconciliation request.';
  end if;
  select * into v_payout from public.nexora_payouts p where p.id=p_payout_id for update;
  if not found or v_payout.status not in ('OUTCOME_UNKNOWN','PROCESSING','RISK_REVIEW') then
    raise exception 'Payout is not eligible for manual reconciliation.';
  end if;
  v_status:=public.nexora_payout_apply_provider_event(
    p_provider_code,v_payout.external_reference,p_provider_event_id,p_provider_event_type,
    p_provider_transfer_id,p_raw_provider_status,p_normalized_status,p_amount_cents,
    p_payload_sha256,p_provider_batch_id
  );
  insert into public.nexora_payout_admin_events(payout_id,actor_id,action,from_status,to_status,reason)
    values(v_payout.id,p_actor_id,'reconciled',v_payout.status,v_status,trim(p_reason));
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(p_actor_id,'payout.reconciled',v_payout.id::text,
      jsonb_build_object('business_id',v_payout.business_id,'amount_cents',v_payout.amount_cents,
        'provider_code',v_payout.provider_code,'provider_batch_id',p_provider_batch_id,
        'provider_transfer_id',p_provider_transfer_id,'from_status',v_payout.status,
        'to_status',v_status,'reason',trim(p_reason)));
  return v_status;
end;
$$;
revoke all on function public.nexora_payout_admin_reconcile_event(uuid,uuid,text,text,text,text,text,text,text,text,bigint,text) from public,anon,authenticated;
grant execute on function public.nexora_payout_admin_reconcile_event(uuid,uuid,text,text,text,text,text,text,text,text,bigint,text) to service_role;

-- Claim a separately approved payout exactly once before the provider POST.
-- OUTCOME_UNKNOWN is written first so a timeout can never cause an automatic
-- second transfer. The global and per-provider switches both default off.
create or replace function public.nexora_payout_dispatch_claim(
  p_actor_id uuid,p_payout_id uuid,p_reason text
)
returns table(payout_id uuid,status text)
language plpgsql security definer set search_path = '' as $$
declare v_payout public.nexora_payouts; v_enabled boolean;
  v_max_transfer bigint; v_daily_limit bigint; v_daily_used bigint;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role'
     or p_actor_id is null or not exists(
       select 1 from public.nexora_admins a join auth.users u
         on lower(trim(u.email))=lower(trim(a.email))
       where u.id=p_actor_id and a.role='super_admin'
         and public.nexora_account_active(p_actor_id)
     ) then raise exception 'MFA Super Admin session required.'; end if;
  if p_payout_id is null or p_reason is null or length(trim(p_reason)) not between 10 and 500 then
    raise exception 'Invalid payout dispatch request.';
  end if;
  select production_enabled into v_enabled from public.nexora_payout_runtime where id=true;
  if coalesce(v_enabled,false) is not true then raise exception 'Real payout dispatch is disabled.'; end if;
  select * into v_payout from public.nexora_payouts p where p.id=p_payout_id for update;
  if not found or v_payout.status<>'APPROVED' or v_payout.environment<>'production'
     or v_payout.provider_batch_id is not null or v_payout.provider_transfer_id is not null then
    raise exception 'Payout is not approved for its first dispatch.';
  end if;
  if not exists(select 1 from public.merchant_onboarding m
      where m.user_id=v_payout.owner_id and m.status='APPROVED')
     or not public.nexora_account_active(v_payout.owner_id) then
    raise exception 'Merchant is no longer approved and active.';
  end if;
  select round(c.max_transfer_amount*100)::bigint,round(c.daily_transfer_limit*100)::bigint
    into v_max_transfer,v_daily_limit from public.nexora_merchant_controls c
    where c.business_id=v_payout.business_id and c.owner_id=v_payout.owner_id and c.withdrawals_enabled
      and c.pix_out_enabled and not c.balance_movements_blocked
    for update;
  if not found or v_payout.amount_cents>v_max_transfer then
    raise exception 'Merchant withdrawal/Pix OUT controls or outgoing-movement freeze no longer allow this payout.';
  end if;
  select coalesce(sum(p.amount_cents),0)::bigint into v_daily_used
    from public.nexora_payouts p
    where p.business_id=v_payout.business_id
      and p.created_at >= (date_trunc('day',now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo')
      and p.status not in ('FAILED','CANCELLED','REJECTED');
  if v_daily_used>v_daily_limit then raise exception 'Current daily payout limit is exceeded.'; end if;
  if not exists(
    select 1 from public.nexora_payout_provider_adapters pa
    join public.nexora_payout_connector_catalog pc on pc.adapter_code=pa.adapter_code
      and pc.pix_out_supported and pc.implementation_ready
    join public.nexora_acquirers a on a.code=pa.provider_code and a.environment=pa.environment
      and a.id=v_payout.acquirer_id and a.status='enabled'
    join public.nexora_platform_provider_credentials k on k.id=v_payout.provider_credential_id
      and k.acquirer_id=a.id and k.environment=a.environment and k.status='active'
    where pa.provider_code=v_payout.provider_code and pa.adapter_code=v_payout.adapter_code
      and pa.environment=v_payout.environment and pa.pix_out_enabled and pa.adapter_ready and pa.status='enabled'
  ) then raise exception 'Approved payout route or credential is not enabled.'; end if;

  update public.nexora_payouts set status='OUTCOME_UNKNOWN',updated_at=now()
    where id=v_payout.id;
  insert into public.nexora_payout_admin_events(payout_id,actor_id,action,from_status,to_status,reason)
    values(v_payout.id,p_actor_id,'dispatch_started','APPROVED','OUTCOME_UNKNOWN',trim(p_reason));
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(p_actor_id,'payout.dispatch_started',v_payout.id::text,
      jsonb_build_object('business_id',v_payout.business_id,'amount_cents',v_payout.amount_cents,
        'provider_code',v_payout.provider_code,'adapter_code',v_payout.adapter_code,
        'external_reference',v_payout.external_reference,'reason',trim(p_reason)));
  return query select v_payout.id,'OUTCOME_UNKNOWN'::text;
end;
$$;
revoke all on function public.nexora_payout_dispatch_claim(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.nexora_payout_dispatch_claim(uuid,uuid,text) to service_role;

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
where n.nspname='public' and c.relname in ('nexora_payout_runtime','nexora_payout_connector_catalog','nexora_payout_provider_adapters','nexora_payouts','nexora_payout_provider_events','nexora_payout_admin_events')
order by c.relname;

select adapter_code,pix_out_supported,implementation_ready from public.nexora_payout_connector_catalog order by adapter_code;
select provider_code,environment,adapter_code,pix_out_enabled,adapter_ready,status
from public.nexora_payout_provider_adapters
order by provider_code,environment;

select p.proname as function_name,pg_get_function_identity_arguments(p.oid) as arguments,
  has_function_privilege('anon',p.oid,'EXECUTE') as anon_can_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_can_execute,
  has_function_privilege('service_role',p.oid,'EXECUTE') as service_role_can_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in (
  'nexora_payout_reserve','nexora_payout_merchant_list','nexora_payout_apply_provider_event',
  'nexora_payout_admin_list','nexora_payout_admin_review','nexora_payout_admin_reconcile_event',
  'nexora_payout_dispatch_claim'
)
order by p.proname;

-- Audited, idempotent movement of available merchant liabilities into and out
-- of the merchant_blocked ledger bucket. Full hold release only; no provider
-- transfer is created. Apply after nexora-production-ledger.sql and ledger
-- writer hardening.
begin;

do $$ begin
  if to_regclass('public.businesses') is null
     or to_regclass('public.nexora_admins') is null
     or to_regclass('public.nexora_audit_log') is null
     or to_regclass('public.nexora_ledger_accounts') is null
     or to_regclass('public.nexora_ledger_journals') is null
     or to_regclass('public.nexora_ledger_entries') is null
     or to_regprocedure('public.nexora_account_active(uuid)') is null
     or to_regprocedure('public.nexora_ledger_reject_mutation()') is null
     or to_regprocedure('public.nexora_ledger_request_matches(uuid,text,jsonb)') is null
     or to_regprocedure('public.nexora_ledger_post_journal(uuid,uuid,uuid,text,text,text,text,jsonb,jsonb)') is null then
    raise exception 'Apply merchant access, audit, production ledger, and ledger-writer migrations first.';
  end if;
end $$;

create table if not exists public.nexora_merchant_fund_holds (
  hold_id uuid primary key,
  owner_id uuid not null,
  business_id uuid not null,
  amount_cents bigint not null check(amount_cents>0),
  reason text not null check(length(reason) between 10 and 500),
  request_sha256 text not null check(request_sha256 ~ '^[a-f0-9]{64}$'),
  ledger_journal_id uuid not null unique,
  actor_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key(business_id,owner_id) references public.businesses(id,owner_id) on delete restrict,
  foreign key(ledger_journal_id,business_id,owner_id)
    references public.nexora_ledger_journals(id,business_id,owner_id) on delete restrict
);
create index if not exists nexora_merchant_fund_holds_business_date
  on public.nexora_merchant_fund_holds(business_id,created_at desc);

create table if not exists public.nexora_merchant_fund_hold_releases (
  release_id uuid primary key,
  hold_id uuid not null unique references public.nexora_merchant_fund_holds(hold_id) on delete restrict,
  owner_id uuid not null,
  business_id uuid not null,
  amount_cents bigint not null check(amount_cents>0),
  reason text not null check(length(reason) between 10 and 500),
  request_sha256 text not null check(request_sha256 ~ '^[a-f0-9]{64}$'),
  ledger_journal_id uuid not null unique,
  actor_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key(business_id,owner_id) references public.businesses(id,owner_id) on delete restrict,
  foreign key(ledger_journal_id,business_id,owner_id)
    references public.nexora_ledger_journals(id,business_id,owner_id) on delete restrict,
  unique(business_id,release_id)
);
create index if not exists nexora_merchant_fund_hold_releases_business_date
  on public.nexora_merchant_fund_hold_releases(business_id,created_at desc);

alter table public.nexora_merchant_fund_holds enable row level security;
alter table public.nexora_merchant_fund_hold_releases enable row level security;
revoke all on public.nexora_merchant_fund_holds,public.nexora_merchant_fund_hold_releases
  from public,anon,authenticated,service_role;
drop trigger if exists nexora_merchant_fund_holds_immutable on public.nexora_merchant_fund_holds;
create trigger nexora_merchant_fund_holds_immutable before update or delete
  on public.nexora_merchant_fund_holds for each row execute function public.nexora_ledger_reject_mutation();
drop trigger if exists nexora_merchant_fund_hold_releases_immutable on public.nexora_merchant_fund_hold_releases;
create trigger nexora_merchant_fund_hold_releases_immutable before update or delete
  on public.nexora_merchant_fund_hold_releases for each row execute function public.nexora_ledger_reject_mutation();

create or replace function public.nexora_admin_fund_hold_list(p_actor_id uuid,p_limit integer default 100)
returns table(
  hold_id uuid,business_id uuid,business_name text,merchant_email text,amount_cents bigint,
  reason text,created_at timestamptz,actor_id uuid,release_id uuid,release_reason text,
  released_at timestamptz,release_actor_id uuid,available_cents bigint,blocked_cents bigint
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' or p_actor_id is null
     or p_limit is null or p_limit not between 1 and 200
     or not exists(select 1 from public.nexora_admins a join auth.users u on u.id=a.user_id
       where a.user_id=p_actor_id and a.role='super_admin' and public.nexora_account_active(p_actor_id)) then
    raise exception 'Super Admin backend authorization required.';
  end if;
  return query
  select h.hold_id,h.business_id,b.name,u.email,h.amount_cents,h.reason,h.created_at,h.actor_id,
    r.release_id,r.reason,r.created_at,r.actor_id,
    coalesce(sum(case when a.account_code='merchant_available' then
      case e.side when 'credit' then e.amount_cents else -e.amount_cents end else 0 end),0)::bigint,
    coalesce(sum(case when a.account_code='merchant_blocked' then
      case e.side when 'credit' then e.amount_cents else -e.amount_cents end else 0 end),0)::bigint
  from public.nexora_merchant_fund_holds h
  join public.businesses b on b.id=h.business_id and b.owner_id=h.owner_id
  join auth.users u on u.id=h.owner_id
  left join public.nexora_merchant_fund_hold_releases r on r.hold_id=h.hold_id
  left join public.nexora_ledger_accounts a on a.business_id=h.business_id and a.owner_id=h.owner_id
    and a.account_code in ('merchant_available','merchant_blocked')
  left join public.nexora_ledger_entries e on e.account_id=a.id and e.business_id=h.business_id and e.owner_id=h.owner_id
  group by h.hold_id,b.name,u.email,r.release_id,r.reason,r.created_at,r.actor_id
  order by h.created_at desc limit p_limit;
end;
$$;

create or replace function public.nexora_admin_fund_hold_create(
  p_actor_id uuid,p_business_id uuid,p_hold_id uuid,p_amount_cents bigint,p_reason text,p_request_sha256 text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_existing public.nexora_merchant_fund_holds;
  v_available bigint;
  v_journal uuid;
  v_reason text:=trim(p_reason);
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' or p_actor_id is null
     or not exists(select 1 from public.nexora_admins a where a.user_id=p_actor_id
       and a.role='super_admin' and public.nexora_account_active(p_actor_id)) then
    raise exception 'Super Admin backend authorization required.';
  end if;
  if p_business_id is null or p_hold_id is null or p_amount_cents is null or p_amount_cents<=0
     or p_reason is null or length(v_reason) not between 10 and 500
     or p_request_sha256 is null or p_request_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid merchant funds hold request.';
  end if;
  select b.owner_id into v_owner from public.businesses b where b.id=p_business_id for update;
  if v_owner is null then raise exception 'Merchant workspace not found.'; end if;
  select * into v_existing from public.nexora_merchant_fund_holds h where h.hold_id=p_hold_id;
  if found then
    if v_existing.business_id<>p_business_id or v_existing.owner_id<>v_owner
      or v_existing.amount_cents<>p_amount_cents or v_existing.reason<>v_reason
      or v_existing.request_sha256<>p_request_sha256 or v_existing.actor_id<>p_actor_id then
      raise exception 'Idempotency key reused for a different hold.';
    end if;
    return jsonb_build_object('hold_id',v_existing.hold_id,'ledger_journal_id',v_existing.ledger_journal_id,
      'amount_cents',v_existing.amount_cents,'status',case when exists(select 1 from public.nexora_merchant_fund_hold_releases r where r.hold_id=v_existing.hold_id) then 'released' else 'active' end);
  end if;
  if not exists(select 1 from public.nexora_ledger_accounts a where a.business_id=p_business_id
      and a.owner_id=v_owner and a.account_code='merchant_available')
     or not exists(select 1 from public.nexora_ledger_accounts a where a.business_id=p_business_id
      and a.owner_id=v_owner and a.account_code='merchant_blocked') then
    raise exception 'Merchant balance buckets are not initialized.';
  end if;
  select coalesce(sum(case e.side when 'credit' then e.amount_cents else -e.amount_cents end),0)::bigint
    into v_available from public.nexora_ledger_entries e
    join public.nexora_ledger_accounts a on a.id=e.account_id
    where e.business_id=p_business_id and e.owner_id=v_owner and a.account_code='merchant_available';
  if p_amount_cents>v_available then raise exception 'Hold exceeds available merchant balance.'; end if;
  v_journal:=public.nexora_ledger_post_journal(v_owner,p_business_id,null,'merchant.funds_held',
    'fund-hold:'||p_hold_id::text,p_request_sha256,'Bloqueio de saldo disponível',
    jsonb_build_array(
      jsonb_build_object('account_code','merchant_available','side','debit','amount_cents',p_amount_cents),
      jsonb_build_object('account_code','merchant_blocked','side','credit','amount_cents',p_amount_cents)
    ),jsonb_build_object('hold_id',p_hold_id,'actor_id',p_actor_id,'reason',v_reason));
  insert into public.nexora_merchant_fund_holds(hold_id,owner_id,business_id,amount_cents,reason,request_sha256,ledger_journal_id,actor_id)
    values(p_hold_id,v_owner,p_business_id,p_amount_cents,v_reason,p_request_sha256,v_journal,p_actor_id);
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(p_actor_id,'merchant.funds_held',p_business_id::text,jsonb_build_object(
      'hold_id',p_hold_id,'amount_cents',p_amount_cents,'ledger_journal_id',v_journal,'reason',v_reason));
  return jsonb_build_object('hold_id',p_hold_id,'ledger_journal_id',v_journal,'amount_cents',p_amount_cents,'status','active');
end;
$$;

create or replace function public.nexora_admin_fund_hold_release(
  p_actor_id uuid,p_hold_id uuid,p_release_id uuid,p_reason text,p_request_sha256 text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_business uuid;
  v_hold public.nexora_merchant_fund_holds;
  v_existing public.nexora_merchant_fund_hold_releases;
  v_blocked bigint;
  v_journal uuid;
  v_reason text:=trim(p_reason);
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' or p_actor_id is null
     or not exists(select 1 from public.nexora_admins a where a.user_id=p_actor_id
       and a.role='super_admin' and public.nexora_account_active(p_actor_id)) then
    raise exception 'Super Admin backend authorization required.';
  end if;
  if p_hold_id is null or p_release_id is null or p_reason is null or length(v_reason) not between 10 and 500
     or p_request_sha256 is null or p_request_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid merchant funds release request.';
  end if;
  select h.owner_id,h.business_id into v_owner,v_business from public.nexora_merchant_fund_holds h
    where h.hold_id=p_hold_id;
  if v_business is null then raise exception 'Merchant funds hold not found.'; end if;
  perform 1 from public.businesses b where b.id=v_business and b.owner_id=v_owner for update;
  select * into v_hold from public.nexora_merchant_fund_holds h where h.hold_id=p_hold_id for update;
  select * into v_existing from public.nexora_merchant_fund_hold_releases r where r.release_id=p_release_id;
  if found then
    if v_existing.hold_id<>p_hold_id or v_existing.actor_id<>p_actor_id
      or v_existing.reason<>v_reason or v_existing.request_sha256<>p_request_sha256 then
      raise exception 'Idempotency key reused for a different hold release.';
    end if;
    return jsonb_build_object('hold_id',p_hold_id,'release_id',v_existing.release_id,
      'ledger_journal_id',v_existing.ledger_journal_id,'amount_cents',v_existing.amount_cents,'status','released');
  end if;
  if exists(select 1 from public.nexora_merchant_fund_hold_releases r where r.hold_id=p_hold_id) then
    raise exception 'Merchant funds hold is already released.';
  end if;
  select coalesce(sum(case e.side when 'credit' then e.amount_cents else -e.amount_cents end),0)::bigint
    into v_blocked from public.nexora_ledger_entries e
    join public.nexora_ledger_accounts a on a.id=e.account_id
    where e.business_id=v_business and e.owner_id=v_owner and a.account_code='merchant_blocked';
  if v_hold.amount_cents>v_blocked then raise exception 'Blocked ledger balance is below the hold amount.'; end if;
  v_journal:=public.nexora_ledger_post_journal(v_owner,v_business,null,'merchant.funds_released',
    'fund-release:'||p_release_id::text,p_request_sha256,'Liberação de saldo bloqueado',
    jsonb_build_array(
      jsonb_build_object('account_code','merchant_blocked','side','debit','amount_cents',v_hold.amount_cents),
      jsonb_build_object('account_code','merchant_available','side','credit','amount_cents',v_hold.amount_cents)
    ),jsonb_build_object('hold_id',p_hold_id,'release_id',p_release_id,'actor_id',p_actor_id,'reason',v_reason));
  insert into public.nexora_merchant_fund_hold_releases(release_id,hold_id,owner_id,business_id,amount_cents,reason,request_sha256,ledger_journal_id,actor_id)
    values(p_release_id,p_hold_id,v_owner,v_business,v_hold.amount_cents,v_reason,p_request_sha256,v_journal,p_actor_id);
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(p_actor_id,'merchant.funds_released',v_business::text,jsonb_build_object(
      'hold_id',p_hold_id,'release_id',p_release_id,'amount_cents',v_hold.amount_cents,
      'ledger_journal_id',v_journal,'reason',v_reason));
  return jsonb_build_object('hold_id',p_hold_id,'release_id',p_release_id,
    'ledger_journal_id',v_journal,'amount_cents',v_hold.amount_cents,'status','released');
end;
$$;

revoke all on function public.nexora_admin_fund_hold_list(uuid,integer) from public,anon,authenticated,service_role;
revoke all on function public.nexora_admin_fund_hold_create(uuid,uuid,uuid,bigint,text,text) from public,anon,authenticated,service_role;
revoke all on function public.nexora_admin_fund_hold_release(uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.nexora_admin_fund_hold_list(uuid,integer) to service_role;
grant execute on function public.nexora_admin_fund_hold_create(uuid,uuid,uuid,bigint,text,text) to service_role;
grant execute on function public.nexora_admin_fund_hold_release(uuid,uuid,uuid,text,text) to service_role;

notify pgrst,'reload schema';
commit;

select c.relname as table_name,c.relrowsecurity as rls_enabled,
  has_table_privilege('anon',c.oid,'SELECT') as anon_can_select,
  has_table_privilege('authenticated',c.oid,'SELECT') as authenticated_can_select,
  has_table_privilege('service_role',c.oid,'SELECT') as service_role_direct_select
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('nexora_merchant_fund_holds','nexora_merchant_fund_hold_releases')
order by c.relname;
select p.oid::regprocedure as function_name,
  has_function_privilege('anon',p.oid,'EXECUTE') as anon_can_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_can_execute,
  has_function_privilege('service_role',p.oid,'EXECUTE') as service_role_can_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('nexora_admin_fund_hold_list','nexora_admin_fund_hold_create','nexora_admin_fund_hold_release')
order by p.proname;

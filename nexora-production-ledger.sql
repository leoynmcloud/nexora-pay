-- Nexora Payment Core P0: production double-entry ledger foundation.
-- Additive only: this migration does not import legacy balances, post payments,
-- enable real withdrawals, or make any existing transaction withdrawable.
-- Run only after the current Nexora base/KYC/provider migrations.
begin;

do $$ begin
  if to_regclass('public.businesses') is null
     or to_regclass('public.nexora_transactions') is null
     or to_regprocedure('public.is_nexora_super_admin()') is null then
    raise exception 'Execute the Nexora base, transactions, and security migrations first.';
  end if;
end $$;

create unique index if not exists nexora_businesses_id_owner_id_unique
  on public.businesses(id,owner_id);

create table if not exists public.nexora_ledger_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  account_code text not null check (account_code ~ '^[a-z][a-z0-9:_-]{1,79}$'),
  account_class text not null check (account_class in ('asset','liability','income','expense')),
  currency text not null default 'BRL' check (currency = 'BRL'),
  created_at timestamptz not null default now(),
  unique (business_id, account_code),
  unique (id, business_id, owner_id),
  foreign key (business_id, owner_id) references public.businesses(id, owner_id) on delete cascade
);

create table if not exists public.nexora_ledger_journals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  business_id uuid not null references public.businesses(id) on delete restrict,
  transaction_id uuid references public.nexora_transactions(id) on delete restrict,
  event_code text not null check (event_code ~ '^[a-z][a-z0-9_.-]{2,99}$'),
  idempotency_key text not null check (length(idempotency_key) between 16 and 128),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  currency text not null default 'BRL' check (currency = 'BRL'),
  description text not null check (length(description) between 2 and 240),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  unique (business_id, idempotency_key),
  unique (id, business_id, owner_id),
  foreign key (business_id, owner_id) references public.businesses(id, owner_id) on delete restrict
);

create table if not exists public.nexora_ledger_entries (
  id bigint generated always as identity primary key,
  journal_id uuid not null,
  owner_id uuid not null,
  business_id uuid not null,
  account_id uuid not null,
  side text not null check (side in ('debit','credit')),
  amount_cents bigint not null check (amount_cents > 0),
  currency text not null default 'BRL' check (currency = 'BRL'),
  created_at timestamptz not null default now(),
  foreign key (journal_id, business_id, owner_id)
    references public.nexora_ledger_journals(id, business_id, owner_id) on delete restrict,
  foreign key (account_id, business_id, owner_id)
    references public.nexora_ledger_accounts(id, business_id, owner_id) on delete restrict
);

create index if not exists nexora_ledger_journals_business_date
  on public.nexora_ledger_journals(business_id, created_at desc);
create index if not exists nexora_ledger_journals_transaction
  on public.nexora_ledger_journals(transaction_id) where transaction_id is not null;
create index if not exists nexora_ledger_entries_account_date
  on public.nexora_ledger_entries(account_id, created_at desc);

alter table public.nexora_ledger_accounts enable row level security;
alter table public.nexora_ledger_journals enable row level security;
alter table public.nexora_ledger_entries enable row level security;
revoke all on public.nexora_ledger_accounts, public.nexora_ledger_journals, public.nexora_ledger_entries from public, anon, authenticated;
-- The service role reads the ledger but writes only through the validated
-- security-definer RPC. Direct INSERT could otherwise append entries to an old
-- journal after its deferred balance check has already completed.
grant select on public.nexora_ledger_accounts, public.nexora_ledger_journals, public.nexora_ledger_entries to service_role;
revoke insert, update, delete on public.nexora_ledger_accounts, public.nexora_ledger_journals, public.nexora_ledger_entries from service_role;
revoke usage, select on sequence public.nexora_ledger_entries_id_seq from service_role;

create or replace function public.nexora_ledger_reject_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Ledger rows are append-only; post a compensating journal instead.';
end;
$$;
revoke all on function public.nexora_ledger_reject_mutation() from public, anon, authenticated;

drop trigger if exists nexora_ledger_accounts_immutable on public.nexora_ledger_accounts;
create trigger nexora_ledger_accounts_immutable before update on public.nexora_ledger_accounts
for each row execute function public.nexora_ledger_reject_mutation();
drop trigger if exists nexora_ledger_journals_immutable on public.nexora_ledger_journals;
create trigger nexora_ledger_journals_immutable before update or delete on public.nexora_ledger_journals
for each row execute function public.nexora_ledger_reject_mutation();
drop trigger if exists nexora_ledger_entries_immutable on public.nexora_ledger_entries;
create trigger nexora_ledger_entries_immutable before update or delete on public.nexora_ledger_entries
for each row execute function public.nexora_ledger_reject_mutation();

create or replace function public.nexora_ledger_assert_balanced()
returns trigger language plpgsql set search_path = '' as $$
declare v_debits numeric; v_credits numeric; v_count integer;
begin
  select count(*), coalesce(sum(amount_cents) filter (where side='debit'),0),
         coalesce(sum(amount_cents) filter (where side='credit'),0)
    into v_count, v_debits, v_credits
    from public.nexora_ledger_entries where journal_id=new.id;
  if v_count < 2 or v_debits <> v_credits then
    raise exception 'Ledger journal must contain at least two balanced entries.';
  end if;
  return null;
end;
$$;
revoke all on function public.nexora_ledger_assert_balanced() from public, anon, authenticated;
drop trigger if exists nexora_ledger_journal_balanced on public.nexora_ledger_journals;
create constraint trigger nexora_ledger_journal_balanced
after insert on public.nexora_ledger_journals
deferrable initially deferred for each row execute function public.nexora_ledger_assert_balanced();

-- Internal bootstrap helper; direct execution is unavailable to clients.
create or replace function public.nexora_ledger_seed_business_accounts()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.nexora_ledger_accounts(owner_id,business_id,account_code,account_class)
  values
    (new.owner_id,new.id,'provider_clearing','asset'),
    (new.owner_id,new.id,'merchant_pending','liability'),
    (new.owner_id,new.id,'merchant_available','liability'),
    (new.owner_id,new.id,'merchant_reserved','liability'),
    (new.owner_id,new.id,'merchant_blocked','liability'),
    (new.owner_id,new.id,'platform_fee_revenue','income'),
    (new.owner_id,new.id,'provider_fee_expense','expense')
  on conflict (business_id,account_code) do nothing;
  return new;
end;
$$;
revoke all on function public.nexora_ledger_seed_business_accounts() from public, anon, authenticated;
drop trigger if exists nexora_ledger_seed_accounts_after_business on public.businesses;
create trigger nexora_ledger_seed_accounts_after_business
after insert on public.businesses for each row execute function public.nexora_ledger_seed_business_accounts();

insert into public.nexora_ledger_accounts(owner_id,business_id,account_code,account_class)
select b.owner_id,b.id,c.account_code,c.account_class
from public.businesses b
cross join (values
  ('provider_clearing','asset'),('merchant_pending','liability'),('merchant_available','liability'),
  ('merchant_reserved','liability'),('merchant_blocked','liability'),
  ('platform_fee_revenue','income'),('provider_fee_expense','expense')
) as c(account_code,account_class)
on conflict (business_id,account_code) do nothing;

-- Service-role-only atomic writer. A repeated key with the same intent returns
-- its original journal; reuse with different data fails closed.
create or replace function public.nexora_ledger_request_matches(
  p_journal_id uuid,p_description text,p_entries jsonb
)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((
    select j.description=trim(p_description)
      and (select coalesce(jsonb_agg(jsonb_build_object(
        'account_code',a.account_code,'side',e.side,'amount_cents',e.amount_cents
      ) order by a.account_code),'[]'::jsonb)
        from public.nexora_ledger_entries e
        join public.nexora_ledger_accounts a on a.id=e.account_id
        where e.journal_id=j.id)
      = (select coalesce(jsonb_agg(jsonb_build_object(
        'account_code',x.account_code,'side',x.side,'amount_cents',x.amount_cents
      ) order by x.account_code),'[]'::jsonb)
        from jsonb_to_recordset(p_entries) as x(account_code text,side text,amount_cents bigint))
    from public.nexora_ledger_journals j where j.id=p_journal_id
  ),false);
$$;
revoke all on function public.nexora_ledger_request_matches(uuid,text,jsonb) from public,anon,authenticated,service_role;

create or replace function public.nexora_ledger_post_journal(
  p_owner_id uuid, p_business_id uuid, p_transaction_id uuid, p_event_code text,
  p_idempotency_key text, p_request_hash text, p_description text,
  p_entries jsonb, p_metadata jsonb default '{}'::jsonb
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_journal public.nexora_ledger_journals;
  v_id uuid;
  v_count integer;
  v_debits numeric;
  v_credits numeric;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'Backend service role required.';
  end if;
  if p_owner_id is null or p_business_id is null
    or p_event_code is null or p_event_code !~ '^[a-z][a-z0-9_.-]{2,99}$'
    or p_idempotency_key is null or length(p_idempotency_key) not between 16 and 128
    or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
    or p_description is null or length(trim(p_description)) not between 2 and 240
    or p_entries is null or jsonb_typeof(p_entries) <> 'array'
    or jsonb_array_length(p_entries) not between 2 and 20
    or p_metadata is null or jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'Invalid ledger journal payload.';
  end if;
  if not exists(select 1 from public.businesses b where b.id=p_business_id and b.owner_id=p_owner_id) then
    raise exception 'Business owner mismatch.';
  end if;
  if p_transaction_id is not null and not exists(
    select 1 from public.nexora_transactions t
    where t.id=p_transaction_id and t.business_id=p_business_id and t.owner_id=p_owner_id
  ) then raise exception 'Transaction does not belong to this business.'; end if;

  if exists(
    select 1 from jsonb_to_recordset(p_entries) as x(account_code text, side text, amount_cents bigint)
    where x.account_code is null or x.account_code !~ '^[a-z][a-z0-9:_-]{1,79}$'
      or x.side is null or x.side not in ('debit','credit')
      or x.amount_cents is null or x.amount_cents <= 0
  ) then raise exception 'Invalid ledger entry.'; end if;
  select count(*), coalesce(sum(x.amount_cents) filter(where x.side='debit'),0),
         coalesce(sum(x.amount_cents) filter(where x.side='credit'),0)
    into v_count,v_debits,v_credits
    from jsonb_to_recordset(p_entries) as x(account_code text, side text, amount_cents bigint);
  if v_count < 2 or v_count > 20 or v_debits <> v_credits then
    raise exception 'Ledger journal is not balanced.';
  end if;
  if (select count(distinct x.account_code) from jsonb_to_recordset(p_entries) as x(account_code text, side text, amount_cents bigint))
      <> (select count(*) from jsonb_to_recordset(p_entries) as x(account_code text, side text, amount_cents bigint)) then
    raise exception 'Use one entry per account in a journal.';
  end if;
  if exists(
    select 1 from jsonb_to_recordset(p_entries) as x(account_code text, side text, amount_cents bigint)
    left join public.nexora_ledger_accounts a on a.business_id=p_business_id and a.owner_id=p_owner_id and a.account_code=x.account_code
    where a.id is null
  ) then raise exception 'Ledger account not initialized for this business.'; end if;

  select * into v_journal from public.nexora_ledger_journals
    where business_id=p_business_id and idempotency_key=p_idempotency_key for update;
  if found then
    if v_journal.request_hash <> p_request_hash or v_journal.transaction_id is distinct from p_transaction_id
      or v_journal.event_code <> p_event_code or v_journal.owner_id <> p_owner_id
      or not public.nexora_ledger_request_matches(v_journal.id,p_description,p_entries) then
      raise exception 'Idempotency key reused for a different journal.';
    end if;
    return v_journal.id;
  end if;

  insert into public.nexora_ledger_journals(owner_id,business_id,transaction_id,event_code,idempotency_key,request_hash,description,metadata)
  values(p_owner_id,p_business_id,p_transaction_id,p_event_code,p_idempotency_key,p_request_hash,trim(p_description),p_metadata)
  on conflict (business_id,idempotency_key) do nothing returning id into v_id;
  if v_id is null then
    select * into v_journal from public.nexora_ledger_journals
      where business_id=p_business_id and idempotency_key=p_idempotency_key;
    if v_journal.request_hash <> p_request_hash or v_journal.transaction_id is distinct from p_transaction_id
      or v_journal.event_code <> p_event_code or v_journal.owner_id <> p_owner_id
      or not public.nexora_ledger_request_matches(v_journal.id,p_description,p_entries) then
      raise exception 'Idempotency key reused for a different journal.';
    end if;
    return v_journal.id;
  end if;

  insert into public.nexora_ledger_entries(journal_id,owner_id,business_id,account_id,side,amount_cents)
  select v_id,p_owner_id,p_business_id,a.id,x.side,x.amount_cents
  from jsonb_to_recordset(p_entries) as x(account_code text, side text, amount_cents bigint)
  join public.nexora_ledger_accounts a
    on a.business_id=p_business_id and a.owner_id=p_owner_id and a.account_code=x.account_code;
  return v_id;
end;
$$;
revoke all on function public.nexora_ledger_post_journal(uuid,uuid,uuid,text,text,text,text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.nexora_ledger_post_journal(uuid,uuid,uuid,text,text,text,text,jsonb,jsonb) to service_role;

-- Merchant-facing read is limited to its own liability accounts. It is not a
-- withdrawable-balance authorization; payout must reserve funds atomically.
create or replace function public.nexora_ledger_merchant_balance(p_business_id uuid,p_account_code text)
returns numeric language plpgsql stable security definer set search_path = '' as $$
declare v_cents numeric;
begin
  if p_account_code not in ('merchant_pending','merchant_available','merchant_reserved','merchant_blocked')
    or auth.uid() is null then raise exception 'Unsupported account or unauthenticated request.'; end if;
  if not exists(select 1 from public.businesses b where b.id=p_business_id and b.owner_id=auth.uid()) then
    raise exception 'Workspace not found for current account.';
  end if;
  select coalesce(sum(case when e.side='credit' then e.amount_cents else -e.amount_cents end),0)
    into v_cents
    from public.nexora_ledger_entries e
    join public.nexora_ledger_accounts a on a.id=e.account_id
    where a.business_id=p_business_id and a.owner_id=auth.uid() and a.account_code=p_account_code;
  return v_cents / 100;
end;
$$;
revoke all on function public.nexora_ledger_merchant_balance(uuid,text) from public, anon;
grant execute on function public.nexora_ledger_merchant_balance(uuid,text) to authenticated;

notify pgrst, 'reload schema';
commit;

-- Validation: every returned row should have equal debit and credit totals.
select j.id,j.event_code,
  coalesce(sum(e.amount_cents) filter(where e.side='debit'),0) as debit_cents,
  coalesce(sum(e.amount_cents) filter(where e.side='credit'),0) as credit_cents
from public.nexora_ledger_journals j
left join public.nexora_ledger_entries e on e.journal_id=j.id
group by j.id,j.event_code
having coalesce(sum(e.amount_cents) filter(where e.side='debit'),0)
    <> coalesce(sum(e.amount_cents) filter(where e.side='credit'),0);

-- Must return zero rows: each workspace has its seven initialized core accounts.
select b.id as business_id,count(a.id) as account_count
from public.businesses b
left join public.nexora_ledger_accounts a on a.business_id=b.id and a.owner_id=b.owner_id
group by b.id
having count(a.id) <> 7;

-- RLS must be enabled, and authenticated users must not have direct DML access.
select c.relname as table_name,c.relrowsecurity as rls_enabled,
  has_table_privilege('authenticated','public.'||c.relname,'INSERT') as authenticated_can_insert,
  has_table_privilege('authenticated','public.'||c.relname,'UPDATE') as authenticated_can_update,
  has_table_privilege('authenticated','public.'||c.relname,'DELETE') as authenticated_can_delete
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('nexora_ledger_accounts','nexora_ledger_journals','nexora_ledger_entries')
order by c.relname;

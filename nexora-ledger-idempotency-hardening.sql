-- Additive hardening for an already-installed production ledger.
-- Same idempotency key/hash must also have the exact original description and entries.
begin;

do $$ begin
  if to_regclass('public.nexora_ledger_journals') is null
     or to_regclass('public.nexora_ledger_entries') is null
     or to_regclass('public.nexora_ledger_accounts') is null
     or to_regprocedure('public.nexora_ledger_post_journal(uuid,uuid,uuid,text,text,text,text,jsonb,jsonb)') is null then
    raise exception 'Apply nexora-production-ledger.sql before this hardening migration.';
  end if;
end $$;

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
revoke all on function public.nexora_ledger_post_journal(uuid,uuid,uuid,text,text,text,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.nexora_ledger_post_journal(uuid,uuid,uuid,text,text,text,text,jsonb,jsonb) to service_role;

notify pgrst,'reload schema';
commit;

select p.oid::regprocedure as function_name,
  has_function_privilege('anon',p.oid,'EXECUTE') as anon_can_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_can_execute,
  has_function_privilege('service_role',p.oid,'EXECUTE') as service_role_can_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('nexora_ledger_post_journal','nexora_ledger_request_matches')
order by p.proname;

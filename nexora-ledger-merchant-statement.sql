-- Read-only, keyset-paginated statement of merchant-facing ledger movements.
-- Apply after nexora-production-ledger.sql. No table access is granted to merchants.
begin;

do $$ begin
  if to_regclass('public.nexora_ledger_accounts') is null
     or to_regclass('public.nexora_ledger_journals') is null
     or to_regclass('public.nexora_ledger_entries') is null
     or to_regclass('public.businesses') is null then
    raise exception 'Apply nexora-production-ledger.sql before this migration.';
  end if;
end $$;

create or replace function public.nexora_ledger_merchant_statement(
  p_business_id uuid,
  p_before_created_at timestamptz default null,
  p_before_journal_id uuid default null,
  p_limit integer default 50
)
returns table(
  journal_id uuid,
  transaction_id uuid,
  event_code text,
  description text,
  created_at timestamptz,
  movements jsonb,
  has_more boolean
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
begin
  if v_owner is null or p_business_id is null
     or not exists(select 1 from public.businesses b where b.id=p_business_id and b.owner_id=v_owner) then
    raise exception 'Workspace not found for current account.';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'Page size must be between 1 and 100.';
  end if;
  if (p_before_created_at is null) <> (p_before_journal_id is null) then
    raise exception 'Both pagination cursor fields must be supplied together.';
  end if;

  return query
  with candidates as materialized (
    select j.id,j.transaction_id,j.event_code,j.description,j.created_at
    from public.nexora_ledger_journals j
    where j.business_id=p_business_id and j.owner_id=v_owner
      and (p_before_created_at is null or (j.created_at,j.id)<(p_before_created_at,p_before_journal_id))
      and exists (
        select 1 from public.nexora_ledger_entries e
        join public.nexora_ledger_accounts a on a.id=e.account_id
        where e.journal_id=j.id and e.business_id=p_business_id and e.owner_id=v_owner
          and a.business_id=p_business_id and a.owner_id=v_owner
          and a.account_code in ('merchant_available','merchant_pending','merchant_reserved','merchant_blocked')
      )
    order by j.created_at desc,j.id desc
    limit p_limit+1
  ), numbered as (
    select c.*,row_number() over(order by c.created_at desc,c.id desc) as row_number,
      count(*) over() as page_count
    from candidates c
  ), page as (
    select * from numbered where row_number<=p_limit
  )
  select p.id,p.transaction_id,p.event_code,p.description,p.created_at,
    (
      select coalesce(jsonb_agg(jsonb_build_object(
        'bucket',a.account_code,'side',e.side,'amount_cents',e.amount_cents
      ) order by a.account_code,e.side), '[]'::jsonb)
      from public.nexora_ledger_entries e
      join public.nexora_ledger_accounts a on a.id=e.account_id
      where e.journal_id=p.id and e.business_id=p_business_id and e.owner_id=v_owner
        and a.business_id=p_business_id and a.owner_id=v_owner
        and a.account_code in ('merchant_available','merchant_pending','merchant_reserved','merchant_blocked')
    ),
    p.page_count>p_limit
  from page p order by p.created_at desc,p.id desc;
end;
$$;

create index if not exists nexora_ledger_entries_journal_account
  on public.nexora_ledger_entries(journal_id,account_id) include (side,amount_cents);

revoke all on function public.nexora_ledger_merchant_statement(uuid,timestamptz,uuid,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.nexora_ledger_merchant_statement(uuid,timestamptz,uuid,integer)
  to authenticated;

notify pgrst,'reload schema';
commit;

select p.proname,
  has_function_privilege('anon',p.oid,'EXECUTE') as anon_can_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_can_execute,
  has_function_privilege('service_role',p.oid,'EXECUTE') as service_role_can_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname='nexora_ledger_merchant_statement';

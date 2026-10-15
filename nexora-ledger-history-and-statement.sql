-- ==============================================================================
-- Nexora Pay - Modelo de Saldo (#13) e Extrato do Ledger (#14)
-- ==============================================================================

begin;

-- 1. Histórico Diário do Saldo dos 4 Buckets (Requisito #13 - Modelo de Saldo)
drop function if exists public.nexora_ledger_merchant_balance_history(uuid,integer);

create or replace function public.nexora_ledger_merchant_balance_history(
  p_business_id uuid,
  p_days integer default 180
)
returns table(day date,available numeric,pending numeric,reserved numeric,blocked numeric)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_start date;
  v_start_at timestamptz;
  v_end_at timestamptz;
begin
  if v_owner is null or p_business_id is null
     or not exists(select 1 from public.businesses b where b.id=p_business_id and b.owner_id=v_owner) then
    raise exception 'Workspace not found for current account.';
  end if;
  if p_days is null or p_days not between 1 and 365 then
    raise exception 'History window must be between 1 and 365 days.';
  end if;

  v_start := v_today-(p_days-1);
  v_start_at := v_start::timestamp at time zone 'America/Sao_Paulo';
  v_end_at := (v_today+1)::timestamp at time zone 'America/Sao_Paulo';

  return query
  with dates as (
    select generate_series(v_start::timestamp,v_today::timestamp,interval '1 day')::date as day
  ), codes as (
    select unnest(array['merchant_available','merchant_pending','merchant_reserved','merchant_blocked']::text[]) as account_code
  ), opening as (
    select a.account_code,
      sum(case when e.side='credit' then e.amount_cents else -e.amount_cents end)::numeric as cents
    from public.nexora_ledger_accounts a
    join public.nexora_ledger_entries e on e.account_id=a.id
    where a.business_id=p_business_id and a.owner_id=v_owner
      and a.account_code in ('merchant_available','merchant_pending','merchant_reserved','merchant_blocked')
      and e.created_at<v_start_at
    group by a.account_code
  ), daily as (
    select (e.created_at at time zone 'America/Sao_Paulo')::date as day,
      a.account_code,
      sum(case when e.side='credit' then e.amount_cents else -e.amount_cents end)::numeric as cents
    from public.nexora_ledger_accounts a
    join public.nexora_ledger_entries e on e.account_id=a.id
    where a.business_id=p_business_id and a.owner_id=v_owner
      and a.account_code in ('merchant_available','merchant_pending','merchant_reserved','merchant_blocked')
      and e.created_at>=v_start_at and e.created_at<v_end_at
    group by (e.created_at at time zone 'America/Sao_Paulo')::date,a.account_code
  ), running as (
    select d.day,c.account_code,
      (coalesce(o.cents,0)+sum(coalesce(x.cents,0)) over (
        partition by c.account_code order by d.day rows between unbounded preceding and current row
      ))/100 as balance
    from dates d cross join codes c
    left join daily x on x.day=d.day and x.account_code=c.account_code
    left join opening o on o.account_code=c.account_code
  )
  select r.day,
    coalesce(max(r.balance) filter(where r.account_code='merchant_available'),0),
    coalesce(max(r.balance) filter(where r.account_code='merchant_pending'),0),
    coalesce(max(r.balance) filter(where r.account_code='merchant_reserved'),0),
    coalesce(max(r.balance) filter(where r.account_code='merchant_blocked'),0)
  from running r group by r.day order by r.day;
end;
$$;

revoke all on function public.nexora_ledger_merchant_balance_history(uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.nexora_ledger_merchant_balance_history(uuid,integer) to authenticated;

-- 2. Extrato Detalhado do Lojista via Ledger (Requisito #14 - Ledger Financeiro)
drop function if exists public.nexora_ledger_merchant_statement(uuid,timestamptz,uuid,integer);

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

revoke all on function public.nexora_ledger_merchant_statement(uuid,timestamptz,uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.nexora_ledger_merchant_statement(uuid,timestamptz,uuid,integer) to authenticated;

notify pgrst,'reload schema';
commit;

-- Consulta de confirmação:
select 'balance_history_rpc' as check_item, count(*)::text as result
from pg_proc where proname = 'nexora_ledger_merchant_balance_history'
union all
select 'statement_rpc', count(*)::text
from pg_proc where proname = 'nexora_ledger_merchant_statement'
union all
select 'ledger_balances_rpc', count(*)::text
from pg_proc where proname = 'nexora_ledger_merchant_balances'
union all
select 'ledger_entries_table_rls', relrowsecurity::text
from pg_class where relname = 'nexora_ledger_entries';

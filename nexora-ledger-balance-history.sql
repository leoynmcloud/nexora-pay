-- Historical merchant balances derived from immutable ledger entries.
-- Apply after nexora-ledger-balances-read.sql. Exposes only the caller's own workspace.
begin;

do $$ begin
  if to_regclass('public.nexora_ledger_accounts') is null
     or to_regclass('public.nexora_ledger_entries') is null
     or to_regclass('public.businesses') is null
     or to_regprocedure('public.nexora_ledger_merchant_balances(uuid)') is null then
    raise exception 'Apply nexora-production-ledger.sql and nexora-ledger-balances-read.sql first.';
  end if;
end $$;

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

revoke all on function public.nexora_ledger_merchant_balance_history(uuid,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.nexora_ledger_merchant_balance_history(uuid,integer) to authenticated;
notify pgrst,'reload schema';
commit;

select p.proname,
  has_function_privilege('anon',p.oid,'EXECUTE') as anon_can_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_can_execute,
  has_function_privilege('service_role',p.oid,'EXECUTE') as service_role_can_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname='nexora_ledger_merchant_balance_history';

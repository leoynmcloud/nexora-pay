-- Merchant-safe read model for the production ledger.
-- Run after nexora-production-ledger.sql; this does not make funds withdrawable.
begin;

do $$ begin
  if to_regclass('public.nexora_ledger_accounts') is null
     or to_regclass('public.nexora_ledger_entries') is null then
    raise exception 'Execute nexora-production-ledger.sql before this read-model migration.';
  end if;
end $$;

create or replace function public.nexora_ledger_merchant_balances(p_business_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_balances jsonb;
begin
  if auth.uid() is null or p_business_id is null
    or not exists(select 1 from public.businesses b where b.id=p_business_id and b.owner_id=auth.uid()) then
    raise exception 'Workspace not found for current account.';
  end if;

  select jsonb_build_object(
    'available', coalesce(sum(case when a.account_code='merchant_available'
      then case when e.side='credit' then e.amount_cents else -e.amount_cents end else 0 end),0)::numeric / 100,
    'pending', coalesce(sum(case when a.account_code='merchant_pending'
      then case when e.side='credit' then e.amount_cents else -e.amount_cents end else 0 end),0)::numeric / 100,
    'reserved', coalesce(sum(case when a.account_code='merchant_reserved'
      then case when e.side='credit' then e.amount_cents else -e.amount_cents end else 0 end),0)::numeric / 100,
    'blocked', coalesce(sum(case when a.account_code='merchant_blocked'
      then case when e.side='credit' then e.amount_cents else -e.amount_cents end else 0 end),0)::numeric / 100,
    'currency','BRL'
  ) into v_balances
  from public.nexora_ledger_accounts a
  left join public.nexora_ledger_entries e on e.account_id=a.id
  where a.business_id=p_business_id and a.owner_id=auth.uid()
    and a.account_code in ('merchant_available','merchant_pending','merchant_reserved','merchant_blocked');

  return coalesce(v_balances, jsonb_build_object('available',0,'pending',0,'reserved',0,'blocked',0,'currency','BRL'));
end;
$$;

revoke all on function public.nexora_ledger_merchant_balances(uuid) from public,anon;
grant execute on function public.nexora_ledger_merchant_balances(uuid) to authenticated;
notify pgrst,'reload schema';
commit;

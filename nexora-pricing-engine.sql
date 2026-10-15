-- Merchant/provider/method-specific, versioned pricing. No existing sale is
-- recalculated, no default fee is assumed, and no payout is enabled.
-- Run after nexora-repair.sql, nexora-onboarding-kyc.sql and the acquirer setup.
begin;
do $$ begin
  if to_regclass('public.nexora_transactions') is null
     or to_regclass('public.nexora_acquirers') is null
     or to_regclass('public.nexora_merchant_provider_connections') is null
     or to_regclass('public.nexora_audit_log') is null
     or to_regprocedure('public.is_nexora_super_admin()') is null then
    raise exception 'Execute as migrações de transações, adquirentes e segurança antes do pricing.';
  end if;
end $$;

create unique index if not exists nexora_businesses_id_owner_id_unique
  on public.businesses(id,owner_id);
create unique index if not exists nexora_transactions_id_business_owner_unique
  on public.nexora_transactions(id,business_id,owner_id);

create table if not exists public.nexora_pricing_rules (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  owner_id uuid not null,
  acquirer_id uuid not null references public.nexora_acquirers(id) on delete restrict,
  payment_method text not null check (payment_method in ('pix','credit_card','debit_card','boleto')),
  fixed_fee_cents bigint not null check (fixed_fee_cents >= 0 and fixed_fee_cents <= 100000000),
  variable_fee_bps integer not null check (variable_fee_bps between 0 and 10000),
  effective_from timestamptz not null,
  reason text not null check (length(trim(reason)) between 10 and 240),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key (business_id,owner_id) references public.businesses(id,owner_id) on delete restrict,
  unique (business_id,acquirer_id,payment_method,effective_from)
);
create index if not exists nexora_pricing_rule_lookup
  on public.nexora_pricing_rules(business_id,acquirer_id,payment_method,effective_from desc);

create table if not exists public.nexora_applied_pricing (
  transaction_id uuid primary key,
  business_id uuid not null,
  owner_id uuid not null,
  rule_id uuid not null references public.nexora_pricing_rules(id) on delete restrict,
  acquirer_id uuid not null references public.nexora_acquirers(id) on delete restrict,
  payment_method text not null,
  gross_amount_cents bigint not null check (gross_amount_cents > 0),
  fixed_fee_cents bigint not null check (fixed_fee_cents >= 0),
  variable_fee_bps integer not null check (variable_fee_bps between 0 and 10000),
  merchant_fee_cents bigint not null check (merchant_fee_cents >= 0),
  merchant_net_cents bigint not null check (merchant_net_cents > 0),
  applied_at timestamptz not null default now(),
  foreign key (transaction_id,business_id,owner_id)
    references public.nexora_transactions(id,business_id,owner_id) on delete restrict,
  check (merchant_net_cents=gross_amount_cents-merchant_fee_cents)
);
create index if not exists nexora_applied_pricing_business_date
  on public.nexora_applied_pricing(business_id,applied_at desc);

alter table public.nexora_pricing_rules enable row level security;
alter table public.nexora_applied_pricing enable row level security;
revoke all on public.nexora_pricing_rules,public.nexora_applied_pricing from public,anon,authenticated;
grant select on public.nexora_pricing_rules,public.nexora_applied_pricing to service_role;

create or replace function public.nexora_pricing_reject_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Pricing history is immutable; create a new rule instead.';
end;
$$;
revoke all on function public.nexora_pricing_reject_mutation() from public,anon,authenticated;
drop trigger if exists nexora_pricing_rules_immutable on public.nexora_pricing_rules;
create trigger nexora_pricing_rules_immutable before update or delete on public.nexora_pricing_rules
  for each row execute function public.nexora_pricing_reject_mutation();
drop trigger if exists nexora_applied_pricing_immutable on public.nexora_applied_pricing;
create trigger nexora_applied_pricing_immutable before update or delete on public.nexora_applied_pricing
  for each row execute function public.nexora_pricing_reject_mutation();

-- The existing MFA-protected super-admin predicate controls rule creation.
-- New versions can be scheduled for the present/future, never backdated over
-- already-created sales. Prior versions remain immutable for audit.
create or replace function public.nexora_admin_add_pricing_rule(
  p_business_id uuid,p_acquirer_id uuid,p_payment_method text,
  p_fixed_fee_cents bigint,p_variable_fee_bps integer,
  p_effective_from timestamptz,p_reason text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_id uuid;
begin
  if not public.is_nexora_super_admin() then raise exception 'MFA administrativo obrigatório.'; end if;
  if p_business_id is null or p_acquirer_id is null or p_payment_method is null
    or p_payment_method not in ('pix','credit_card','debit_card','boleto')
    or p_fixed_fee_cents is null or p_fixed_fee_cents not between 0 and 100000000
    or p_variable_fee_bps is null or p_variable_fee_bps not between 0 and 10000
    or p_effective_from is null or p_effective_from < now()
    or length(trim(coalesce(p_reason,''))) not between 10 and 240 then
    raise exception 'Parâmetros da regra de tarifa inválidos.';
  end if;
  select b.owner_id into v_owner from public.businesses b where b.id=p_business_id;
  if v_owner is null then raise exception 'Workspace não encontrado.'; end if;
  if not exists(select 1 from public.nexora_acquirers a where a.id=p_acquirer_id
      and (case when p_payment_method in ('credit_card','debit_card') then 'card'
                else p_payment_method end)=any(a.payment_methods)
      and a.status='enabled')
    or not exists(select 1 from public.nexora_merchant_provider_connections c
      where c.business_id=p_business_id and c.owner_id=v_owner
        and c.acquirer_id=p_acquirer_id and c.status in ('pending','active')) then
    raise exception 'Adquirente ou método indisponível.';
  end if;
  insert into public.nexora_pricing_rules(business_id,owner_id,acquirer_id,payment_method,
    fixed_fee_cents,variable_fee_bps,effective_from,reason,created_by)
  values(p_business_id,v_owner,p_acquirer_id,p_payment_method,
    p_fixed_fee_cents,p_variable_fee_bps,p_effective_from,trim(p_reason),auth.uid())
  returning id into v_id;
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
  values(auth.uid(),'pricing.rule.created',v_id::text,
    jsonb_build_object('business_id',p_business_id,'acquirer_id',p_acquirer_id,
      'payment_method',p_payment_method,'fixed_fee_cents',p_fixed_fee_cents,
      'variable_fee_bps',p_variable_fee_bps,'effective_from',p_effective_from,'reason',trim(p_reason)));
  return v_id;
end;
$$;
revoke all on function public.nexora_admin_add_pricing_rule(uuid,uuid,text,bigint,integer,timestamptz,text)
  from public,anon;
grant execute on function public.nexora_admin_add_pricing_rule(uuid,uuid,text,bigint,integer,timestamptz,text)
  to authenticated;

-- Read-only view for the Super Admin pricing editor. It exposes no provider
-- credential and is scoped to the authenticated MFA-protected administrator.
create or replace function public.nexora_admin_pricing_rules(p_business_id uuid default null)
returns table(
  id uuid,business_id uuid,business_name text,acquirer_id uuid,acquirer_name text,
  payment_method text,fixed_fee_cents bigint,variable_fee_bps integer,
  effective_from timestamptz,reason text,created_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_nexora_super_admin() then
    raise exception 'Acesso restrito ao Painel Nexora Pay.';
  end if;
  return query
    select r.id,r.business_id,b.name,a.id,a.name,r.payment_method,
      r.fixed_fee_cents,r.variable_fee_bps,r.effective_from,r.reason,r.created_at
    from public.nexora_pricing_rules r
    join public.businesses b on b.id=r.business_id and b.owner_id=r.owner_id
    join public.nexora_acquirers a on a.id=r.acquirer_id
    where p_business_id is null or r.business_id=p_business_id
    order by r.effective_from desc,r.created_at desc
    limit 500;
end;
$$;
revoke all on function public.nexora_admin_pricing_rules(uuid) from public,anon;
grant execute on function public.nexora_admin_pricing_rules(uuid) to authenticated;

-- Call before the provider request, immediately after creating the internal
-- charge. A missing rule, stale route, non-cent amount or fee >= gross fails
-- closed. Repeated calls return the original immutable snapshot.
create or replace function public.nexora_pricing_apply(
  p_transaction_id uuid,p_business_id uuid,p_owner_id uuid,p_acquirer_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_transaction public.nexora_transactions;
  v_existing public.nexora_applied_pricing;
  v_rule public.nexora_pricing_rules;
  v_gross bigint;
  v_fee bigint;
  v_net bigint;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'Backend service role required.'; end if;
  select * into v_transaction from public.nexora_transactions
    where id=p_transaction_id and business_id=p_business_id and owner_id=p_owner_id for update;
  if not found or v_transaction.kind <> 'payment'
     or v_transaction.amount*100 <> round(v_transaction.amount*100) then
    raise exception 'Transação indisponível para pricing.';
  end if;
  if v_transaction.acquirer_id is distinct from p_acquirer_id
     or not exists(select 1 from public.nexora_acquirers a
       where a.id=p_acquirer_id and a.status='enabled'
         and a.environment=case when v_transaction.test_mode then 'sandbox' else 'production' end) then
    raise exception 'Adquirente ou ambiente não corresponde à transação.';
  end if;
  select * into v_existing from public.nexora_applied_pricing where transaction_id=p_transaction_id;
  if found then
    if v_existing.acquirer_id is distinct from p_acquirer_id
      or v_existing.business_id <> p_business_id or v_existing.owner_id <> p_owner_id
      or v_existing.payment_method <> v_transaction.payment_method
      or v_existing.gross_amount_cents <> (v_transaction.amount*100)::bigint then
      raise exception 'Pricing original pertence a outro contexto.';
    end if;
    return jsonb_build_object('rule_id',v_existing.rule_id,'gross_amount_cents',v_existing.gross_amount_cents,
      'merchant_fee_cents',v_existing.merchant_fee_cents,'merchant_net_cents',v_existing.merchant_net_cents);
  end if;
  if v_transaction.status not in ('pending','processing') then
    raise exception 'Transação concluída sem snapshot de pricing; requer revisão.';
  end if;
  if not exists(select 1 from public.nexora_merchant_provider_connections c
    where c.business_id=p_business_id and c.owner_id=p_owner_id
      and c.acquirer_id=p_acquirer_id and c.status='active') then
    raise exception 'Rota de adquirente inativa.';
  end if;
  select * into v_rule from public.nexora_pricing_rules r
    where r.business_id=p_business_id and r.owner_id=p_owner_id
      and r.acquirer_id=p_acquirer_id and r.payment_method=v_transaction.payment_method
      and r.effective_from <= v_transaction.created_at
    order by r.effective_from desc limit 1;
  if not found then raise exception 'Regra de tarifa não configurada para esta cobrança.'; end if;
  v_gross := (v_transaction.amount*100)::bigint;
  v_fee := v_rule.fixed_fee_cents
    + round(v_gross::numeric * v_rule.variable_fee_bps / 10000)::bigint;
  v_net := v_gross-v_fee;
  if v_fee < 0 or v_net <= 0 then raise exception 'Tarifa igual ou maior que o valor da cobrança.'; end if;
  insert into public.nexora_applied_pricing(transaction_id,business_id,owner_id,rule_id,acquirer_id,
    payment_method,gross_amount_cents,fixed_fee_cents,variable_fee_bps,merchant_fee_cents,merchant_net_cents)
  values(p_transaction_id,p_business_id,p_owner_id,v_rule.id,p_acquirer_id,
    v_transaction.payment_method,v_gross,v_rule.fixed_fee_cents,v_rule.variable_fee_bps,v_fee,v_net);
  return jsonb_build_object('rule_id',v_rule.id,'gross_amount_cents',v_gross,
    'merchant_fee_cents',v_fee,'merchant_net_cents',v_net);
end;
$$;
revoke all on function public.nexora_pricing_apply(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.nexora_pricing_apply(uuid,uuid,uuid,uuid) to service_role;

notify pgrst,'reload schema';
commit;

-- Expected: two RLS-enabled tables and no authenticated direct DML.
select c.relname as table_name,c.relrowsecurity as rls_enabled,
  has_table_privilege('authenticated',c.oid,'INSERT') as authenticated_can_insert,
  has_table_privilege('authenticated',c.oid,'UPDATE') as authenticated_can_update,
  has_table_privilege('authenticated',c.oid,'DELETE') as authenticated_can_delete
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('nexora_pricing_rules','nexora_applied_pricing')
order by c.relname;

-- Applies merchant holdback to the production settlement ledger.
-- Run only after nexora-onboarding-kyc.sql, nexora-merchant-api-keys.sql,
-- nexora-production-ledger.sql, nexora-reconciliation-foundation.sql and
-- nexora-reconciliation-service-role-hardening.sql.
-- This migration does not release payout funds or change existing journals.
begin;

do $$ begin
  if to_regclass('public.nexora_merchant_controls') is null
     or to_regclass('public.merchant_onboarding') is null
     or to_regclass('public.nexora_settlements') is null
     or to_regclass('public.nexora_audit_log') is null
     or to_regclass('public.nexora_ledger_journals') is null
     or to_regclass('public.nexora_reconciliation_runs') is null
     or to_regclass('public.nexora_reconciliation_items') is null
     or to_regclass('public.nexora_transactions') is null
     or to_regprocedure('public.nexora_ledger_post_journal(uuid,uuid,uuid,text,text,text,text,jsonb,jsonb)') is null
     or to_regprocedure('public.nexora_ledger_reject_mutation()') is null
     or not exists(select 1 from pg_trigger where tgrelid='public.nexora_settlements'::regclass
       and tgname='nexora_settlements_immutable' and not tgisinternal)
     or to_regprocedure('public.nexora_admin_set_merchant_controls(uuid,boolean,boolean,text,numeric,numeric,numeric,numeric)') is null
     or to_regprocedure('public.nexora_admin_set_merchant_controls(uuid,boolean,boolean,boolean,text,numeric,numeric,numeric,numeric)') is null
     or to_regprocedure('public.is_nexora_super_admin()') is null then
    raise exception 'Execute as migrations prévias de onboarding, API, ledger e reconciliação.';
  end if;
  if not exists(select 1 from pg_attribute where attrelid='public.nexora_merchant_controls'::regclass
       and attname='api_enabled' and not attisdropped)
     or not exists(select 1 from pg_attribute where attrelid='public.nexora_merchant_controls'::regclass
       and attname='reserve_percentage' and not attisdropped) then
    raise exception 'Execute nexora-merchant-api-keys.sql antes desta migration.';
  end if;
end $$;

-- Snapshot both the policy and its maturity date on every settlement. Existing
-- settlements are preserved as immediately available; no historical balance
-- is moved by this migration.
alter table public.nexora_merchant_controls
  add column if not exists pix_out_enabled boolean not null default false,
  add column if not exists balance_movements_blocked boolean not null default false,
  add column if not exists reserve_days smallint not null default 0
  check (reserve_days between 0 and 365);
do $$ declare v_legacy_policies integer; begin
  select count(*) into v_legacy_policies from public.nexora_merchant_controls
    where reserve_percentage>0 and reserve_days=0;
  if v_legacy_policies>0 then
    raise exception 'Existem % política(s) com reserva positiva sem prazo. Defina um prazo explícito de 1–365 dias antes de ativar o holdback.',v_legacy_policies;
  end if;
end $$;

alter table public.nexora_settlements
  add column if not exists reserve_percentage_applied numeric(5,2) not null default 0
    check (reserve_percentage_applied between 0 and 100),
  add column if not exists reserve_days_applied smallint not null default 0
    check (reserve_days_applied between 0 and 365),
  add column if not exists reserve_amount_cents bigint not null default 0
    check (reserve_amount_cents >= 0),
  add column if not exists available_amount_cents bigint;

-- The prior schema correctly rejects every settlement UPDATE. Temporarily
-- remove that trigger only inside this transaction so the new snapshot column
-- can be backfilled; table DDL holds the lock and the immutable guard is
-- restored before any data-plane operation can observe the migration.
drop trigger nexora_settlements_immutable on public.nexora_settlements;
update public.nexora_settlements
  set available_amount_cents=net_amount_cents
  where available_amount_cents is null;
create trigger nexora_settlements_immutable before update or delete on public.nexora_settlements
  for each row execute function public.nexora_ledger_reject_mutation();
alter table public.nexora_settlements
  alter column available_amount_cents set default 0,
  alter column available_amount_cents set not null,
  add column if not exists reserve_release_at timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid='public.nexora_settlements'::regclass
      and conname='nexora_settlement_holdback_amounts_check') then
    alter table public.nexora_settlements add constraint nexora_settlement_holdback_amounts_check
      check (available_amount_cents + reserve_amount_cents = net_amount_cents);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.nexora_settlements'::regclass
      and conname='nexora_settlement_holdback_policy_check') then
    alter table public.nexora_settlements add constraint nexora_settlement_holdback_policy_check
      check ((reserve_percentage_applied=0 and reserve_days_applied=0)
          or (reserve_percentage_applied>0 and reserve_days_applied between 1 and 365));
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.nexora_settlements'::regclass
      and conname='nexora_settlement_holdback_maturity_check') then
    alter table public.nexora_settlements add constraint nexora_settlement_holdback_maturity_check
      check ((reserve_amount_cents=0 and reserve_release_at is null)
          or (reserve_amount_cents>0 and reserve_release_at is not null));
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.nexora_merchant_controls'::regclass
      and conname='nexora_merchant_reserve_term_check') then
    alter table public.nexora_merchant_controls add constraint nexora_merchant_reserve_term_check
      check ((reserve_percentage=0 and reserve_days=0)
          or (reserve_percentage>0 and reserve_days between 1 and 365));
  end if;
end $$;

-- Immutable evidence that a dated reserve moved back to available balance.
create table if not exists public.nexora_settlement_reserve_releases (
  id uuid primary key default gen_random_uuid(),
  settlement_id uuid not null unique,
  transaction_id uuid not null,
  business_id uuid not null,
  owner_id uuid not null,
  amount_cents bigint not null check (amount_cents > 0),
  release_journal_id uuid not null unique references public.nexora_ledger_journals(id) on delete restrict,
  released_at timestamptz not null default now(),
  foreign key (settlement_id) references public.nexora_settlements(id) on delete restrict
);
create index if not exists nexora_reserve_releases_business_date
  on public.nexora_settlement_reserve_releases(business_id,released_at desc);

alter table public.nexora_settlement_reserve_releases enable row level security;
revoke all on public.nexora_settlement_reserve_releases from public,anon,authenticated,service_role;
drop trigger if exists nexora_settlement_reserve_releases_immutable on public.nexora_settlement_reserve_releases;
create trigger nexora_settlement_reserve_releases_immutable before update or delete
  on public.nexora_settlement_reserve_releases
  for each row execute function public.nexora_ledger_reject_mutation();

create or replace function public.nexora_assert_settlement_reserve_release()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_settlement public.nexora_settlements;
  v_journal public.nexora_ledger_journals;
  v_count integer;
  v_reserved_debit numeric;
  v_available_credit numeric;
begin
  select * into v_settlement from public.nexora_settlements where id=new.settlement_id;
  select * into v_journal from public.nexora_ledger_journals where id=new.release_journal_id;
  if v_settlement.id is null or v_journal.id is null
     or v_settlement.transaction_id<>new.transaction_id or v_settlement.business_id<>new.business_id
     or v_settlement.owner_id<>new.owner_id or v_settlement.reserve_amount_cents<>new.amount_cents
     or v_settlement.reserve_amount_cents<=0 or v_settlement.reserve_release_at is null
     or v_settlement.reserve_release_at>new.released_at
     or v_journal.transaction_id<>new.transaction_id or v_journal.business_id<>new.business_id
     or v_journal.owner_id<>new.owner_id or v_journal.event_code<>'reserve.released' then
    raise exception 'Reserve release does not match a matured settlement.';
  end if;
  select count(*),
    coalesce(sum(e.amount_cents) filter(where a.account_code='merchant_reserved' and e.side='debit'),0),
    coalesce(sum(e.amount_cents) filter(where a.account_code='merchant_available' and e.side='credit'),0)
    into v_count,v_reserved_debit,v_available_credit
  from public.nexora_ledger_entries e
  join public.nexora_ledger_accounts a on a.id=e.account_id
  where e.journal_id=new.release_journal_id;
  if v_count<>2 or v_reserved_debit<>new.amount_cents or v_available_credit<>new.amount_cents then
    raise exception 'Reserve release journal must debit and credit the same reserved amount.';
  end if;
  return new;
end;
$$;
revoke all on function public.nexora_assert_settlement_reserve_release() from public,anon,authenticated;
drop trigger if exists nexora_settlement_reserve_release_evidence on public.nexora_settlement_reserve_releases;
create trigger nexora_settlement_reserve_release_evidence
  before insert on public.nexora_settlement_reserve_releases
  for each row execute function public.nexora_assert_settlement_reserve_release();

-- Extend the settlement assertion to prove that the journal credits the exact
-- available and reserved amounts, and no other wallet amount.
create or replace function public.nexora_assert_settlement_evidence()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_item public.nexora_reconciliation_items;
  v_run public.nexora_reconciliation_runs;
  v_receivable public.nexora_receivables;
  v_journal public.nexora_ledger_journals;
  v_payment public.nexora_transactions;
  v_pricing public.nexora_applied_pricing;
  v_count integer;
  v_pending numeric;
  v_available numeric;
  v_reserved numeric;
  v_fee numeric;
  v_provider_fee_expense numeric;
  v_provider_clearing numeric;
begin
  select * into v_item from public.nexora_reconciliation_items where id=new.reconciliation_item_id;
  select * into v_run from public.nexora_reconciliation_runs where id=v_item.run_id;
  select * into v_receivable from public.nexora_receivables where id=new.receivable_id;
  select * into v_journal from public.nexora_ledger_journals where id=new.release_journal_id;
  select * into v_payment from public.nexora_transactions where id=new.transaction_id;
  select * into v_pricing from public.nexora_applied_pricing where transaction_id=new.transaction_id;
  if v_item.id is null or v_run.id is null or v_receivable.id is null
     or v_journal.id is null or v_payment.id is null or v_pricing.transaction_id is null
     or v_item.result <> 'matched' or not v_run.statement_complete or v_run.environment <> 'production'
     or v_payment.status <> 'paid' or v_payment.test_mode
     or v_item.transaction_id <> new.transaction_id or v_item.business_id <> new.business_id
     or v_item.owner_id <> new.owner_id or v_receivable.provider_code <> v_run.provider_code
     or v_receivable.provider_transaction_id <> v_item.provider_transaction_id
     or v_payment.provider_reference <> v_item.provider_transaction_id
     or round(v_payment.amount * 100)::bigint <> new.gross_amount_cents
     or v_receivable.gross_amount_cents <> new.gross_amount_cents
     or v_item.gross_amount_cents <> new.gross_amount_cents
     or v_item.merchant_fee_cents <> new.merchant_fee_cents
     or v_pricing.business_id <> new.business_id or v_pricing.owner_id <> new.owner_id
     or v_pricing.gross_amount_cents <> new.gross_amount_cents
     or v_pricing.merchant_fee_cents <> new.merchant_fee_cents
     or v_pricing.merchant_net_cents <> new.net_amount_cents
     or v_item.provider_fee_cents <> new.provider_fee_cents
     or v_item.expected_merchant_net_cents <> new.net_amount_cents
     or v_journal.transaction_id <> new.transaction_id or v_journal.business_id <> new.business_id
     or v_journal.owner_id <> new.owner_id or v_journal.event_code <> 'settlement.released'
     or new.reserve_percentage_applied <> round(new.reserve_percentage_applied,2)
     or new.reserve_amount_cents <> round(new.net_amount_cents*new.reserve_percentage_applied/100)::bigint
     or new.available_amount_cents <> new.net_amount_cents-new.reserve_amount_cents
     or (new.reserve_amount_cents=0 and new.reserve_release_at is not null)
     or (new.reserve_amount_cents>0 and (new.reserve_release_at is null
       or new.reserve_release_at<>new.created_at+make_interval(days=>new.reserve_days_applied))) then
    raise exception 'Settlement evidence or holdback does not match confirmed production payment.';
  end if;

  select count(*),
    coalesce(sum(e.amount_cents) filter(where a.account_code='merchant_pending' and e.side='debit'),0),
    coalesce(sum(e.amount_cents) filter(where a.account_code='merchant_available' and e.side='credit'),0),
    coalesce(sum(e.amount_cents) filter(where a.account_code='merchant_reserved' and e.side='credit'),0),
    coalesce(sum(e.amount_cents) filter(where a.account_code='platform_fee_revenue' and e.side='credit'),0),
    coalesce(sum(e.amount_cents) filter(where a.account_code='provider_fee_expense' and e.side='debit'),0),
    coalesce(sum(e.amount_cents) filter(where a.account_code='provider_clearing' and e.side='credit'),0)
    into v_count,v_pending,v_available,v_reserved,v_fee,v_provider_fee_expense,v_provider_clearing
  from public.nexora_ledger_entries e
  join public.nexora_ledger_accounts a on a.id=e.account_id
  where e.journal_id=new.release_journal_id;
  if v_count <> 1 + (case when new.available_amount_cents>0 then 1 else 0 end)
      + (case when new.reserve_amount_cents>0 then 1 else 0 end)
      + (case when new.merchant_fee_cents>0 then 1 else 0 end)
      + (case when new.provider_fee_cents>0 then 2 else 0 end)
     or v_pending <> new.gross_amount_cents
     or v_available <> new.available_amount_cents or v_reserved <> new.reserve_amount_cents
     or v_fee <> new.merchant_fee_cents
     or v_provider_fee_expense <> new.provider_fee_cents or v_provider_clearing <> new.provider_fee_cents then
    raise exception 'Settlement journal does not balance gross, fees, available balance and holdback.';
  end if;
  return new;
end;
$$;
revoke all on function public.nexora_assert_settlement_evidence() from public,anon,authenticated;
drop trigger if exists nexora_settlements_check_evidence on public.nexora_settlements;
create trigger nexora_settlements_check_evidence before insert on public.nexora_settlements
  for each row execute function public.nexora_assert_settlement_evidence();

-- Admin settings now store a holdback maturity term alongside the percentage.
-- The previous overloads are revoked so an old caller cannot save a positive
-- percentage while silently omitting its release term.
create or replace function public.nexora_admin_merchant_controls()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(auth.jwt()->>'aal','') <> 'aal2' or not public.is_nexora_super_admin() then
    raise exception 'Acesso administrativo com MFA obrigatório.';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'owner_id',b.owner_id,'business_id',b.id,'business_name',b.name,'email',u.email,
    'payments_enabled',coalesce(m.payments_enabled,true),'withdrawals_enabled',coalesce(m.withdrawals_enabled,true),
    'pix_out_enabled',coalesce(m.pix_out_enabled,false),
    'balance_movements_blocked',coalesce(m.balance_movements_blocked,false),
    'api_enabled',coalesce(m.api_enabled,false),'withdrawal_mode',coalesce(m.withdrawal_mode,'manual'),
    'max_transfer_amount',coalesce(m.max_transfer_amount,5000),'daily_transfer_limit',coalesce(m.daily_transfer_limit,20000),
    'alert_threshold_amount',coalesce(m.alert_threshold_amount,5000),'reserve_percentage',coalesce(m.reserve_percentage,0),
    'reserve_days',coalesce(m.reserve_days,0),'updated_at',m.updated_at) order by b.name)
    from public.businesses b join public.merchant_onboarding k on k.user_id=b.owner_id and k.status='APPROVED'
    join auth.users u on u.id=b.owner_id
    left join public.nexora_merchant_controls m on m.business_id=b.id and m.owner_id=b.owner_id),'[]'::jsonb);
end;
$$;
revoke all on function public.nexora_admin_merchant_controls() from public,anon,service_role;
grant execute on function public.nexora_admin_merchant_controls() to authenticated;

create or replace function public.nexora_admin_set_merchant_controls_v3(
  p_owner_id uuid,p_payments_enabled boolean,p_withdrawals_enabled boolean,p_api_enabled boolean,
  p_pix_out_enabled boolean,p_balance_movements_blocked boolean,
  p_withdrawal_mode text,p_max_transfer_amount numeric,p_daily_transfer_limit numeric,
  p_alert_threshold_amount numeric,p_reserve_percentage numeric,p_reserve_days smallint
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_business uuid;
  v_old jsonb;
  v_new jsonb;
begin
  if coalesce(auth.jwt()->>'aal','') <> 'aal2' or not public.is_nexora_super_admin() then
    raise exception 'Acesso administrativo com MFA obrigatório.';
  end if;
  if p_owner_id is null or p_payments_enabled is null or p_withdrawals_enabled is null or p_api_enabled is null
    or p_pix_out_enabled is null or p_balance_movements_blocked is null
    or p_withdrawal_mode not in ('manual','instant') or p_max_transfer_amount is null or p_max_transfer_amount<=0
    or p_daily_transfer_limit is null or p_daily_transfer_limit<=0 or p_alert_threshold_amount is null
    or p_alert_threshold_amount<=0 or p_reserve_percentage is null or p_reserve_percentage not between 0 and 100
    or p_reserve_percentage<>round(p_reserve_percentage,2)
    or p_reserve_days is null or p_reserve_days not between 0 and 365
    or (p_reserve_percentage=0 and p_reserve_days<>0)
    or (p_reserve_percentage>0 and p_reserve_days not between 1 and 365) then
    raise exception 'Controles, tarifa ou prazo de reserva inválidos.';
  end if;
  select id into v_business from public.businesses where owner_id=p_owner_id order by id limit 1 for update;
  if v_business is null then raise exception 'Workspace do merchant não encontrado.'; end if;
  select to_jsonb(m) into v_old from public.nexora_merchant_controls m
    where m.business_id=v_business and m.owner_id=p_owner_id;
  insert into public.nexora_merchant_controls(
    business_id,owner_id,payments_enabled,withdrawals_enabled,api_enabled,pix_out_enabled,balance_movements_blocked,withdrawal_mode,
    max_transfer_amount,daily_transfer_limit,alert_threshold_amount,reserve_percentage,reserve_days,updated_by
  ) values (
    v_business,p_owner_id,p_payments_enabled,p_withdrawals_enabled,p_api_enabled,p_pix_out_enabled,p_balance_movements_blocked,p_withdrawal_mode,
    p_max_transfer_amount,p_daily_transfer_limit,p_alert_threshold_amount,p_reserve_percentage,p_reserve_days,auth.uid()
  ) on conflict(business_id) do update set payments_enabled=excluded.payments_enabled,
    withdrawals_enabled=excluded.withdrawals_enabled,api_enabled=excluded.api_enabled,
    pix_out_enabled=excluded.pix_out_enabled,balance_movements_blocked=excluded.balance_movements_blocked,
    withdrawal_mode=excluded.withdrawal_mode,max_transfer_amount=excluded.max_transfer_amount,
    daily_transfer_limit=excluded.daily_transfer_limit,alert_threshold_amount=excluded.alert_threshold_amount,
    reserve_percentage=excluded.reserve_percentage,reserve_days=excluded.reserve_days,
    updated_by=auth.uid(),updated_at=now();
  select to_jsonb(m) into v_new from public.nexora_merchant_controls m where m.business_id=v_business;
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(auth.uid(),'merchant.controls_updated',p_owner_id::text,
      jsonb_build_object('before',v_old,'after',v_new,'business_id',v_business));
end;
$$;
revoke all on function public.nexora_admin_set_merchant_controls_v3(uuid,boolean,boolean,boolean,boolean,boolean,text,numeric,numeric,numeric,numeric,smallint)
  from public,anon,service_role;
grant execute on function public.nexora_admin_set_merchant_controls_v3(uuid,boolean,boolean,boolean,boolean,boolean,text,numeric,numeric,numeric,numeric,smallint)
  to authenticated;
revoke all on function public.nexora_admin_set_merchant_controls(uuid,boolean,boolean,text,numeric,numeric,numeric,numeric)
  from public,anon,authenticated,service_role;
revoke all on function public.nexora_admin_set_merchant_controls(uuid,boolean,boolean,boolean,text,numeric,numeric,numeric,numeric)
  from public,anon,authenticated,service_role;

-- Service-only, idempotent maturity transition: reserved liability moves to
-- available liability only after the snapshotted release time.
create or replace function public.nexora_settlement_release_reserve(
  p_settlement_id uuid,p_request_hash text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_settlement public.nexora_settlements;
  v_existing public.nexora_settlement_reserve_releases;
  v_journal_id uuid;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'Backend service role required.';
  end if;
  if p_settlement_id is null or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid reserve release request.';
  end if;
  select * into v_settlement from public.nexora_settlements where id=p_settlement_id for update;
  if not found then raise exception 'Settlement not found.'; end if;
  select * into v_existing from public.nexora_settlement_reserve_releases where settlement_id=p_settlement_id;
  if found then
    if v_existing.amount_cents<>v_settlement.reserve_amount_cents
       or v_existing.transaction_id<>v_settlement.transaction_id
       or v_existing.business_id<>v_settlement.business_id or v_existing.owner_id<>v_settlement.owner_id
       or not exists(select 1 from public.nexora_ledger_journals j
         where j.id=v_existing.release_journal_id and j.request_hash=p_request_hash
           and j.event_code='reserve.released' and j.transaction_id=v_settlement.transaction_id) then
      raise exception 'Reserve release idempotency key reused with different evidence.';
    end if;
    return v_existing.release_journal_id;
  end if;
  if v_settlement.reserve_amount_cents<=0 or v_settlement.reserve_release_at is null then
    raise exception 'Settlement has no matured reserve.';
  end if;
  if v_settlement.reserve_release_at>now() then raise exception 'Reserve has not matured.'; end if;

  v_journal_id := public.nexora_ledger_post_journal(
    v_settlement.owner_id,v_settlement.business_id,v_settlement.transaction_id,'reserve.released',
    'reserve.release:'||v_settlement.id::text,p_request_hash,
    'Prazo de reserva encerrado; valor liberado para saldo disponível.',
    jsonb_build_array(
      jsonb_build_object('account_code','merchant_reserved','side','debit','amount_cents',v_settlement.reserve_amount_cents),
      jsonb_build_object('account_code','merchant_available','side','credit','amount_cents',v_settlement.reserve_amount_cents)
    ),
    jsonb_build_object('settlement_id',v_settlement.id,'transaction_id',v_settlement.transaction_id,
      'reserve_release_at',v_settlement.reserve_release_at,'reserve_amount_cents',v_settlement.reserve_amount_cents)
  );
  insert into public.nexora_settlement_reserve_releases(
    settlement_id,transaction_id,business_id,owner_id,amount_cents,release_journal_id
  ) values (v_settlement.id,v_settlement.transaction_id,v_settlement.business_id,v_settlement.owner_id,
    v_settlement.reserve_amount_cents,v_journal_id);
  return v_journal_id;
end;
$$;
revoke all on function public.nexora_settlement_release_reserve(uuid,text) from public,anon,authenticated;
grant execute on function public.nexora_settlement_release_reserve(uuid,text) to service_role;

-- Backend candidate read for an Edge Function or scheduler. The RPC returns no
-- customer data and direct SELECT on the source tables stays revoked.
create or replace function public.nexora_settlement_matured_reserve_candidates(p_limit integer default 50)
returns table(settlement_id uuid,amount_cents bigint,reserve_release_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'Backend service role required.';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'Invalid matured reserve batch size.';
  end if;
  return query
    select s.id,s.reserve_amount_cents,s.reserve_release_at
    from public.nexora_settlements s
    left join public.nexora_settlement_reserve_releases r on r.settlement_id=s.id
    where s.reserve_amount_cents>0 and s.reserve_release_at<=now() and r.id is null
    order by s.reserve_release_at,s.id
    limit p_limit;
end;
$$;
revoke all on function public.nexora_settlement_matured_reserve_candidates(integer) from public,anon,authenticated;
grant execute on function public.nexora_settlement_matured_reserve_candidates(integer) to service_role;

-- Backend queue for exact, complete production comparisons that have not yet
-- posted a settlement. Final validation remains in nexora_settlement_release.
create or replace function public.nexora_reconciliation_settlement_candidates(
  p_run_id uuid default null,p_limit integer default 50
)
returns table(reconciliation_item_id uuid,transaction_id uuid,provider_transaction_id text,
  gross_amount_cents bigint,provider_fee_cents bigint,merchant_fee_cents bigint,merchant_net_cents bigint)
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'Backend service role required.';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'Invalid settlement batch size.';
  end if;
  return query
    select i.id,i.transaction_id,i.provider_transaction_id,i.gross_amount_cents,
      i.provider_fee_cents,i.merchant_fee_cents,i.expected_merchant_net_cents
    from public.nexora_reconciliation_items i
    join public.nexora_reconciliation_runs r on r.id=i.run_id
    join public.nexora_transactions t on t.id=i.transaction_id
      and t.business_id=i.business_id and t.owner_id=i.owner_id
    where (p_run_id is null or i.run_id=p_run_id)
      and i.result='matched' and i.issues='[]'::jsonb
      and r.statement_complete and r.environment='production'
      and t.status='paid' and not t.test_mode
      and t.provider_reference=i.provider_transaction_id
      and i.provider_credit_cents=i.gross_amount_cents
      and i.provider_fee_cents=i.expected_provider_fee_cents
      and i.expected_merchant_net_cents=i.gross_amount_cents-i.merchant_fee_cents
      and not exists(select 1 from public.nexora_settlements s
        where s.reconciliation_item_id=i.id or s.transaction_id=i.transaction_id)
    order by i.created_at,i.id
    limit p_limit;
end;
$$;
revoke all on function public.nexora_reconciliation_settlement_candidates(uuid,integer) from public,anon,authenticated;
grant execute on function public.nexora_reconciliation_settlement_candidates(uuid,integer) to service_role;

-- Settlement policy is locked and snapshotted at the same time as the
-- receivable/journal. A future policy edit cannot rewrite a prior sale.
create or replace function public.nexora_settlement_release(
  p_reconciliation_item_id uuid,p_request_hash text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_item public.nexora_reconciliation_items;
  v_run public.nexora_reconciliation_runs;
  v_payment public.nexora_transactions;
  v_pricing public.nexora_applied_pricing;
  v_controls public.nexora_merchant_controls;
  v_receivable public.nexora_receivables;
  v_existing public.nexora_settlements;
  v_journal_id uuid;
  v_settlement_id uuid;
  v_receipt_journal_id uuid;
  v_receipt_journal_count bigint;
  v_receipt_entry_count bigint;
  v_pending_credit numeric;
  v_provider_clearing_debit numeric;
  v_net bigint;
  v_reserved bigint;
  v_available bigint;
  v_percentage numeric(5,2) := 0;
  v_days smallint := 0;
  v_release_at timestamptz;
  v_entries jsonb;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'Backend service role required.';
  end if;
  if p_reconciliation_item_id is null or p_request_hash is null
     or p_request_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid settlement request.';
  end if;

  select * into v_item from public.nexora_reconciliation_items
    where id=p_reconciliation_item_id for update;
  if not found then raise exception 'Reconciliation item not found.'; end if;
  select * into v_run from public.nexora_reconciliation_runs where id=v_item.run_id;
  select * into v_payment from public.nexora_transactions
    where id=v_item.transaction_id and business_id=v_item.business_id and owner_id=v_item.owner_id for update;
  select * into v_pricing from public.nexora_applied_pricing where transaction_id=v_item.transaction_id;
  if v_item.result <> 'matched' or v_item.issues <> '[]'::jsonb
     or v_run.id is null or not v_run.statement_complete or v_run.environment <> 'production'
     or v_payment.id is null or v_payment.status <> 'paid' or v_payment.test_mode
     or v_payment.payment_method <> 'pix' or v_payment.provider_reference <> v_item.provider_transaction_id
     or v_pricing.transaction_id is null or v_pricing.business_id <> v_item.business_id
     or v_pricing.owner_id <> v_item.owner_id or v_pricing.acquirer_id is distinct from v_payment.acquirer_id
     or not exists(select 1 from public.nexora_acquirers a
       where a.id=v_payment.acquirer_id and a.environment=v_run.environment
         and (a.code=v_run.provider_code
           or left(a.code,length(v_run.provider_code)+1)=v_run.provider_code||'_'))
     or v_pricing.gross_amount_cents <> v_item.gross_amount_cents
     or v_pricing.merchant_fee_cents <> v_item.merchant_fee_cents
     or v_pricing.merchant_net_cents <> v_item.expected_merchant_net_cents
     or v_item.provider_credit_cents <> v_item.gross_amount_cents
     or v_item.provider_fee_cents <> v_item.expected_provider_fee_cents
     or v_item.expected_merchant_net_cents <> v_item.gross_amount_cents-v_item.merchant_fee_cents
     or v_item.gross_amount_cents <> round(v_payment.amount*100)::bigint
     or v_item.provider_transaction_id is distinct from v_payment.provider_reference then
    raise exception 'Settlement requires exact, complete production evidence and a valid pricing snapshot.';
  end if;
  if v_item.merchant_fee_cents < 0 or v_item.merchant_fee_cents >= v_item.gross_amount_cents
     or v_item.provider_fee_cents < 0 or v_item.provider_fee_cents > v_item.gross_amount_cents then
    raise exception 'Settlement amounts are outside supported bounds.';
  end if;

  -- Never release funds from a payment receipt journal that also credited
  -- available/reserved balances or contains extra financial legs.
  select count(*) into v_receipt_journal_count from public.nexora_ledger_journals j
    where j.transaction_id=v_item.transaction_id and j.business_id=v_item.business_id
      and j.owner_id=v_item.owner_id and j.event_code='payment.received';
  if v_receipt_journal_count<>1 then
    raise exception 'Exactly one payment receipt journal is required before settlement.';
  end if;
  select j.id into v_receipt_journal_id from public.nexora_ledger_journals j
    where j.transaction_id=v_item.transaction_id and j.business_id=v_item.business_id
      and j.owner_id=v_item.owner_id and j.event_code='payment.received'
    for update;
  if not found then raise exception 'Payment receipt journal is missing.'; end if;
  select count(*),
    coalesce(sum(e.amount_cents) filter(where a.account_code='merchant_pending' and e.side='credit'),0),
    coalesce(sum(e.amount_cents) filter(where a.account_code='provider_clearing' and e.side='debit'),0)
    into v_receipt_entry_count,v_pending_credit,v_provider_clearing_debit
    from public.nexora_ledger_entries e
    join public.nexora_ledger_accounts a on a.id=e.account_id
    where e.journal_id=v_receipt_journal_id;
  if v_receipt_entry_count<>2 or v_pending_credit<>v_item.gross_amount_cents
    or v_provider_clearing_debit<>v_item.gross_amount_cents then
    raise exception 'Settlement requires exactly the gross pending credit and provider clearing debit.';
  end if;

  select * into v_existing from public.nexora_settlements
    where reconciliation_item_id=v_item.id or transaction_id=v_item.transaction_id
    order by (reconciliation_item_id=v_item.id) desc limit 1;
  if found then
    if v_existing.transaction_id <> v_item.transaction_id
       or v_existing.business_id <> v_item.business_id or v_existing.owner_id <> v_item.owner_id
       or v_existing.gross_amount_cents <> v_item.gross_amount_cents
       or v_existing.merchant_fee_cents <> v_item.merchant_fee_cents
       or v_existing.provider_fee_cents <> v_item.provider_fee_cents
       or v_existing.net_amount_cents <> v_item.expected_merchant_net_cents then
      raise exception 'A settlement already exists with different financial evidence.';
    end if;
    if v_existing.reconciliation_item_id=v_item.id and not exists(
      select 1 from public.nexora_ledger_journals j
      where j.id=v_existing.release_journal_id and j.request_hash=p_request_hash
        and j.event_code='settlement.released' and j.transaction_id=v_item.transaction_id
    ) then
      raise exception 'Settlement idempotency key reused with different evidence.';
    end if;
    return v_existing.id;
  end if;

  -- Serialize policy edits against settlement, including the first controls
  -- row for a business (which cannot be row-locked while it does not exist).
  perform 1 from public.businesses b
    where b.id=v_item.business_id and b.owner_id=v_item.owner_id for share;
  if not found then raise exception 'Merchant workspace changed during settlement.'; end if;
  select * into v_controls from public.nexora_merchant_controls
    where business_id=v_item.business_id and owner_id=v_item.owner_id for share;
  if found then
    v_percentage := coalesce(v_controls.reserve_percentage,0);
    v_days := coalesce(v_controls.reserve_days,0);
  end if;
  if (v_percentage=0 and v_days<>0) or (v_percentage>0 and v_days not between 1 and 365) then
    raise exception 'Merchant holdback policy is invalid; settlement stopped.';
  end if;

  insert into public.nexora_receivables(
    transaction_id,business_id,owner_id,provider_code,provider_transaction_id,gross_amount_cents
  ) values (
    v_item.transaction_id,v_item.business_id,v_item.owner_id,v_run.provider_code,
    v_item.provider_transaction_id,v_item.gross_amount_cents
  ) on conflict(transaction_id) do nothing;
  select * into v_receivable from public.nexora_receivables
    where transaction_id=v_item.transaction_id for update;
  if not found or v_receivable.business_id <> v_item.business_id
     or v_receivable.owner_id <> v_item.owner_id or v_receivable.provider_code <> v_run.provider_code
     or v_receivable.provider_transaction_id <> v_item.provider_transaction_id
     or v_receivable.gross_amount_cents <> v_item.gross_amount_cents then
    raise exception 'Existing receivable does not match reconciliation evidence.';
  end if;

  v_net := v_item.gross_amount_cents-v_item.merchant_fee_cents;
  v_reserved := round(v_net*v_percentage/100)::bigint;
  v_available := v_net-v_reserved;
  if v_reserved>0 then v_release_at := now()+make_interval(days=>v_days); end if;
  v_entries := jsonb_build_array(
    jsonb_build_object('account_code','merchant_pending','side','debit','amount_cents',v_item.gross_amount_cents)
  );
  if v_available>0 then v_entries := v_entries || jsonb_build_array(
    jsonb_build_object('account_code','merchant_available','side','credit','amount_cents',v_available)); end if;
  if v_reserved>0 then v_entries := v_entries || jsonb_build_array(
    jsonb_build_object('account_code','merchant_reserved','side','credit','amount_cents',v_reserved)); end if;
  if v_item.merchant_fee_cents>0 then v_entries := v_entries || jsonb_build_array(
    jsonb_build_object('account_code','platform_fee_revenue','side','credit','amount_cents',v_item.merchant_fee_cents)); end if;
  if v_item.provider_fee_cents>0 then v_entries := v_entries || jsonb_build_array(
    jsonb_build_object('account_code','provider_fee_expense','side','debit','amount_cents',v_item.provider_fee_cents),
    jsonb_build_object('account_code','provider_clearing','side','credit','amount_cents',v_item.provider_fee_cents)); end if;

  v_journal_id := public.nexora_ledger_post_journal(
    v_item.owner_id,v_item.business_id,v_item.transaction_id,'settlement.released',
    'settlement.released:'||v_item.transaction_id::text,p_request_hash,
    'Liquidação conciliada; valor líquido dividido entre disponível e reserva.',v_entries,
    jsonb_build_object('provider_code',v_run.provider_code,'environment',v_run.environment,
      'reconciliation_run_id',v_run.id,'reconciliation_item_id',v_item.id,
      'provider_transaction_id',v_item.provider_transaction_id,
      'gross_amount_cents',v_item.gross_amount_cents,'merchant_fee_cents',v_item.merchant_fee_cents,
      'provider_fee_cents',v_item.provider_fee_cents,'net_amount_cents',v_net,
      'reserve_percentage_applied',v_percentage,'reserve_days_applied',v_days,
      'reserve_amount_cents',v_reserved,'available_amount_cents',v_available,
      'reserve_release_at',v_release_at)
  );
  insert into public.nexora_settlements(
    receivable_id,transaction_id,business_id,owner_id,reconciliation_item_id,
    gross_amount_cents,merchant_fee_cents,provider_fee_cents,net_amount_cents,release_journal_id,
    reserve_percentage_applied,reserve_days_applied,reserve_amount_cents,available_amount_cents,reserve_release_at
  ) values (
    v_receivable.id,v_item.transaction_id,v_item.business_id,v_item.owner_id,v_item.id,
    v_item.gross_amount_cents,v_item.merchant_fee_cents,v_item.provider_fee_cents,v_net,v_journal_id,
    v_percentage,v_days,v_reserved,v_available,v_release_at
  ) returning id into v_settlement_id;
  return v_settlement_id;
end;
$$;
revoke all on function public.nexora_settlement_release(uuid,text) from public,anon,authenticated;
grant execute on function public.nexora_settlement_release(uuid,text) to service_role;

-- No scheduled job is created here. A trusted backend worker must invoke the
-- service-only reserve release RPC after maturity; never expose it to clients.
commit;

-- Verify no invalid reserve controls and show matured/open reserves for review.
select count(*) as invalid_holdback_policies
from public.nexora_merchant_controls
where (reserve_percentage=0 and reserve_days<>0)
   or (reserve_percentage>0 and reserve_days not between 1 and 365);

select s.id as settlement_id,s.business_id,s.transaction_id,s.reserve_percentage_applied,
  s.reserve_days_applied,s.reserve_amount_cents,s.available_amount_cents,s.reserve_release_at,
  case when r.id is not null then 'released'
       when s.reserve_amount_cents=0 then 'no_reserve'
       when s.reserve_release_at<=now() then 'matured_pending_backend_release'
       else 'held' end as reserve_status
from public.nexora_settlements s
left join public.nexora_settlement_reserve_releases r on r.settlement_id=s.id
where s.reserve_amount_cents>0
order by s.reserve_release_at,s.created_at;

select c.relname as table_name,c.relrowsecurity as rls_enabled,
  has_table_privilege('authenticated',c.oid,'SELECT') as authenticated_can_select,
  has_table_privilege('authenticated',c.oid,'INSERT') as authenticated_can_insert,
  has_table_privilege('authenticated',c.oid,'UPDATE') as authenticated_can_update,
  has_table_privilege('authenticated',c.oid,'DELETE') as authenticated_can_delete,
  has_table_privilege('service_role',c.oid,'SELECT') as service_role_can_select,
  has_table_privilege('service_role',c.oid,'INSERT') as service_role_can_insert,
  has_table_privilege('service_role',c.oid,'UPDATE') as service_role_can_update,
  has_table_privilege('service_role',c.oid,'DELETE') as service_role_can_delete
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname='nexora_settlement_reserve_releases';

select has_function_privilege('anon','public.nexora_settlement_release_reserve(uuid,text)','EXECUTE') as anon_can_release_reserve,
  has_function_privilege('authenticated','public.nexora_settlement_release_reserve(uuid,text)','EXECUTE') as authenticated_can_release_reserve,
  has_function_privilege('service_role','public.nexora_settlement_release_reserve(uuid,text)','EXECUTE') as service_role_can_release_reserve;
select has_function_privilege('anon','public.nexora_settlement_matured_reserve_candidates(integer)','EXECUTE') as anon_can_list_matured_reserves,
  has_function_privilege('authenticated','public.nexora_settlement_matured_reserve_candidates(integer)','EXECUTE') as authenticated_can_list_matured_reserves,
  has_function_privilege('service_role','public.nexora_settlement_matured_reserve_candidates(integer)','EXECUTE') as service_role_can_list_matured_reserves;
select has_function_privilege('anon','public.nexora_reconciliation_settlement_candidates(uuid,integer)','EXECUTE') as anon_can_list_settlements,
  has_function_privilege('authenticated','public.nexora_reconciliation_settlement_candidates(uuid,integer)','EXECUTE') as authenticated_can_list_settlements,
  has_function_privilege('service_role','public.nexora_reconciliation_settlement_candidates(uuid,integer)','EXECUTE') as service_role_can_list_settlements;



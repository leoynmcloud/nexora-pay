-- Provider-neutral evidence and gated settlement writer. Run AFTER
-- nexora-production-ledger.sql. A webhook alone never moves funds: only the
-- service-only release RPC may move merchant_pending to merchant_available,
-- and only after exact, complete production reconciliation.
begin;

do $$ begin
  if to_regclass('public.nexora_ledger_journals') is null
     or to_regclass('public.nexora_transactions') is null
     or to_regclass('public.nexora_acquirers') is null
     or to_regclass('public.nexora_applied_pricing') is null
     or to_regprocedure('public.nexora_ledger_post_journal(uuid,uuid,uuid,text,text,text,text,jsonb,jsonb)') is null
     or to_regprocedure('public.nexora_ledger_reject_mutation()') is null then
    raise exception 'Execute o ledger e nexora-pricing-engine.sql antes desta migração.';
  end if;
  if has_table_privilege('service_role','public.nexora_ledger_accounts','INSERT')
     or has_table_privilege('service_role','public.nexora_ledger_accounts','UPDATE')
     or has_table_privilege('service_role','public.nexora_ledger_accounts','DELETE')
     or has_table_privilege('service_role','public.nexora_ledger_entries','INSERT')
     or has_table_privilege('service_role','public.nexora_ledger_entries','UPDATE')
     or has_table_privilege('service_role','public.nexora_ledger_entries','DELETE')
     or has_table_privilege('service_role','public.nexora_ledger_journals','INSERT')
     or has_table_privilege('service_role','public.nexora_ledger_journals','UPDATE')
     or has_table_privilege('service_role','public.nexora_ledger_journals','DELETE')
     or not has_function_privilege('service_role',
       'public.nexora_ledger_post_journal(uuid,uuid,uuid,text,text,text,text,jsonb,jsonb)','EXECUTE') then
    raise exception 'Execute e valide nexora-ledger-writer-hardening.sql antes desta migração.';
  end if;
end $$;
do $$ begin
  if exists (select 1 from public.businesses b where not exists (
    select 1 from public.nexora_ledger_accounts a
    where a.business_id=b.id and a.owner_id=b.owner_id
      and a.account_code='provider_fee_expense' and a.account_class='expense'
  )) then
    raise exception 'Execute nexora-ledger-writer-hardening.sql antes desta migração.';
  end if;
end $$;

-- Bind every merchant financial fact to the same transaction, workspace and owner.
create unique index if not exists nexora_transactions_id_business_owner_unique
  on public.nexora_transactions(id,business_id,owner_id);

-- Keep the routed acquirer on the internal transaction, not only in the
-- provider-specific operation row. This is needed to prove pricing and
-- reconciliation belong to the same route.
alter table public.nexora_transactions
  add column if not exists acquirer_id uuid references public.nexora_acquirers(id) on delete restrict;
-- Optional one-time import for installations that still have historical Asaas rows.
do $$ begin
  if to_regclass('public.nexora_asaas_sandbox_operations') is not null then
    execute $sql$
      update public.nexora_transactions t set acquirer_id=o.acquirer_id
      from public.nexora_asaas_sandbox_operations o
      where o.transaction_id=t.id and o.acquirer_id is not null and t.acquirer_id is null
    $sql$;
  end if;
end $$;

-- Preserve the existing Edge Function contract while recording the acquirer
-- from the immutable operation snapshot whenever a provider payment is saved.
create or replace function public.nexora_asaas_complete_charge(
  p_operation_id bigint,p_provider_reference text,p_provider_status text,p_transaction_status text,
  p_invoice_url text,p_pix_copy_paste text,p_pix_encoded_image text,p_pix_expiration timestamptz
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_operation record;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_operation_id is null or nullif(trim(p_provider_reference),'') is null
    or p_provider_status is null or nullif(trim(p_provider_status),'') is null
    or p_transaction_status is null
    or length(p_provider_reference)>255 or length(coalesce(p_provider_status,''))>80
    or p_transaction_status not in ('pending','processing','paid','cancelled','refunded','refund_pending','under_review','overdue')
    or length(coalesce(p_invoice_url,''))>2000 or length(coalesce(p_pix_copy_paste,''))>5000
    or length(coalesce(p_pix_encoded_image,''))>100000 then raise exception 'Resposta do provedor inválida.'; end if;
  select * into v_operation from public.nexora_asaas_sandbox_operations where id=p_operation_id for update;
  if not found or v_operation.transaction_id is null or v_operation.acquirer_id is null then
    raise exception 'Operação ou adquirente não encontrado.';
  end if;
  if v_operation.provider_reference is not null and v_operation.provider_reference<>p_provider_reference then
    raise exception 'A referência do provedor não corresponde à cobrança.';
  end if;
  if exists(select 1 from public.nexora_transactions t where t.id=v_operation.transaction_id
    and t.acquirer_id is not null and t.acquirer_id<>v_operation.acquirer_id) then
    raise exception 'A transação já está vinculada a outro adquirente.';
  end if;
  if exists(select 1 from public.nexora_transactions t where t.id=v_operation.transaction_id
    and ((t.status='refunded' and p_transaction_status<>'refunded')
      or (t.status='paid' and p_transaction_status in ('pending','processing','overdue'))
      or (t.status='refund_pending' and p_transaction_status in ('pending','processing','paid','overdue')))) then
    update public.nexora_transactions set acquirer_id=v_operation.acquirer_id
      where id=v_operation.transaction_id and acquirer_id is null;
    return;
  end if;
  update public.nexora_transactions set acquirer_id=v_operation.acquirer_id,
    provider_reference=p_provider_reference,status=p_transaction_status,
    paid_at=case when p_transaction_status='paid' then coalesce(paid_at,now()) else null end
    where id=v_operation.transaction_id and owner_id=v_operation.owner_id
      and business_id=v_operation.business_id
      and test_mode=(v_operation.environment='sandbox');
  if not found then raise exception 'Transação não corresponde à operação.'; end if;
  insert into public.nexora_asaas_sandbox_payment_details(transaction_id,business_id,owner_id,provider_reference,
    provider_status,invoice_url,pix_copy_paste,pix_encoded_image,pix_expiration,updated_at)
  values(v_operation.transaction_id,v_operation.business_id,v_operation.owner_id,p_provider_reference,
    left(p_provider_status,80),nullif(p_invoice_url,''),nullif(p_pix_copy_paste,''),nullif(p_pix_encoded_image,''),p_pix_expiration,now())
  on conflict(transaction_id) do update set provider_reference=excluded.provider_reference,
    provider_status=excluded.provider_status,invoice_url=coalesce(excluded.invoice_url,public.nexora_asaas_sandbox_payment_details.invoice_url),
    pix_copy_paste=coalesce(excluded.pix_copy_paste,public.nexora_asaas_sandbox_payment_details.pix_copy_paste),
    pix_encoded_image=coalesce(excluded.pix_encoded_image,public.nexora_asaas_sandbox_payment_details.pix_encoded_image),
    pix_expiration=coalesce(excluded.pix_expiration,public.nexora_asaas_sandbox_payment_details.pix_expiration),updated_at=now();
  update public.nexora_asaas_sandbox_operations set provider_reference=p_provider_reference,status='succeeded',
    last_error_code=null,updated_at=now() where id=p_operation_id;
end;
$$;
revoke all on function public.nexora_asaas_complete_charge(bigint,text,text,text,text,text,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.nexora_asaas_complete_charge(bigint,text,text,text,text,text,text,timestamptz)
  to service_role;

-- The external provider statement is account-level evidence, not a merchant
-- balance. A missing provider reference remains nullable so unmatched lines can
-- be investigated instead of silently discarded.
create table if not exists public.nexora_provider_statement_entries (
  id uuid primary key default gen_random_uuid(),
  provider_code text not null check (provider_code ~ '^[a-z][a-z0-9_-]{1,79}$'),
  environment text not null check (environment in ('production','sandbox')),
  external_entry_id text not null check (length(trim(external_entry_id)) between 1 and 200),
  provider_transaction_id text check (length(provider_transaction_id) between 1 and 200),
  provider_entry_type text not null check (length(trim(provider_entry_type)) between 1 and 120),
  entry_kind text not null check (entry_kind in ('payment_credit','payment_fee','other')),
  direction text not null check (direction in ('credit','debit')),
  amount_cents bigint not null check (amount_cents > 0),
  check ((entry_kind='payment_credit' and direction='credit')
      or (entry_kind='payment_fee' and direction='debit') or entry_kind='other'),
  occurred_on date not null,
  evidence_sha256 text not null check (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  imported_at timestamptz not null default now(),
  unique (provider_code,environment,external_entry_id)
);
create index if not exists nexora_statement_reference
  on public.nexora_provider_statement_entries(provider_code,environment,provider_transaction_id,occurred_on);

-- A run covers a bounded provider statement window. complete=false means one
-- or more pages are missing and every comparison must remain unresolved.
create table if not exists public.nexora_reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  provider_code text not null check (provider_code ~ '^[a-z][a-z0-9_-]{1,79}$'),
  environment text not null check (environment in ('production','sandbox')),
  window_start date not null,
  window_end date not null,
  statement_complete boolean not null default false,
  statement_sha256 text not null check (statement_sha256 ~ '^[a-f0-9]{64}$'),
  entry_count integer not null check (entry_count >= 0),
  created_at timestamptz not null default now(),
  check (window_end >= window_start),
  unique (provider_code,environment,window_start,window_end,statement_sha256),
  unique (id,provider_code,environment)
);
create index if not exists nexora_reconciliation_runs_window
  on public.nexora_reconciliation_runs(provider_code,environment,window_end desc);

-- A result records a comparison, including divergences. It does not post a
-- journal or imply that the merchant may withdraw the matched amount.
create table if not exists public.nexora_reconciliation_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.nexora_reconciliation_runs(id) on delete restrict,
  transaction_id uuid not null,
  business_id uuid not null,
  owner_id uuid not null,
  provider_transaction_id text not null check (length(trim(provider_transaction_id)) between 1 and 200),
  result text not null check (result in ('matched','divergent','incomplete')),
  issues jsonb not null default '[]'::jsonb check (jsonb_typeof(issues) = 'array'),
  provider_credit_cents bigint check (provider_credit_cents >= 0),
  provider_fee_cents bigint check (provider_fee_cents >= 0),
  expected_provider_fee_cents bigint check (expected_provider_fee_cents >= 0),
  gross_amount_cents bigint not null check (gross_amount_cents > 0),
  merchant_fee_cents bigint check (merchant_fee_cents >= 0),
  expected_merchant_net_cents bigint check (expected_merchant_net_cents >= 0),
  created_at timestamptz not null default now(),
  unique (run_id,transaction_id),
  foreign key (transaction_id,business_id,owner_id)
    references public.nexora_transactions(id,business_id,owner_id) on delete restrict,
  check ((result='matched' and issues='[]'::jsonb and expected_merchant_net_cents is not null
          and provider_credit_cents is not null and provider_credit_cents=gross_amount_cents
          and provider_fee_cents is not null and expected_provider_fee_cents is not null
          and provider_fee_cents=expected_provider_fee_cents
          and merchant_fee_cents is not null and expected_merchant_net_cents=gross_amount_cents-merchant_fee_cents)
      or (result<>'matched' and expected_merchant_net_cents is null))
);
create index if not exists nexora_reconciliation_items_business_date
  on public.nexora_reconciliation_items(business_id,created_at desc);
create index if not exists nexora_reconciliation_items_divergent
  on public.nexora_reconciliation_items(result,created_at desc) where result <> 'matched';

-- A receivable belongs to exactly one internal transaction. Recognition and
-- settlement are separate facts; no automatic release is installed here.
create table if not exists public.nexora_receivables (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null unique,
  business_id uuid not null,
  owner_id uuid not null,
  provider_code text not null check (provider_code ~ '^[a-z][a-z0-9_-]{1,79}$'),
  provider_transaction_id text not null check (length(trim(provider_transaction_id)) between 1 and 200),
  gross_amount_cents bigint not null check (gross_amount_cents > 0),
  currency text not null default 'BRL' check (currency='BRL'),
  recognized_at timestamptz not null default now(),
  foreign key (transaction_id,business_id,owner_id)
    references public.nexora_transactions(id,business_id,owner_id) on delete restrict,
  unique (id,transaction_id,business_id,owner_id)
);
create index if not exists nexora_receivables_business_date
  on public.nexora_receivables(business_id,recognized_at desc);

create table if not exists public.nexora_settlements (
  id uuid primary key default gen_random_uuid(),
  receivable_id uuid not null unique,
  transaction_id uuid not null,
  business_id uuid not null,
  owner_id uuid not null,
  reconciliation_item_id uuid not null unique references public.nexora_reconciliation_items(id) on delete restrict,
  gross_amount_cents bigint not null check (gross_amount_cents > 0),
  merchant_fee_cents bigint not null check (merchant_fee_cents >= 0),
  provider_fee_cents bigint not null check (provider_fee_cents >= 0),
  net_amount_cents bigint not null check (net_amount_cents > 0),
  release_journal_id uuid not null unique references public.nexora_ledger_journals(id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key (receivable_id,transaction_id,business_id,owner_id)
    references public.nexora_receivables(id,transaction_id,business_id,owner_id) on delete restrict,
  check (net_amount_cents = gross_amount_cents - merchant_fee_cents)
);
create index if not exists nexora_settlements_business_date
  on public.nexora_settlements(business_id,created_at desc);

-- A settlement row is impossible without a complete production comparison and
-- the exact, balanced release journal. The service-only writer below creates
-- the receivable, journal, and settlement atomically in one database transaction.
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
     or v_journal.owner_id <> new.owner_id or v_journal.event_code <> 'settlement.released' then
    raise exception 'Settlement evidence does not match a confirmed production payment.';
  end if;

  select count(*),
    coalesce(sum(e.amount_cents) filter(where a.account_code='merchant_pending' and e.side='debit'),0),
    coalesce(sum(e.amount_cents) filter(where a.account_code='merchant_available' and e.side='credit'),0),
    coalesce(sum(e.amount_cents) filter(where a.account_code='platform_fee_revenue' and e.side='credit'),0),
    coalesce(sum(e.amount_cents) filter(where a.account_code='provider_fee_expense' and e.side='debit'),0),
    coalesce(sum(e.amount_cents) filter(where a.account_code='provider_clearing' and e.side='credit'),0)
    into v_count,v_pending,v_available,v_fee,v_provider_fee_expense,v_provider_clearing
  from public.nexora_ledger_entries e
  join public.nexora_ledger_accounts a on a.id=e.account_id
  where e.journal_id=new.release_journal_id;
  if v_count <> (case when new.merchant_fee_cents=0 then 2 else 3 end)
      + (case when new.provider_fee_cents=0 then 0 else 2 end)
     or v_pending <> new.gross_amount_cents or v_available <> new.net_amount_cents
     or v_fee <> new.merchant_fee_cents
     or v_provider_fee_expense <> new.provider_fee_cents
     or v_provider_clearing <> new.provider_fee_cents then
    raise exception 'Settlement release journal does not match gross, provider fee, merchant fee and net.';
  end if;
  return new;
end;
$$;
revoke all on function public.nexora_assert_settlement_evidence() from public,anon,authenticated;
drop trigger if exists nexora_settlements_check_evidence on public.nexora_settlements;
create trigger nexora_settlements_check_evidence before insert on public.nexora_settlements
  for each row execute function public.nexora_assert_settlement_evidence();

-- Promote a receivable only from a complete, exact production reconciliation.
-- A webhook or a successful provider API response alone can never release funds.
create or replace function public.nexora_settlement_release(
  p_reconciliation_item_id uuid,p_request_hash text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_item public.nexora_reconciliation_items;
  v_run public.nexora_reconciliation_runs;
  v_payment public.nexora_transactions;
  v_pricing public.nexora_applied_pricing;
  v_receivable public.nexora_receivables;
  v_existing public.nexora_settlements;
  v_journal_id uuid;
  v_settlement_id uuid;
  v_net bigint;
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
  v_entries := jsonb_build_array(
    jsonb_build_object('account_code','merchant_pending','side','debit','amount_cents',v_item.gross_amount_cents),
    jsonb_build_object('account_code','merchant_available','side','credit','amount_cents',v_net)
  );
  if v_item.merchant_fee_cents > 0 then
    v_entries := v_entries || jsonb_build_array(
      jsonb_build_object('account_code','platform_fee_revenue','side','credit','amount_cents',v_item.merchant_fee_cents)
    );
  end if;
  if v_item.provider_fee_cents > 0 then
    v_entries := v_entries || jsonb_build_array(
      jsonb_build_object('account_code','provider_fee_expense','side','debit','amount_cents',v_item.provider_fee_cents),
      jsonb_build_object('account_code','provider_clearing','side','credit','amount_cents',v_item.provider_fee_cents)
    );
  end if;
  v_journal_id := public.nexora_ledger_post_journal(
    v_item.owner_id,v_item.business_id,v_item.transaction_id,'settlement.released',
    'settlement.released:'||v_item.transaction_id::text,p_request_hash,
    'Liquidação conciliada; saldo líquido liberado para o lojista.',v_entries,
    jsonb_build_object('provider_code',v_run.provider_code,'environment',v_run.environment,
      'reconciliation_run_id',v_run.id,'reconciliation_item_id',v_item.id,
      'provider_transaction_id',v_item.provider_transaction_id,
      'gross_amount_cents',v_item.gross_amount_cents,'merchant_fee_cents',v_item.merchant_fee_cents,
      'provider_fee_cents',v_item.provider_fee_cents,'net_amount_cents',v_net)
  );
  insert into public.nexora_settlements(
    receivable_id,transaction_id,business_id,owner_id,reconciliation_item_id,
    gross_amount_cents,merchant_fee_cents,provider_fee_cents,net_amount_cents,release_journal_id
  ) values (
    v_receivable.id,v_item.transaction_id,v_item.business_id,v_item.owner_id,v_item.id,
    v_item.gross_amount_cents,v_item.merchant_fee_cents,v_item.provider_fee_cents,v_net,v_journal_id
  ) returning id into v_settlement_id;
  return v_settlement_id;
end;
$$;
revoke all on function public.nexora_settlement_release(uuid,text) from public,anon,authenticated;
grant execute on function public.nexora_settlement_release(uuid,text) to service_role;

-- These are internal service records. There is no client DML and no client
-- SELECT; a future merchant read model must project only its own safe fields.
alter table public.nexora_provider_statement_entries enable row level security;
alter table public.nexora_reconciliation_runs enable row level security;
alter table public.nexora_reconciliation_items enable row level security;
alter table public.nexora_receivables enable row level security;
alter table public.nexora_settlements enable row level security;
revoke all on public.nexora_provider_statement_entries,public.nexora_reconciliation_runs,
  public.nexora_reconciliation_items,public.nexora_receivables,public.nexora_settlements
  from public,anon,authenticated,service_role;
grant select,insert on public.nexora_provider_statement_entries,public.nexora_reconciliation_runs,
  public.nexora_reconciliation_items to service_role;

drop trigger if exists nexora_statement_immutable on public.nexora_provider_statement_entries;
create trigger nexora_statement_immutable before update or delete on public.nexora_provider_statement_entries
  for each row execute function public.nexora_ledger_reject_mutation();
drop trigger if exists nexora_reconciliation_runs_immutable on public.nexora_reconciliation_runs;
create trigger nexora_reconciliation_runs_immutable before update or delete on public.nexora_reconciliation_runs
  for each row execute function public.nexora_ledger_reject_mutation();
drop trigger if exists nexora_reconciliation_items_immutable on public.nexora_reconciliation_items;
create trigger nexora_reconciliation_items_immutable before update or delete on public.nexora_reconciliation_items
  for each row execute function public.nexora_ledger_reject_mutation();
drop trigger if exists nexora_receivables_immutable on public.nexora_receivables;
create trigger nexora_receivables_immutable before update or delete on public.nexora_receivables
  for each row execute function public.nexora_ledger_reject_mutation();
drop trigger if exists nexora_settlements_immutable on public.nexora_settlements;
create trigger nexora_settlements_immutable before update or delete on public.nexora_settlements
  for each row execute function public.nexora_ledger_reject_mutation();

notify pgrst,'reload schema';
commit;

-- Expected: five rows, RLS=true and authenticated DML=false.
select c.relname as table_name,c.relrowsecurity as rls_enabled,
  has_table_privilege('authenticated',c.oid,'INSERT') as authenticated_can_insert,
  has_table_privilege('authenticated',c.oid,'UPDATE') as authenticated_can_update,
  has_table_privilege('authenticated',c.oid,'DELETE') as authenticated_can_delete
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in
  ('nexora_provider_statement_entries','nexora_reconciliation_runs',
   'nexora_reconciliation_items','nexora_receivables','nexora_settlements')
order by c.relname;

-- Settlement writer is backend-only; it is not executable by browser roles.
select has_function_privilege('anon','public.nexora_settlement_release(uuid,text)','EXECUTE') as anon_can_release,
  has_function_privilege('authenticated','public.nexora_settlement_release(uuid,text)','EXECUTE') as authenticated_can_release,
  has_function_privilege('service_role','public.nexora_settlement_release(uuid,text)','EXECUTE') as service_role_can_release;

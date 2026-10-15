-- ==============================================================================
-- Nexora Pay - Manual Payout Completion & Instant Balance Settlement
-- ==============================================================================

-- 1. Extend nexora_payout_admin_events constraint to allow 'completed_manual'
alter table public.nexora_payout_admin_events drop constraint if exists nexora_payout_admin_events_action_check;
alter table public.nexora_payout_admin_events add constraint nexora_payout_admin_events_action_check
  check (action in ('approved','rejected','dispatch_started','reconciled','completed_manual'));

-- 2. Create core function public.nexora_payout_admin_complete_manual
create or replace function public.nexora_payout_admin_complete_manual(
  p_actor_id uuid,
  p_payout_id uuid,
  p_provider_transfer_id text,
  p_reason text,
  p_request_sha256 text
)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_payout public.nexora_payouts;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role'
     or p_actor_id is null or not exists(
       select 1 from public.nexora_admins a join auth.users u
         on lower(trim(u.email))=lower(trim(a.email))
       where u.id=p_actor_id and a.role='super_admin'
         and public.nexora_account_active(p_actor_id)
     ) then raise exception 'MFA Super Admin session required.'; end if;
  if p_payout_id is null
     or p_provider_transfer_id is null or length(trim(p_provider_transfer_id)) not between 1 and 100
     or p_reason is null or length(trim(p_reason)) not between 10 and 500
     or p_request_sha256 is null or p_request_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid manual payout completion request.';
  end if;

  select * into v_payout from public.nexora_payouts p where p.id=p_payout_id for update;
  if not found then raise exception 'Payout request not found.'; end if;
  if v_payout.status = 'COMPLETED' then return v_payout.status; end if;
  if v_payout.status not in ('RESERVED','APPROVED','OUTCOME_UNKNOWN') then
    raise exception 'Payout status % cannot be manually completed.', v_payout.status;
  end if;

  -- Post ledger completion: move reserved funds to provider_clearing
  perform public.nexora_ledger_post_journal(
    v_payout.owner_id, v_payout.business_id, null, 'payout.completed',
    'payout.completed.manual:' || v_payout.id::text, p_request_sha256,
    'Saque Pix realizado e concluído manualmente pelo Super Admin.',
    jsonb_build_array(
      jsonb_build_object('account_code','merchant_reserved','side','debit','amount_cents',v_payout.amount_cents),
      jsonb_build_object('account_code','provider_clearing','side','credit','amount_cents',v_payout.amount_cents)
    ),
    jsonb_build_object('payout_id', v_payout.id, 'manual_admin_actor_id', p_actor_id, 'provider_transfer_id', trim(p_provider_transfer_id))
  );

  update public.nexora_payouts set
    status = 'COMPLETED',
    provider_transfer_id = trim(p_provider_transfer_id),
    failure_code = null,
    updated_at = now()
  where id = v_payout.id;

  insert into public.nexora_payout_admin_events(payout_id, actor_id, action, from_status, to_status, reason)
  values (v_payout.id, p_actor_id, 'completed_manual', v_payout.status, 'COMPLETED', trim(p_reason));

  insert into public.nexora_audit_log(actor_id, action, target_id, details)
  values (p_actor_id, 'payout.admin_completed_manual', v_payout.id::text,
    jsonb_build_object('business_id', v_payout.business_id, 'amount_cents', v_payout.amount_cents,
      'from_status', v_payout.status, 'to_status', 'COMPLETED', 'provider_transfer_id', trim(p_provider_transfer_id), 'reason', trim(p_reason)));

  return 'COMPLETED';
end;
$$;
revoke all on function public.nexora_payout_admin_complete_manual(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.nexora_payout_admin_complete_manual(uuid,uuid,text,text,text) to service_role;

-- 3. Create fallback RPC for manual completion
create or replace function public.nexora_admin_complete_manual_payout(
  p_payout_id uuid,
  p_provider_transfer_id text,
  p_reason text default null
)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_actor_id uuid := auth.uid();
  v_hash text;
  v_final_reason text;
begin
  if not (
    current_user in ('postgres', 'service_role')
    or coalesce(auth.jwt()->>'role','') = 'service_role'
    or public.is_nexora_super_admin()
    or public.is_nexora_super_admin_account()
  ) then
    raise exception 'Acesso restrito ao Super Admin.';
  end if;
  if v_actor_id is null then
    select u.id into v_actor_id from auth.users u
    join public.nexora_admins a on lower(trim(a.email)) = lower(trim(u.email))
    where a.role = 'super_admin' and public.nexora_account_active(u.id)
    limit 1;
  end if;

  v_final_reason := coalesce(nullif(trim(p_reason), ''), 'Saque Pix realizado e concluído manualmente pelo Super Admin.');
  v_hash := encode(sha256(convert_to(coalesce(v_actor_id::text,'') || coalesce(p_payout_id::text,'') || coalesce(p_provider_transfer_id,'') || coalesce(v_final_reason,'') || now()::text, 'utf8')), 'hex');

  return public.nexora_payout_admin_complete_manual(
    v_actor_id,
    p_payout_id,
    p_provider_transfer_id,
    v_final_reason,
    v_hash
  );
end;
$$;
grant execute on function public.nexora_admin_complete_manual_payout(uuid, text, text) to authenticated, service_role;

-- 4. Update public.nexora_payout_admin_list to return destination information for decryption
drop function if exists public.nexora_payout_admin_list(uuid,integer);
create or replace function public.nexora_payout_admin_list(p_actor_id uuid,p_limit integer default 100)
returns table(
  payout_id uuid,business_id uuid,business_name text,merchant_email text,
  amount_cents bigint,status text,provider_code text,adapter_code text,
  destination_type text,destination_ciphertext text,
  created_at timestamptz,
  updated_at timestamptz,provider_batch_id text,provider_transfer_id text,external_reference text,
  failure_code text
)
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role'
     or p_actor_id is null or not exists(
       select 1 from public.nexora_admins a join auth.users u
         on lower(trim(u.email))=lower(trim(a.email))
       where u.id=p_actor_id and a.role='super_admin'
         and public.nexora_account_active(p_actor_id)
     ) then raise exception 'MFA Super Admin session required.'; end if;
  if p_limit is null or p_limit not between 1 and 200 then raise exception 'Invalid payout page size.'; end if;
  return query
    select p.id,p.business_id,b.name::text,u.email::text,p.amount_cents,p.status::text,p.provider_code::text,p.adapter_code::text,
      p.destination_type::text,p.destination_ciphertext::text,
      p.created_at,p.updated_at,p.provider_batch_id::text,p.provider_transfer_id::text,p.external_reference::text,
      p.failure_code::text
    from public.nexora_payouts p
    join public.businesses b on b.id=p.business_id and b.owner_id=p.owner_id
    join auth.users u on u.id=p.owner_id
    order by p.created_at desc,p.id desc limit p_limit;
end;
$$;
revoke all on function public.nexora_payout_admin_list(uuid,integer) from public,anon,authenticated;
grant execute on function public.nexora_payout_admin_list(uuid,integer) to service_role;

-- 5. Update direct fallback RPC public.nexora_admin_list_payouts
drop function if exists public.nexora_admin_list_payouts(integer);
create or replace function public.nexora_admin_list_payouts(p_limit integer default 100)
returns table(
  payout_id uuid,business_id uuid,business_name text,merchant_email text,
  amount_cents bigint,status text,provider_code text,adapter_code text,
  destination_type text,destination_ciphertext text,
  created_at timestamptz,
  updated_at timestamptz,provider_batch_id text,provider_transfer_id text,external_reference text,
  failure_code text
)
language plpgsql security definer set search_path = '' as $$
begin
  if not (
    current_user in ('postgres', 'service_role')
    or coalesce(auth.jwt()->>'role','') = 'service_role'
    or public.is_nexora_super_admin()
    or public.is_nexora_super_admin_account()
  ) then
    raise exception 'Acesso restrito ao Super Admin.';
  end if;
  if p_limit is null or p_limit not between 1 and 200 then
    p_limit := 100;
  end if;
  return query
    select p.id,p.business_id,b.name::text,u.email::text,p.amount_cents,p.status::text,p.provider_code::text,p.adapter_code::text,
      p.destination_type::text,p.destination_ciphertext::text,
      p.created_at,p.updated_at,p.provider_batch_id::text,p.provider_transfer_id::text,p.external_reference::text,
      p.failure_code::text
    from public.nexora_payouts p
    join public.businesses b on b.id=p.business_id and b.owner_id=p.owner_id
    join auth.users u on u.id=p.owner_id
    order by p.created_at desc,p.id desc limit p_limit;
end;
$$;
grant execute on function public.nexora_admin_list_payouts(integer) to authenticated, service_role;

-- 6. Update nexora_provider_confirm_payment_succeeded to auto-settle when withdrawal_mode = 'instant' and reserve_percentage = 0
create or replace function public.nexora_provider_confirm_payment_succeeded(
  p_provider_code text,
  p_transaction_id uuid,
  p_provider_transaction_id text,
  p_provider_event_id text
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_attempt public.nexora_payment_attempts;
  v_tx public.nexora_transactions;
  v_receipt_journal_id uuid;
  v_settle_journal_id uuid;
  v_receipt_journal_count bigint;
  v_receipt_entry_count bigint;
  v_pending_credit numeric;
  v_provider_clearing_debit numeric;
  v_gross_amount_cents bigint;
  v_settle_hash text;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_provider_code is null or p_provider_code !~ '^[a-z][a-z0-9_-]{1,63}$'
     or p_transaction_id is null or p_provider_transaction_id is null
     or length(trim(p_provider_transaction_id)) not between 1 and 255
     or p_provider_event_id is null or length(trim(p_provider_event_id)) not between 1 and 255 then
    raise exception 'Verified payment identity is required.'; end if;
  select * into v_attempt from public.nexora_payment_attempts a
    where a.transaction_id=p_transaction_id and a.provider_code=p_provider_code
      and a.environment='production' and a.provider_transaction_id=p_provider_transaction_id
      and a.status='succeeded' for update;
  if not found then raise exception 'Verified production payment attempt not found.'; end if;
  if not exists(select 1 from public.nexora_provider_payment_status_events e
      where e.provider_code=p_provider_code and e.provider_event_id=p_provider_event_id
        and e.provider_operation_id=v_attempt.provider_operation_id and e.transaction_id=p_transaction_id
        and e.provider_transaction_id=p_provider_transaction_id and e.normalized_status='SUCCEEDED') then
    raise exception 'Immutable successful provider event is required.';
  end if;
  select * into v_tx from public.nexora_transactions where id=p_transaction_id for update;
  if not found or v_tx.kind<>'payment' or v_tx.test_mode or v_tx.acquirer_id<>v_attempt.acquirer_id
    or v_tx.status not in ('pending','processing','paid') then
    raise exception 'Transaction does not match verified production payment.';
  end if;
  v_gross_amount_cents := round(v_tx.amount*100)::bigint;
  select count(*) into v_receipt_journal_count from public.nexora_ledger_journals j
    where j.transaction_id=p_transaction_id and j.business_id=v_attempt.business_id
      and j.owner_id=v_attempt.owner_id and j.event_code='payment.received';
  if v_receipt_journal_count<>1 then
    raise exception 'Exactly one payment receipt journal is required.';
  end if;
  select j.id into v_receipt_journal_id from public.nexora_ledger_journals j
    where j.transaction_id=p_transaction_id and j.business_id=v_attempt.business_id
      and j.owner_id=v_attempt.owner_id and j.event_code='payment.received'
      and j.idempotency_key='provider.payment.succeeded:'||p_provider_code||':'||p_transaction_id::text
    for update;
  if not found then raise exception 'Provider receipt journal is missing or mismatched.'; end if;
  select count(*),
    coalesce(sum(le.amount_cents) filter(where la.account_code='merchant_pending' and le.side='credit'),0),
    coalesce(sum(le.amount_cents) filter(where la.account_code='provider_clearing' and le.side='debit'),0)
    into v_receipt_entry_count,v_pending_credit,v_provider_clearing_debit
    from public.nexora_ledger_entries le
    join public.nexora_ledger_accounts la on la.id=le.account_id
    where le.journal_id=v_receipt_journal_id;
  if v_receipt_entry_count<>2 or v_pending_credit<>v_gross_amount_cents
    or v_provider_clearing_debit<>v_gross_amount_cents then
    raise exception 'Receipt journal must contain only the exact pending credit and provider clearing debit.';
  end if;
  update public.nexora_transactions set status='paid',paid_at=coalesce(paid_at,now()),
    provider_reference=p_provider_transaction_id
    where id=p_transaction_id and (provider_reference is null or provider_reference=p_provider_transaction_id);
  if not found then raise exception 'Transaction provider reference mismatch.'; end if;
  update public.nexora_checkout_links set status='paid',paid_at=coalesce(paid_at,now()),updated_at=now()
    where transaction_id=p_transaction_id and status in ('processing','paid');
  if not found then raise exception 'Hosted checkout link not found or cannot transition to paid.'; end if;

  -- Auto-settle to available if merchant has instant withdrawal mode and 0% reserve
  if exists (
    select 1 from public.nexora_merchant_controls c
    where c.business_id = v_attempt.business_id
      and c.owner_id = v_attempt.owner_id
      and c.withdrawal_mode = 'instant'
      and coalesce(c.reserve_percentage, 0) = 0
  ) and not exists (
    select 1 from public.nexora_ledger_journals j
    where j.transaction_id = p_transaction_id
      and j.event_code = 'settlement.instant_release'
  ) then
    v_settle_hash := encode(sha256(('instant-auto:' || v_attempt.business_id::text || ':' || p_transaction_id::text || ':' || v_gross_amount_cents::text)::bytea), 'hex');
    insert into public.nexora_ledger_journals(
      id, owner_id, business_id, transaction_id, event_code, idempotency_key, request_hash, description, metadata
    ) values (
      gen_random_uuid(), v_attempt.owner_id, v_attempt.business_id, p_transaction_id, 'settlement.instant_release',
      'auto-instant-settle:' || p_transaction_id::text, v_settle_hash,
      'Liquidação instantânea automática para saldo disponível.',
      jsonb_build_object('transaction_id', p_transaction_id, 'amount_cents', v_gross_amount_cents)
    ) returning id into v_settle_journal_id;

    insert into public.nexora_ledger_entries(journal_id, account_id, business_id, owner_id, side, amount_cents)
    select v_settle_journal_id, a.id, v_attempt.business_id, v_attempt.owner_id, 'debit', v_gross_amount_cents
    from public.nexora_ledger_accounts a
    where a.business_id=v_attempt.business_id and a.owner_id=v_attempt.owner_id and a.account_code='merchant_pending';

    insert into public.nexora_ledger_entries(journal_id, account_id, business_id, owner_id, side, amount_cents)
    select v_settle_journal_id, a.id, v_attempt.business_id, v_attempt.owner_id, 'credit', v_gross_amount_cents
    from public.nexora_ledger_accounts a
    where a.business_id=v_attempt.business_id and a.owner_id=v_attempt.owner_id and a.account_code='merchant_available';
  end if;

  perform public.nexora_webhook_enqueue_payment_succeeded(p_transaction_id);
end;
$$;
revoke all on function public.nexora_provider_confirm_payment_succeeded(text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.nexora_provider_confirm_payment_succeeded(text,uuid,text,text) to service_role;

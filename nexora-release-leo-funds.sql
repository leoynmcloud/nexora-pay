do $$
declare
  v_owner uuid := '569ac165-6dcd-48e8-9dc4-921baac20d8a';
  v_business uuid := 'e66aaa04-5fed-43f1-8cce-384bdcd0dd08';
  v_pending bigint;
  v_journal_id uuid;
  v_hash text := encode(sha256('release-leo-pending-300'::bytea), 'hex');
begin
  select coalesce(sum(case e.side when 'credit' then e.amount_cents else -e.amount_cents end),0)::bigint
    into v_pending from public.nexora_ledger_entries e
    join public.nexora_ledger_accounts a on a.id=e.account_id
    where e.business_id=v_business and e.owner_id=v_owner and a.account_code='merchant_pending';
  
  if v_pending > 0 then
    insert into public.nexora_ledger_journals(
      id, owner_id, business_id, event_code, idempotency_key, request_hash, description, metadata
    ) values (
      gen_random_uuid(), v_owner, v_business, 'settlement.instant_release',
      'manual-settlement-' || gen_random_uuid()::text, v_hash,
      'Liberacao de saldo pendente Pix para saldo disponivel', '{"type":"manual_settlement"}'::jsonb
    ) returning id into v_journal_id;

    insert into public.nexora_ledger_entries(journal_id, account_id, business_id, owner_id, side, amount_cents)
    select v_journal_id, a.id, v_business, v_owner, 'debit', v_pending
    from public.nexora_ledger_accounts a
    where a.business_id=v_business and a.owner_id=v_owner and a.account_code='merchant_pending';

    insert into public.nexora_ledger_entries(journal_id, account_id, business_id, owner_id, side, amount_cents)
    select v_journal_id, a.id, v_business, v_owner, 'credit', v_pending
    from public.nexora_ledger_accounts a
    where a.business_id=v_business and a.owner_id=v_owner and a.account_code='merchant_available';

    raise notice 'Released % cents for business % in journal %', v_pending, v_business, v_journal_id;
  end if;
end $$;

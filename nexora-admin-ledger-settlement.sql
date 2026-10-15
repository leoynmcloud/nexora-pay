-- RPCs to inspect merchant ledger balances and manually release pending funds directly to available balance
begin;

-- Function to list merchant balances across ledger accounts
create or replace function public.nexora_admin_list_merchant_balances()
returns table(
  business_id uuid,
  business_name text,
  owner_id uuid,
  owner_email text,
  available_cents bigint,
  pending_cents bigint,
  reserved_cents bigint,
  blocked_cents bigint,
  clearing_cents bigint
) language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_nexora_super_admin_account() and coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'Super admin privileges required.';
  end if;

  return query
  select
    b.id as business_id,
    b.name as business_name,
    b.owner_id,
    u.email::text as owner_email,
    coalesce(sum(case when a.account_code = 'merchant_available' then (case when e.side = 'credit' then e.amount_cents else -e.amount_cents end) else 0 end), 0)::bigint as available_cents,
    coalesce(sum(case when a.account_code = 'merchant_pending' then (case when e.side = 'credit' then e.amount_cents else -e.amount_cents end) else 0 end), 0)::bigint as pending_cents,
    coalesce(sum(case when a.account_code = 'merchant_reserved' then (case when e.side = 'credit' then e.amount_cents else -e.amount_cents end) else 0 end), 0)::bigint as reserved_cents,
    coalesce(sum(case when a.account_code = 'merchant_blocked' then (case when e.side = 'credit' then e.amount_cents else -e.amount_cents end) else 0 end), 0)::bigint as blocked_cents,
    coalesce(sum(case when a.account_code = 'provider_clearing' then (case when e.side = 'credit' then e.amount_cents else -e.amount_cents end) else 0 end), 0)::bigint as clearing_cents
  from public.businesses b
  join auth.users u on u.id = b.owner_id
  left join public.nexora_ledger_accounts a on a.business_id = b.id and a.owner_id = b.owner_id
  left join public.nexora_ledger_entries e on e.account_id = a.id
  group by b.id, b.name, b.owner_id, u.email
  order by available_cents desc, pending_cents desc;
end;
$$;

revoke all on function public.nexora_admin_list_merchant_balances() from public, anon;
grant execute on function public.nexora_admin_list_merchant_balances() to authenticated, service_role;

-- Function to release all or part of pending balance directly into available balance
create or replace function public.nexora_admin_release_pending_balance(
  p_business_id uuid,
  p_amount_cents bigint default null,
  p_reason text default 'Liberação de saldo pendente para disponível pelo Super Admin'
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_pending bigint;
  v_to_release bigint;
  v_journal_id uuid;
  v_hash text;
  v_actor uuid := auth.uid();
begin
  if not public.is_nexora_super_admin_account() and coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'Super admin privileges required.';
  end if;

  select b.owner_id into v_owner from public.businesses b where b.id = p_business_id for update;
  if v_owner is null then
    raise exception 'Business not found.';
  end if;

  select coalesce(sum(case e.side when 'credit' then e.amount_cents else -e.amount_cents end),0)::bigint
    into v_pending from public.nexora_ledger_entries e
    join public.nexora_ledger_accounts a on a.id=e.account_id
    where e.business_id=p_business_id and e.owner_id=v_owner and a.account_code='merchant_pending';

  if v_pending <= 0 then
    raise exception 'Esta conta não possui saldo pendente para liberar.';
  end if;

  v_to_release := coalesce(p_amount_cents, v_pending);
  if v_to_release <= 0 or v_to_release > v_pending then
    raise exception 'Valor inválido para liberação. Máximo pendente: %', v_pending;
  end if;

  v_hash := encode(sha256(('instant-release:' || p_business_id::text || ':' || v_to_release::text || ':' || now()::text)::bytea), 'hex');

  insert into public.nexora_ledger_journals(
    id, owner_id, business_id, event_code, idempotency_key, request_hash, description, metadata
  ) values (
    gen_random_uuid(), v_owner, p_business_id, 'settlement.instant_release',
    'admin-instant-settle-' || gen_random_uuid()::text, v_hash,
    trim(p_reason), jsonb_build_object('released_by', v_actor, 'amount_cents', v_to_release)
  ) returning id into v_journal_id;

  insert into public.nexora_ledger_entries(journal_id, account_id, business_id, owner_id, side, amount_cents)
  select v_journal_id, a.id, p_business_id, v_owner, 'debit', v_to_release
  from public.nexora_ledger_accounts a
  where a.business_id=p_business_id and a.owner_id=v_owner and a.account_code='merchant_pending';

  insert into public.nexora_ledger_entries(journal_id, account_id, business_id, owner_id, side, amount_cents)
  select v_journal_id, a.id, p_business_id, v_owner, 'credit', v_to_release
  from public.nexora_ledger_accounts a
  where a.business_id=p_business_id and a.owner_id=v_owner and a.account_code='merchant_available';

  insert into public.nexora_audit_log(actor_id, action, target_id, details)
  values(v_actor, 'merchant.pending_settled', p_business_id::text, jsonb_build_object(
    'amount_cents', v_to_release, 'journal_id', v_journal_id, 'reason', p_reason
  ));

  return jsonb_build_object(
    'status', 'released',
    'business_id', p_business_id,
    'released_cents', v_to_release,
    'journal_id', v_journal_id
  );
end;
$$;

revoke all on function public.nexora_admin_release_pending_balance(uuid, bigint, text) from public, anon;
grant execute on function public.nexora_admin_release_pending_balance(uuid, bigint, text) to authenticated, service_role;

commit;

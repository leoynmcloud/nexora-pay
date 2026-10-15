-- ==============================================================================
-- Nexora Pay - Fallback Direct RPCs for Payout Review and Listing (Zero friction)
-- ==============================================================================

create or replace function public.nexora_admin_list_payouts(p_limit integer default 100)
returns table(
  payout_id uuid,business_id uuid,business_name text,merchant_email text,
  amount_cents bigint,status text,provider_code text,adapter_code text,created_at timestamptz,
  updated_at timestamptz,provider_batch_id text,provider_transfer_id text,external_reference text
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
      p.created_at,p.updated_at,p.provider_batch_id::text,p.provider_transfer_id::text,p.external_reference::text
    from public.nexora_payouts p
    join public.businesses b on b.id=p.business_id and b.owner_id=p.owner_id
    join auth.users u on u.id=p.owner_id
    order by p.created_at desc,p.id desc limit p_limit;
end;
$$;
grant execute on function public.nexora_admin_list_payouts(integer) to authenticated, service_role;

create or replace function public.nexora_admin_review_payout(
  p_payout_id uuid,
  p_decision text,
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

  v_final_reason := coalesce(nullif(trim(p_reason), ''), case
    when p_decision = 'approve' then 'Aprovação de saque confirmada pelo Super Admin.'
    when p_decision = 'reject' then 'Rejeição de saque confirmada pelo Super Admin.'
    else 'Revisão administrativa confirmada.'
  end);

  v_hash := encode(sha256(convert_to(coalesce(v_actor_id::text,'') || coalesce(p_payout_id::text,'') || coalesce(p_decision,'') || coalesce(v_final_reason,'') || now()::text, 'utf8')), 'hex');

  return public.nexora_payout_admin_review(
    v_actor_id,
    p_payout_id,
    p_decision,
    v_final_reason,
    v_hash
  );
end;
$$;
grant execute on function public.nexora_admin_review_payout(uuid, text, text) to authenticated, service_role;

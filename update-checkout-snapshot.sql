-- Adiciona transaction_id no snapshot público de checkout para que o backend localize os detalhes do Pix
begin;

create or replace function public.nexora_checkout_public_snapshot(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_link public.nexora_checkout_links;
  v_business_name text;
begin
  if current_user not in ('service_role', 'postgres', 'supabase_admin')
     and coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'Backend service role required.';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid checkout token.'; end if;
  select l.* into v_link from public.nexora_checkout_links l where l.token_hash=p_token_hash;
  if not found then return null; end if;
  select b.name into v_business_name from public.businesses b where b.id=v_link.business_id;
  return jsonb_build_object(
    'id',v_link.id,
    'parent_link_id',v_link.parent_link_id,
    'transaction_id',v_link.transaction_id,
    'status',v_link.status,
    'amount_cents',v_link.amount_cents,
    'currency','BRL',
    'description',v_link.description,
    'business_name',coalesce(v_business_name,'Nexora Merchant'),
    'merchant_name',coalesce(v_business_name,'Nexora Merchant'),
    'provider_code',v_link.provider_code,
    'environment',v_link.environment,
    'expires_at',v_link.expires_at,
    'created_at',v_link.created_at
  );
end;
$$;

revoke all on function public.nexora_checkout_public_snapshot(text) from public, anon;
grant execute on function public.nexora_checkout_public_snapshot(text) to service_role;

commit;

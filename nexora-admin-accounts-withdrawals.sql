-- Nexora Pay: contagem de clientes por workspace e listagem integral dos saques.
-- Execute no Supabase SQL Editor depois de nexora-repair.sql e nexora-onboarding-kyc.sql.
begin;

create or replace function public.nexora_admin_snapshot(
  p_query text default '',
  p_page integer default 0,
  p_limit integer default 25,
  p_customer_query text default '',
  p_customer_page integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_accounts jsonb;
  v_customers jsonb;
  v_count integer;
  v_customer_count integer;
  v_limit integer := least(greatest(p_limit, 1), 100);
begin
  if not public.is_nexora_super_admin() then
    raise exception 'Acesso restrito ao Painel Nexora Pay.';
  end if;

  select count(*) into v_count
  from auth.users u
  left join public.user_settings s on s.user_id = u.id
  where concat_ws(' ', u.email, s.profile_name, u.raw_user_meta_data->>'full_name')
    ilike '%' || left(p_query, 160) || '%';

  select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) into v_accounts
  from (
    select
      u.id as user_id,
      u.email,
      coalesce(nullif(s.profile_name, ''), nullif(u.raw_user_meta_data->>'full_name', ''), split_part(u.email, '@', 1)) as full_name,
      u.created_at,
      u.last_sign_in_at,
      coalesce(ac.status, 'active') as status,
      ac.reason,
      (
        select jsonb_agg(jsonb_build_object(
          'id', b.id,
          'name', b.name,
          'customer_count', (select count(*) from public.nexora_customers c where c.business_id = b.id and c.owner_id = u.id)
        ) order by b.name)
        from public.businesses b
        where b.owner_id = u.id
      ) as workspaces,
      exists(select 1 from public.nexora_admins na where lower(na.email) = lower(u.email)) as is_admin
    from auth.users u
    left join public.user_settings s on s.user_id = u.id
    left join public.nexora_account_controls ac on ac.user_id = u.id
    where concat_ws(' ', u.email, s.profile_name, u.raw_user_meta_data->>'full_name')
      ilike '%' || left(p_query, 160) || '%'
    order by u.created_at desc, u.id
    limit v_limit offset greatest(p_page, 0) * v_limit
  ) a;

  select count(*) into v_customer_count
  from public.nexora_customers c
  join public.businesses b on b.id = c.business_id and b.owner_id = c.owner_id
  where concat_ws(' ', c.name, c.email, b.name) ilike '%' || left(p_customer_query, 160) || '%';

  select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) into v_customers
  from (
    select
      c.id, c.name, c.email, c.owner_id, c.business_id, b.name as business_name,
      coalesce((select sum(t.amount) from public.nexora_transactions t
        where t.customer_id = c.id and t.owner_id = c.owner_id and t.business_id = c.business_id
          and t.source = 'gateway' and t.kind <> 'withdrawal' and t.status = 'paid'), 0) as total,
      coalesce((select max(coalesce(t.paid_at, t.created_at)) from public.nexora_transactions t
        where t.customer_id = c.id and t.owner_id = c.owner_id and t.business_id = c.business_id
          and t.source = 'gateway'), c.created_at) as last_activity
    from public.nexora_customers c
    join public.businesses b on b.id = c.business_id and b.owner_id = c.owner_id
    where concat_ws(' ', c.name, c.email, b.name) ilike '%' || left(p_customer_query, 160) || '%'
    order by c.created_at desc, c.id
    limit v_limit offset greatest(p_customer_page, 0) * v_limit
  ) c;

  return jsonb_build_object(
    'accounts', v_accounts,
    'account_count', v_count,
    'customers', v_customers,
    'customer_count', v_customer_count,
    'stats', jsonb_build_object(
      'accounts', (select count(*) from auth.users),
      'active_accounts', (select count(*) from auth.users u where public.nexora_account_active(u.id)),
      'suspended_accounts', (select count(*) from public.nexora_account_controls where status = 'suspended'),
      'workspaces', (select count(*) from public.businesses)
    ),
    'withdrawals', (
      select coalesce(jsonb_agg(to_jsonb(w)), '[]'::jsonb)
      from (
        select w.*, b.name as business_name, u.email
        from public.nexora_withdrawals w
        join public.businesses b on b.id = w.business_id and b.owner_id = w.owner_id
        join auth.users u on u.id = w.owner_id
        order by w.created_at desc, w.id desc
      ) w
    ),
    'audit', (
      select coalesce(jsonb_agg(to_jsonb(l)), '[]'::jsonb)
      from (select id, action, target_id, created_at from public.nexora_audit_log order by id desc limit 30) l
    ),
    'site', public.nexora_public_site_settings(),
    'sandbox', (select sandbox from public.nexora_runtime_config where id),
    'gateway_ready', (select gateway_ready from public.nexora_runtime_config where id)
  );
end;
$$;

revoke all on function public.nexora_admin_snapshot(text, integer, integer, text, integer) from public, anon;
grant execute on function public.nexora_admin_snapshot(text, integer, integer, text, integer) to authenticated;

commit;

-- Acesso inicial permitido após cadastro/confirmacao do e-mail; operacao liberada
-- somente depois da aprovacao manual do KYC. Migração aditiva: não apaga dados.
-- Pré-requisitos: nexora-onboarding-kyc.sql e nexora-repair.sql executados.
begin;

do $$ begin
  if to_regclass('public.merchant_onboarding') is null
     or to_regclass('public.businesses') is null
     or to_regclass('public.workspace_members') is null
     or to_regclass('public.nexora_transactions') is null
     or to_regclass('public.nexora_customers') is null
     or to_regprocedure('public.nexora_account_active(uuid)') is null
     or to_regprocedure('public.is_nexora_super_admin()') is null then
    raise exception 'Pré-requisito ausente: execute os SQLs de onboarding/KYC e repair antes desta migração.';
  end if;
end $$;

-- Bloqueia explicitamente operações financeiras/administrativas dos merchants
-- ainda não aprovados, mesmo que outra migração tenha substituído o assert.
create or replace function public.nexora_assert_workspace()
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Sessão expirada. Entre novamente.'; end if;
  if not public.nexora_account_active(auth.uid()) then raise exception 'Conta suspensa. Entre em contato com o suporte.'; end if;
  if not public.is_nexora_super_admin() and not exists (
    select 1 from public.merchant_onboarding m where m.user_id=auth.uid() and m.status='APPROVED'
  ) then raise exception 'Cadastro ainda não aprovado. Aguarde a análise manual do KYC.'; end if;
  select b.id into v_id from public.businesses b where b.owner_id=auth.uid() order by b.id limit 1;
  if v_id is null then raise exception 'Workspace não encontrado. Entre novamente.'; end if;
  return v_id;
end;
$$;

-- Mantém a leitura da própria conta separada da permissão para operar.
create or replace function public.get_my_access()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_is_admin boolean;
  v_status text;
  v_id uuid;
  v_name text;
  v_document text;
begin
  if v_user is null then raise exception 'Sessão expirada. Entre novamente.'; end if;
  v_is_admin := public.is_nexora_super_admin();
  if not public.nexora_account_active(v_user) then
    return jsonb_build_object('user_id',v_user,'can_access',false,'can_operate',false,
      'access_status','suspended','onboarding_status','SUSPENDED','is_nexora_admin',v_is_admin);
  end if;
  if not v_is_admin then
    insert into public.merchant_onboarding(user_id,status,data)
    values(v_user,'DRAFT','{}'::jsonb) on conflict(user_id) do nothing;
    select m.status into v_status from public.merchant_onboarding m where m.user_id=v_user;
    if v_status in ('SUSPENDED','BLOCKED','CLOSED') then
      return jsonb_build_object('user_id',v_user,'can_access',false,'can_operate',false,
        'access_status',lower(v_status),'onboarding_status',v_status,'is_nexora_admin',false);
    end if;
  else
    v_status := 'APPROVED';
  end if;

  -- Cria workspace mínimo para permitir acesso ao painel restrito antes da análise.
  perform 1 from auth.users u where u.id=v_user for update;
  select b.id,b.name into v_id,v_name from public.businesses b
    where b.owner_id=v_user order by b.id limit 1;
  if v_id is null then
    select coalesce(nullif(trim(m.data #>> '{company,trade_name}'),''),
                    nullif(trim(u.raw_user_meta_data->>'full_name'),''),
                    split_part(u.email,'@',1)) || ' · Nexora',
           nullif(regexp_replace(coalesce(m.data #>> '{company,document_number}',''),'[^0-9]','','g'),'')
      into v_name,v_document
      from auth.users u left join public.merchant_onboarding m on m.user_id=u.id
      where u.id=v_user;
    insert into public.businesses(owner_id,name,document)
      values(v_user,v_name,v_document) returning id into v_id;
  end if;
  insert into public.workspace_members(business_id,user_id,role)
    values(v_id,v_user,'owner') on conflict(business_id,user_id) do update set role='owner';

  return jsonb_build_object(
    'user_id',v_user,'business_id',v_id,'business_name',v_name,
    'role','owner','can_access',true,
    'can_operate',(v_is_admin or v_status='APPROVED'),
    'access_status',case when v_is_admin or v_status='APPROVED' then 'active' else 'pending_kyc' end,
    'onboarding_status',coalesce(v_status,'DRAFT'),'is_nexora_admin',v_is_admin
  );
end;
$$;

-- Função privada usada pelo snapshot: apenas confirma conta e workspace; não
-- concede permissão para transacionar nem é executável diretamente pelo cliente.
create or replace function public.nexora_workspace_read_id()
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Sessão expirada. Entre novamente.'; end if;
  if not public.nexora_account_active(auth.uid()) then raise exception 'Conta suspensa. Entre em contato com o suporte.'; end if;
  if not public.is_nexora_super_admin() and not exists (
    select 1 from public.merchant_onboarding m where m.user_id=auth.uid()
      and m.status not in ('SUSPENDED','BLOCKED','CLOSED')
  ) then raise exception 'Acesso indisponível para esta conta.'; end if;
  select b.id into v_id from public.businesses b where b.owner_id=auth.uid() order by b.id limit 1;
  if v_id is null then raise exception 'Workspace não encontrado. Atualize a sessão.'; end if;
  return v_id;
end;
$$;

create or replace function public.nexora_workspace_snapshot()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := public.nexora_workspace_read_id();
  v_status text;
  v_can_operate boolean;
  v_settings jsonb;
  v_transactions jsonb := '[]'::jsonb;
  v_customers jsonb := '[]'::jsonb;
begin
  select coalesce(m.status,'DRAFT') into v_status
    from public.merchant_onboarding m where m.user_id=auth.uid();
  v_can_operate := public.is_nexora_super_admin() or v_status='APPROVED';
  select to_jsonb(s) into v_settings from public.user_settings s where s.user_id=auth.uid();

  if v_can_operate then
    select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc,t.id),'[]'::jsonb)
      into v_transactions from public.nexora_transactions t
      where t.business_id=v_id and t.owner_id=auth.uid();
    select coalesce(jsonb_agg(to_jsonb(c) order by c.last_activity desc,c.id),'[]'::jsonb)
      into v_customers from (
        select c.id,c.name,c.email,
          coalesce(sum(t.amount) filter(where t.kind <> 'withdrawal' and t.status='paid'),0) as total,
          coalesce(max(coalesce(t.paid_at,t.created_at)),c.created_at) as last_activity
        from public.nexora_customers c left join public.nexora_transactions t
          on t.customer_id=c.id and t.business_id=c.business_id and t.owner_id=c.owner_id
        where c.business_id=v_id and c.owner_id=auth.uid() group by c.id
      ) c;
  end if;

  return jsonb_build_object(
    'transactions',v_transactions,'customers',v_customers,'settings',coalesce(v_settings,'{}'::jsonb),
    'business_id',v_id,'business_name',(select b.name from public.businesses b where b.id=v_id),
    'balance',case when v_can_operate then public.nexora_balance(v_id) else null end,
    'sandbox',case when v_can_operate then (select r.sandbox from public.nexora_runtime_config r where r.id=true) else false end,
    'gateway_ready',case when v_can_operate then (select r.gateway_ready from public.nexora_runtime_config r where r.id=true) else false end,
    'can_operate',v_can_operate,'onboarding_status',coalesce(v_status,'APPROVED')
  );
end;
$$;

-- Reforça também as leituras diretas via PostgREST; snapshot não é a única barreira.
drop policy if exists nexora_customer_read on public.nexora_customers;
create policy nexora_customer_read on public.nexora_customers for select to authenticated
using (owner_id=auth.uid() and public.nexora_account_active(auth.uid())
  and (public.is_nexora_super_admin() or exists (
    select 1 from public.merchant_onboarding m where m.user_id=auth.uid() and m.status='APPROVED'
  )) and exists (select 1 from public.businesses b where b.id=business_id and b.owner_id=auth.uid()));

drop policy if exists nexora_transaction_read on public.nexora_transactions;
create policy nexora_transaction_read on public.nexora_transactions for select to authenticated
using (owner_id=auth.uid() and public.nexora_account_active(auth.uid())
  and (public.is_nexora_super_admin() or exists (
    select 1 from public.merchant_onboarding m where m.user_id=auth.uid() and m.status='APPROVED'
  )) and exists (select 1 from public.businesses b where b.id=business_id and b.owner_id=auth.uid()));

drop policy if exists nexora_withdrawal_read on public.nexora_withdrawals;
create policy nexora_withdrawal_read on public.nexora_withdrawals for select to authenticated
using (owner_id=auth.uid() and public.nexora_account_active(auth.uid())
  and (public.is_nexora_super_admin() or exists (
    select 1 from public.merchant_onboarding m where m.user_id=auth.uid() and m.status='APPROVED'
  )) and exists (select 1 from public.businesses b where b.id=business_id and b.owner_id=auth.uid()));

revoke all on function public.nexora_assert_workspace() from public,anon,authenticated;
revoke all on function public.get_my_access() from public,anon;
revoke all on function public.nexora_workspace_read_id() from public,anon,authenticated;
revoke all on function public.nexora_workspace_snapshot() from public,anon;
grant execute on function public.get_my_access() to authenticated;
grant execute on function public.nexora_workspace_snapshot() to authenticated;
notify pgrst,'reload schema';
commit;

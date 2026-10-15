-- Nexora Pay: correção consolidada. Execute UMA VEZ no SQL Editor (pode repetir).
-- Requer as tabelas já criadas pelos SQL anteriores. Não apaga registros.
-- Mantenha o modo sandbox até implementar e validar a integração da IP.
begin;

do $$ begin
  if to_regclass('public.nexora_transactions') is null or to_regclass('public.nexora_customers') is null
     or to_regclass('public.nexora_withdrawals') is null or to_regclass('public.user_settings') is null
     or to_regclass('public.nexora_admins') is null then
    raise exception 'Execute primeiro os SQL anteriores: access-control, user-settings, nexora-super-admin e nexora-data.';
  end if;
end $$;

create table if not exists public.nexora_account_controls (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'active' check (status in ('active','suspended')),
  reason text,
  updated_at timestamptz not null default now()
);
create table if not exists public.nexora_runtime_config (
  id boolean primary key default true check (id),
  sandbox boolean not null default true,
  gateway_ready boolean not null default false
);
insert into public.nexora_runtime_config (id) values (true) on conflict do nothing;
create table if not exists public.nexora_site_settings (
  id boolean primary key default true check (id),
  content jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.nexora_site_settings (id) values (true) on conflict do nothing;
create table if not exists public.nexora_audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id),
  action text not null,
  target_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.nexora_account_controls enable row level security;
alter table public.nexora_runtime_config enable row level security;
alter table public.nexora_site_settings enable row level security;
alter table public.nexora_audit_log enable row level security;
revoke all on public.nexora_account_controls, public.nexora_runtime_config,
  public.nexora_site_settings, public.nexora_audit_log from public, anon, authenticated;

alter table public.nexora_customers alter column email drop not null;
alter table public.nexora_transactions add column if not exists customer_id uuid references public.nexora_customers(id);
alter table public.nexora_transactions add column if not exists source text not null default 'legacy';
alter table public.nexora_transactions add column if not exists payment_method text not null default 'pix';
alter table public.nexora_transactions add column if not exists destination text;
alter table public.nexora_transactions add column if not exists request_id uuid;
alter table public.nexora_transactions add column if not exists provider_reference text;
alter table public.nexora_transactions add column if not exists fee numeric(14,2);
alter table public.nexora_withdrawals add column if not exists transaction_id uuid references public.nexora_transactions(id);
alter table public.user_settings add column if not exists notifications_read_at timestamptz;
alter table public.nexora_transactions drop constraint if exists nexora_transactions_status_check;
alter table public.nexora_transactions add constraint nexora_transactions_status_check
  check (status in ('pending','processing','paid','cancelled'));
create unique index if not exists nexora_tx_request_key on public.nexora_transactions(owner_id, request_id) where request_id is not null;
create index if not exists nexora_tx_workspace_date on public.nexora_transactions(business_id, created_at desc);
create index if not exists nexora_tx_customer on public.nexora_transactions(customer_id);

-- Apenas associa registros legados existentes. Não cria/exclui pagamentos nem clientes.
update public.nexora_transactions t set customer_id = (
  select c.id from public.nexora_customers c
  where c.business_id=t.business_id and c.owner_id=t.owner_id
    and ((nullif(t.customer_email,'') is not null and lower(c.email)=lower(t.customer_email))
      or (nullif(t.customer_email,'') is null and c.name=t.customer_name))
  order by c.created_at, c.id limit 1
) where t.customer_id is null and t.kind <> 'withdrawal';

create or replace function public.nexora_account_active(p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_user_id is not null and not exists (
    select 1 from public.nexora_account_controls where user_id=p_user_id and status='suspended'
  );
$$;

create or replace function public.is_nexora_super_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users u join public.nexora_admins a on lower(trim(a.email))=lower(trim(u.email))
    where u.id=auth.uid() and a.role='super_admin' and public.nexora_account_active(u.id)
  );
$$;

create or replace function public.get_my_access()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_id uuid; v_name text;
begin
  if v_user is null then raise exception 'Sessão expirada. Entre novamente.'; end if;
  if not public.nexora_account_active(v_user) then
    return jsonb_build_object('can_access',false,'access_status','suspended');
  end if;
  -- Serializa bootstrap do mesmo usuário, sem trocar permissões de outras contas.
  perform 1 from auth.users where id=v_user for update;
  select id,name into v_id,v_name from public.businesses where owner_id=v_user order by id limit 1;
  if v_id is null then
    select coalesce(nullif(trim(raw_user_meta_data->>'full_name'),''),split_part(email,'@',1)) || ' · Nexora'
      into v_name from auth.users where id=v_user;
    insert into public.businesses(owner_id,name,document) values(v_user,v_name,null) returning id into v_id;
  end if;
  insert into public.workspace_members(business_id,user_id,role) values(v_id,v_user,'owner') on conflict do nothing;
  return jsonb_build_object('user_id',v_user,'business_id',v_id,'business_name',v_name,
    'role','owner','can_access',true,'access_status','active','is_nexora_admin',public.is_nexora_super_admin());
end;
$$;

create or replace function public.nexora_assert_workspace()
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Sessão expirada. Entre novamente.'; end if;
  if not public.nexora_account_active(auth.uid()) then raise exception 'Conta suspensa. Entre em contato com o suporte.'; end if;
  select id into v_id from public.businesses where owner_id=auth.uid() order by id limit 1;
  if v_id is null then raise exception 'Workspace não encontrado. Entre novamente.'; end if;
  return v_id;
end;
$$;

create or replace function public.nexora_balance(p_business uuid)
returns numeric language sql stable security definer set search_path = '' as $$
  select coalesce(sum(case when t.kind <> 'withdrawal' and t.status='paid' then t.amount
    when t.kind='withdrawal' and t.status in ('pending','processing','paid') then -t.amount else 0 end),0)
  from public.nexora_transactions t join public.businesses b on b.id=t.business_id and b.owner_id=t.owner_id
  where b.id=p_business;
$$;

-- Todos os writes financeiros via funções validadas. RLS nega workspace forjado.
drop policy if exists "owners manage own nexora customers" on public.nexora_customers;
drop policy if exists "owners manage own nexora transactions" on public.nexora_transactions;
drop policy if exists "owners manage own nexora withdrawals" on public.nexora_withdrawals;
drop policy if exists nexora_customer_read on public.nexora_customers;
create policy nexora_customer_read on public.nexora_customers for select to authenticated
using (owner_id=auth.uid() and public.nexora_account_active(auth.uid())
  and exists(select 1 from public.businesses b where b.id=business_id and b.owner_id=auth.uid()));
drop policy if exists nexora_transaction_read on public.nexora_transactions;
create policy nexora_transaction_read on public.nexora_transactions for select to authenticated
using (owner_id=auth.uid() and public.nexora_account_active(auth.uid())
  and exists(select 1 from public.businesses b where b.id=business_id and b.owner_id=auth.uid()));
drop policy if exists nexora_withdrawal_read on public.nexora_withdrawals;
create policy nexora_withdrawal_read on public.nexora_withdrawals for select to authenticated
using (owner_id=auth.uid() and public.nexora_account_active(auth.uid())
  and exists(select 1 from public.businesses b where b.id=business_id and b.owner_id=auth.uid()));
revoke insert, update, delete, truncate on public.nexora_customers, public.nexora_transactions, public.nexora_withdrawals from public, anon, authenticated;
grant select on public.nexora_customers, public.nexora_transactions, public.nexora_withdrawals to authenticated;
-- As configurações também passam pela função única, para manter nomes consistentes.
revoke insert,update,delete on public.user_settings from anon,authenticated;

create or replace function public.nexora_workspace_snapshot()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid := public.nexora_assert_workspace(); v_settings jsonb; v_transactions jsonb; v_customers jsonb;
begin
  select to_jsonb(s) into v_settings from public.user_settings s where s.user_id=auth.uid();
  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc,t.id),'[]') into v_transactions
    from public.nexora_transactions t where t.business_id=v_id and t.owner_id=auth.uid();
  select coalesce(jsonb_agg(to_jsonb(c) order by c.last_activity desc,c.id),'[]') into v_customers from (
    select c.id,c.name,c.email,
      coalesce(sum(t.amount) filter(where t.kind <> 'withdrawal' and t.status='paid'),0) as total,
      coalesce(max(coalesce(t.paid_at,t.created_at)),c.created_at) as last_activity
    from public.nexora_customers c left join public.nexora_transactions t on t.customer_id=c.id
      and t.business_id=c.business_id and t.owner_id=c.owner_id
    where c.business_id=v_id and c.owner_id=auth.uid() group by c.id
  ) c;
  return jsonb_build_object('transactions',v_transactions,'customers',v_customers,'settings',coalesce(v_settings,'{}'),
    'business_id',v_id,'business_name',(select name from public.businesses where id=v_id),
    'balance',public.nexora_balance(v_id),'sandbox',(select sandbox from public.nexora_runtime_config where id),
    'gateway_ready',(select gateway_ready from public.nexora_runtime_config where id));
end;
$$;

-- Helper privado (sem EXECUTE para clientes). Escrita do cliente sempre segura abaixo.
create or replace function public.nexora_customer_upsert(p_business uuid,p_name text,p_email text,p_customer uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_email text := nullif(lower(trim(p_email)),'');
begin
  if nullif(trim(p_name),'') is null or length(p_name)>160 then raise exception 'Informe um nome de cliente válido.'; end if;
  if v_email is not null and (length(v_email)>254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then raise exception 'Informe um e-mail válido.'; end if;
  if p_customer is not null then
    select id into v_id from public.nexora_customers where id=p_customer and business_id=p_business and owner_id=auth.uid();
    if v_id is null then raise exception 'Cliente não pertence a este workspace.'; end if;
  else
    select id into v_id from public.nexora_customers where business_id=p_business and owner_id=auth.uid()
      and ((v_email is not null and lower(email)=v_email) or (v_email is null and email is null and lower(name)=lower(trim(p_name))))
      order by created_at,id limit 1;
  end if;
  if v_id is null then
    insert into public.nexora_customers(owner_id,business_id,name,email,total)
      values(auth.uid(),p_business,trim(p_name),v_email,0) returning id into v_id;
  elsif p_customer is not null then
    update public.nexora_customers set name=trim(p_name),email=v_email where id=v_id;
  end if;
  return v_id;
end;
$$;

create or replace function public.nexora_save_customer(p_name text,p_email text,p_customer_id uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_business uuid := public.nexora_assert_workspace();
begin
  perform 1 from public.businesses where id=v_business for update;
  return public.nexora_customer_upsert(v_business,p_name,p_email,p_customer_id);
end;
$$;

create or replace function public.nexora_create_record(p_request_id uuid,p_kind text,p_amount numeric,p_title text,
  p_customer_name text,p_customer_email text default null,p_customer_id uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_business uuid := public.nexora_assert_workspace(); v_customer uuid; v_id uuid;
begin
  perform 1 from public.businesses where id=v_business for update;
  select id into v_id from public.nexora_transactions where owner_id=auth.uid() and request_id=p_request_id;
  if v_id is not null then return v_id; end if;
  if p_request_id is null or p_kind not in ('payment','charge') or p_amount is null
    or p_amount <= 0 or p_amount <> round(p_amount,2) or p_amount > 9999999999.99 then raise exception 'Movimentação inválida.'; end if;
  if not (select sandbox from public.nexora_runtime_config where id) then
    raise exception 'Registros manuais indisponíveis em produção. Use a integração de pagamentos.';
  end if;
  if nullif(trim(p_title),'') is null or length(p_title)>250 then raise exception 'Informe uma descrição válida.'; end if;
  v_customer := public.nexora_customer_upsert(v_business,p_customer_name,p_customer_email,p_customer_id);
  insert into public.nexora_transactions(owner_id,business_id,external_id,title,customer_id,customer_name,customer_email,
    amount,kind,status,source,request_id,paid_at)
    select auth.uid(),v_business,'NX-'||upper(substr(replace(p_request_id::text,'-',''),1,12)),trim(p_title),c.id,c.name,c.email,
      p_amount,p_kind,case when p_kind='payment' then 'paid' else 'pending' end,'manual',p_request_id,
      case when p_kind='payment' then now() else null end
    from public.nexora_customers c where c.id=v_customer returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.nexora_confirm_record(p_transaction_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_business uuid := public.nexora_assert_workspace(); v_tx public.nexora_transactions;
begin
  perform 1 from public.businesses where id=v_business for update;
  select * into v_tx from public.nexora_transactions where id=p_transaction_id and business_id=v_business and owner_id=auth.uid() for update;
  if not found then raise exception 'Transação não encontrada.'; end if;
  if not (select sandbox from public.nexora_runtime_config where id) or v_tx.source='gateway' then raise exception 'Liquidação deve ser confirmada pela IP.'; end if;
  if v_tx.kind='withdrawal' then raise exception 'Saque não é um recebimento.'; end if;
  if v_tx.status='paid' then return v_tx.id; end if;
  if v_tx.kind <> 'charge' or v_tx.status <> 'pending' then raise exception 'Esta cobrança não pode ser confirmada.'; end if;
  update public.nexora_transactions set kind='payment',status='paid',paid_at=coalesce(paid_at,now()) where id=v_tx.id;
  return v_tx.id;
end;
$$;

create or replace function public.nexora_request_withdrawal(p_request_id uuid,p_amount numeric,p_destination text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_business uuid := public.nexora_assert_workspace(); v_id uuid;
begin
  perform 1 from public.businesses where id=v_business for update;
  select id into v_id from public.nexora_transactions where owner_id=auth.uid() and request_id=p_request_id;
  if v_id is not null then return v_id; end if;
  if not (select sandbox from public.nexora_runtime_config where id) then raise exception 'Saque real indisponível até a integração com a IP.'; end if;
  if p_request_id is null or p_amount is null or p_amount <= 0 or p_amount<>round(p_amount,2)
    or p_amount>public.nexora_balance(v_business) then raise exception 'Valor maior que o saldo de simulação disponível.'; end if;
  if nullif(trim(p_destination),'') is null or length(p_destination)>254 then raise exception 'Informe uma chave Pix válida.'; end if;
  insert into public.nexora_transactions(owner_id,business_id,external_id,title,amount,kind,status,source,destination,request_id)
    values(auth.uid(),v_business,'NX-SAQUE-'||upper(substr(replace(p_request_id::text,'-',''),1,12)),
      'Solicitação de saque',p_amount,'withdrawal','pending','manual',trim(p_destination),p_request_id) returning id into v_id;
  insert into public.nexora_withdrawals(owner_id,business_id,amount,destination,status,transaction_id)
    values(auth.uid(),v_business,p_amount,trim(p_destination),'pending',v_id);
  return v_id;
end;
$$;

create or replace function public.nexora_save_settings(p_profile_name text,p_workspace_name text,p_alerts boolean,p_chart_range text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_business uuid := public.nexora_assert_workspace(); v_settings public.user_settings;
begin
  if nullif(trim(p_profile_name),'') is null or length(p_profile_name)>160 or nullif(trim(p_workspace_name),'') is null
    or length(p_workspace_name)>160 then raise exception 'Preencha nome e workspace (até 160 caracteres).'; end if;
  if p_chart_range not in ('Últimos 7 dias','Último mês','Últimos 6 meses','Este ano') then raise exception 'Período inválido.'; end if;
  update public.businesses set name=trim(p_workspace_name) where id=v_business;
  insert into public.user_settings(user_id,profile_name,workspace_name,alerts,weekly,chart_range)
    values(auth.uid(),trim(p_profile_name),trim(p_workspace_name),coalesce(p_alerts,true),false,p_chart_range)
    on conflict(user_id) do update set profile_name=excluded.profile_name,workspace_name=excluded.workspace_name,
      alerts=excluded.alerts,weekly=false,chart_range=excluded.chart_range,updated_at=now() returning * into v_settings;
  return to_jsonb(v_settings);
end;
$$;

create or replace function public.nexora_read_notifications()
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.nexora_assert_workspace();
  insert into public.user_settings(user_id,notifications_read_at) values(auth.uid(),now())
    on conflict(user_id) do update set notifications_read_at=excluded.notifications_read_at;
end;
$$;

create or replace function public.nexora_public_site_settings()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce((select content from public.nexora_site_settings where id),'{}'::jsonb);
$$;

create or replace function public.nexora_admin_snapshot(p_query text default '',p_page integer default 0,p_limit integer default 25,
  p_customer_query text default '',p_customer_page integer default 0)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_accounts jsonb; v_customers jsonb; v_count integer; v_customer_count integer; v_limit integer := least(greatest(p_limit,1),100);
begin
  if not public.is_nexora_super_admin() then raise exception 'Acesso restrito ao Painel Nexora Pay.'; end if;
  select count(*) into v_count from auth.users u left join public.user_settings s on s.user_id=u.id
    where concat_ws(' ',u.email,s.profile_name,u.raw_user_meta_data->>'full_name') ilike '%'||left(p_query,160)||'%';
  select coalesce(jsonb_agg(to_jsonb(a)),'[]') into v_accounts from (
    select u.id as user_id,u.email,coalesce(nullif(s.profile_name,''),nullif(u.raw_user_meta_data->>'full_name',''),split_part(u.email,'@',1)) as full_name,
      u.created_at,u.last_sign_in_at,coalesce(ac.status,'active') as status,ac.reason,
      (select jsonb_agg(jsonb_build_object('id',b.id,'name',b.name)) from public.businesses b where b.owner_id=u.id) as workspaces,
      (select exists(select 1 from public.nexora_admins na where lower(na.email)=lower(u.email))) as is_admin
    from auth.users u left join public.user_settings s on s.user_id=u.id left join public.nexora_account_controls ac on ac.user_id=u.id
    where concat_ws(' ',u.email,s.profile_name,u.raw_user_meta_data->>'full_name') ilike '%'||left(p_query,160)||'%'
    order by u.created_at desc,u.id limit v_limit offset greatest(p_page,0)*v_limit
  ) a;
  select count(*) into v_customer_count from public.nexora_customers c join public.businesses b on b.id=c.business_id and b.owner_id=c.owner_id
    where concat_ws(' ',c.name,c.email,b.name) ilike '%'||left(p_customer_query,160)||'%';
  select coalesce(jsonb_agg(to_jsonb(c)),'[]') into v_customers from (
    select c.id,c.name,c.email,c.owner_id,c.business_id,b.name as business_name,
      coalesce((select sum(t.amount) from public.nexora_transactions t where t.customer_id=c.id and t.owner_id=c.owner_id
        and t.business_id=c.business_id and t.kind<>'withdrawal' and t.status='paid'),0) as total,
      coalesce((select max(coalesce(t.paid_at,t.created_at)) from public.nexora_transactions t where t.customer_id=c.id
        and t.owner_id=c.owner_id and t.business_id=c.business_id),c.created_at) as last_activity
    from public.nexora_customers c join public.businesses b on b.id=c.business_id and b.owner_id=c.owner_id
    where concat_ws(' ',c.name,c.email,b.name) ilike '%'||left(p_customer_query,160)||'%'
    order by c.created_at desc,c.id limit v_limit offset greatest(p_customer_page,0)*v_limit
  ) c;
  return jsonb_build_object('accounts',v_accounts,'account_count',v_count,'customers',v_customers,'customer_count',v_customer_count,
    'stats',jsonb_build_object('accounts',(select count(*) from auth.users),
      'active_accounts',(select count(*) from auth.users u where public.nexora_account_active(u.id)),
      'suspended_accounts',(select count(*) from public.nexora_account_controls where status='suspended'),
      'workspaces',(select count(*) from public.businesses)),
    'withdrawals',(select coalesce(jsonb_agg(to_jsonb(w)),'[]') from (select w.*,b.name as business_name,u.email
      from public.nexora_withdrawals w join public.businesses b on b.id=w.business_id and b.owner_id=w.owner_id
      join auth.users u on u.id=w.owner_id order by w.created_at desc limit 100) w),
    'audit',(select coalesce(jsonb_agg(to_jsonb(l)),'[]') from (select id,action,target_id,created_at from public.nexora_audit_log order by id desc limit 30) l),
    'site',public.nexora_public_site_settings(),'sandbox',(select sandbox from public.nexora_runtime_config where id));
end;
$$;

create or replace function public.nexora_admin_transactions(p_user_id uuid,p_customer_id uuid default null,p_page integer default 0)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_rows jsonb; v_count integer;
begin
  if not public.is_nexora_super_admin() then raise exception 'Acesso restrito ao Painel Nexora Pay.'; end if;
  select count(*) into v_count from public.nexora_transactions t join public.businesses b on b.id=t.business_id and b.owner_id=t.owner_id
    where t.owner_id=p_user_id and (p_customer_id is null or t.customer_id=p_customer_id);
  select coalesce(jsonb_agg(to_jsonb(t)),'[]') into v_rows from (
    select t.*,b.name as business_name from public.nexora_transactions t join public.businesses b on b.id=t.business_id and b.owner_id=t.owner_id
    where t.owner_id=p_user_id and (p_customer_id is null or t.customer_id=p_customer_id)
    order by t.created_at desc,t.id limit 50 offset greatest(p_page,0)*50
  ) t;
  return jsonb_build_object('rows',v_rows,'count',v_count);
end;
$$;

create or replace function public.nexora_admin_set_account(p_user_id uuid,p_status text,p_reason text default '')
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_nexora_super_admin() then raise exception 'Acesso restrito.'; end if;
  if p_user_id=auth.uid() then raise exception 'Não é permitido suspender a própria conta administrativa.'; end if;
  if p_status not in ('active','suspended') or not exists(select 1 from auth.users where id=p_user_id) then raise exception 'Conta/status inválido.'; end if;
  if exists(select 1 from public.nexora_admins a join auth.users u on lower(u.email)=lower(a.email) where u.id=p_user_id) then
    raise exception 'Contas administrativas devem ser gerenciadas por um responsável no Supabase.';
  end if;
  insert into public.nexora_account_controls(user_id,status,reason) values(p_user_id,p_status,left(p_reason,500))
    on conflict(user_id) do update set status=excluded.status,reason=excluded.reason,updated_at=now();
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(auth.uid(),'account.'||p_status,p_user_id::text,jsonb_build_object('reason',left(p_reason,500)));
end;
$$;

create or replace function public.nexora_admin_review_withdrawal(p_id uuid,p_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_w public.nexora_withdrawals;
begin
  if not public.is_nexora_super_admin() then raise exception 'Acesso restrito.'; end if;
  if not (select sandbox from public.nexora_runtime_config where id) then raise exception 'Saques reais devem ser liquidados pela IP.'; end if;
  select * into v_w from public.nexora_withdrawals where id=p_id;
  if not found or v_w.transaction_id is null then raise exception 'Saque legado sem vínculo. Revise os dados antes de atualizar.'; end if;
  perform 1 from public.businesses where id=v_w.business_id and owner_id=v_w.owner_id for update;
  if not found then raise exception 'Workspace inválido.'; end if;
  select * into v_w from public.nexora_withdrawals where id=p_id for update;
  if p_status not in ('processing','paid','cancelled') or v_w.status not in ('pending','processing') then raise exception 'Transição de saque inválida.'; end if;
  update public.nexora_transactions set status=p_status,paid_at=case when p_status='paid' then coalesce(paid_at,now()) else paid_at end
    where id=v_w.transaction_id and owner_id=v_w.owner_id and business_id=v_w.business_id and kind='withdrawal';
  if not found then raise exception 'Transação do saque não encontrada.'; end if;
  update public.nexora_withdrawals set status=p_status where id=p_id;
  insert into public.nexora_audit_log(actor_id,action,target_id) values(auth.uid(),'withdrawal.'||p_status,p_id::text);
end;
$$;

create or replace function public.nexora_admin_save_site(p_content jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_key text; v_value text;
begin
  if not public.is_nexora_super_admin() then raise exception 'Acesso restrito.'; end if;
  if jsonb_typeof(p_content)<>'object' then raise exception 'Configuração inválida.'; end if;
  for v_key,v_value in select key,value from jsonb_each_text(p_content) loop
    if v_key not in ('accent','hero_title','hero_subtitle','hero_description','hero_image','logo_url',
      'pix_rate','withdrawal_rate','support_email','privacy_email','legal_name','document') then raise exception 'Campo não permitido: %',v_key; end if;
    if length(v_value)>2000 then raise exception 'Conteúdo muito longo.'; end if;
    if v_key='accent' and v_value !~ '^#[0-9a-fA-F]{6}$' then raise exception 'Cor inválida.'; end if;
    if v_key in ('hero_image','logo_url') and v_value<>'' and v_value !~ '^https://' then raise exception 'Use uma URL HTTPS para imagens.'; end if;
    if v_key in ('support_email','privacy_email') and v_value<>'' and v_value !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'E-mail inválido.'; end if;
  end loop;
  update public.nexora_site_settings set content=content||p_content,updated_at=now() where id;
  insert into public.nexora_audit_log(actor_id,action,details) values(auth.uid(),'site.updated',jsonb_build_object('fields',to_jsonb(array(select jsonb_object_keys(p_content)))));
end;
$$;

-- Fecha helpers e funções RPC novas por padrão; só libera a lista necessária.
revoke all on function public.nexora_assert_workspace(),public.nexora_balance(uuid),
  public.nexora_customer_upsert(uuid,text,text,uuid) from public,anon,authenticated;
revoke all on function public.nexora_account_active(uuid),public.is_nexora_super_admin(),public.get_my_access(),
  public.nexora_workspace_snapshot(),public.nexora_save_customer(text,text,uuid),
  public.nexora_create_record(uuid,text,numeric,text,text,text,uuid),public.nexora_confirm_record(uuid),
  public.nexora_request_withdrawal(uuid,numeric,text),public.nexora_save_settings(text,text,boolean,text),
  public.nexora_read_notifications(),public.nexora_admin_snapshot(text,integer,integer,text,integer),
  public.nexora_admin_transactions(uuid,uuid,integer),public.nexora_admin_set_account(uuid,text,text),
  public.nexora_admin_review_withdrawal(uuid,text),public.nexora_admin_save_site(jsonb),
  public.nexora_public_site_settings() from public,anon,authenticated;
grant execute on function public.nexora_account_active(uuid),public.is_nexora_super_admin(),public.get_my_access(),
  public.nexora_workspace_snapshot(),public.nexora_save_customer(text,text,uuid),
  public.nexora_create_record(uuid,text,numeric,text,text,text,uuid),public.nexora_confirm_record(uuid),
  public.nexora_request_withdrawal(uuid,numeric,text),public.nexora_save_settings(text,text,boolean,text),
  public.nexora_read_notifications(),public.nexora_admin_snapshot(text,integer,integer,text,integer),
  public.nexora_admin_transactions(uuid,uuid,integer),public.nexora_admin_set_account(uuid,text,text),
  public.nexora_admin_review_withdrawal(uuid,text),public.nexora_admin_save_site(jsonb) to authenticated;
grant execute on function public.nexora_public_site_settings() to anon,authenticated;
notify pgrst,'reload schema';
-- Imagens públicas de marketing; apenas admins podem enviar. Não use para documentos.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('nexora-site','nexora-site',true,5242880,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
drop policy if exists nexora_site_image_upload on storage.objects;
create policy nexora_site_image_upload on storage.objects for insert to authenticated
with check(bucket_id='nexora-site' and public.is_nexora_super_admin());
commit;

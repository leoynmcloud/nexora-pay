-- Nexora Pay: cobranças reais de teste pelo Asaas Sandbox.
-- Execute após nexora-repair.sql, nexora-onboarding-kyc.sql,
-- nexora-admin-usability.sql e nexora-security-hardening.sql.
-- Não habilita produção, saques, nem reutiliza credenciais de produção.
begin;

do $$ begin
  if to_regclass('public.nexora_transactions') is null
     or to_regclass('public.nexora_merchant_provider_connections') is null
     or to_regclass('public.nexora_acquirers') is null
     or to_regclass('public.merchant_onboarding') is null
     or to_regclass('public.nexora_merchant_controls') is null
     or to_regclass('public.nexora_runtime_config') is null
     or to_regprocedure('public.nexora_account_active(uuid)') is null
     or to_regprocedure('public.is_nexora_super_admin()') is null
     or to_regprocedure('public.nexora_balance(uuid)') is null
     or to_regprocedure('public.nexora_admin_snapshot(text,integer,integer,text,integer)') is null then
    raise exception 'Execute primeiro as migrações base, de cadastro/adquirentes, do painel e de segurança.';
  end if;
end $$;

alter table public.nexora_transactions
  add column if not exists test_mode boolean not null default false;
alter table public.nexora_transactions drop constraint if exists nexora_transactions_status_check;
alter table public.nexora_transactions add constraint nexora_transactions_status_check
  check (status in ('pending','processing','paid','cancelled'));

create or replace function public.nexora_balance(p_business uuid)
returns numeric language sql stable security definer set search_path = '' as $$
  select coalesce(sum(case when t.kind <> 'withdrawal' and t.status='paid' then t.amount
    when t.kind='withdrawal' and t.status in ('pending','processing','paid') then -t.amount else 0 end),0)
  from public.nexora_transactions t join public.businesses b on b.id=t.business_id and b.owner_id=t.owner_id
  where b.id=p_business and not t.test_mode;
$$;

insert into public.nexora_acquirers(code,name,api_base_url,webhook_url,environment,payment_methods,status,notes)
values('asaas_sandbox','Asaas · ambiente de testes','https://api-sandbox.asaas.com/v3',null,'sandbox',array['pix']::text[],'enabled',
  'Cobranças Pix de teste. Não movimenta dinheiro real. A credencial é configurada apenas pelo Super Admin.')
on conflict(code) do update set name=excluded.name,api_base_url=excluded.api_base_url,
  webhook_url=null,environment='sandbox',payment_methods=array['pix']::text[],status='enabled',
  notes=excluded.notes,updated_at=now();

create table if not exists public.nexora_asaas_sandbox_operations (
  id bigint generated always as identity primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key uuid not null,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  transaction_id uuid references public.nexora_transactions(id) on delete set null,
  external_reference text not null unique,
  provider_reference text,
  provider_customer_id text,
  payment_attempted_at timestamptz,
  lease_expires_at timestamptz,
  status text not null default 'processing' check (status in ('processing','succeeded','failed','unknown')),
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(business_id,idempotency_key)
);

alter table public.nexora_asaas_sandbox_operations
  add column if not exists provider_customer_id text,
  add column if not exists payment_attempted_at timestamptz,
  add column if not exists lease_expires_at timestamptz;

create table if not exists public.nexora_asaas_sandbox_payment_details (
  transaction_id uuid primary key references public.nexora_transactions(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  provider_reference text not null,
  provider_status text not null,
  invoice_url text,
  pix_copy_paste text,
  pix_encoded_image text,
  pix_expiration timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists nexora_asaas_sandbox_owner_date
  on public.nexora_transactions(owner_id,created_at desc) where test_mode;
alter table public.nexora_asaas_sandbox_operations enable row level security;
alter table public.nexora_asaas_sandbox_payment_details enable row level security;
revoke all on public.nexora_asaas_sandbox_operations,public.nexora_asaas_sandbox_payment_details from public,anon,authenticated;
grant all on public.nexora_asaas_sandbox_operations,public.nexora_asaas_sandbox_payment_details to service_role;

-- Só super admins podem salvar ciphertext; a chave em texto puro nunca chega ao Postgres.
create or replace function public.nexora_admin_save_provider_credential(p_owner_id uuid,p_api_key_ciphertext text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_business uuid;
begin
  if not public.is_nexora_super_admin() then raise exception 'Acesso restrito ao Painel Nexora Pay.'; end if;
  if p_owner_id is null or p_api_key_ciphertext is null or length(p_api_key_ciphertext)>12000
    or p_api_key_ciphertext !~ '^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$' then
    raise exception 'Credencial criptografada inválida.';
  end if;
  select b.id into v_business from public.businesses b where b.owner_id=p_owner_id order by b.id limit 1;
  if v_business is null then raise exception 'Workspace não encontrado.'; end if;
  if not exists(select 1 from public.nexora_merchant_provider_connections c
      join public.nexora_acquirers a on a.id=c.acquirer_id
      where c.business_id=v_business and c.owner_id=p_owner_id and a.code='asaas_sandbox'
        and a.environment='sandbox' and a.api_base_url='https://api-sandbox.asaas.com/v3'
        and a.status='enabled') then
    raise exception 'Atribua o Asaas Sandbox a esta conta antes de configurar a chave.';
  end if;
  update public.nexora_merchant_provider_connections
  set api_key_ciphertext=p_api_key_ciphertext,status='active',last_error=null,
      configured_at=now(),updated_at=now()
  where business_id=v_business and owner_id=p_owner_id;
  if not found then raise exception 'Conexão Asaas Sandbox não encontrada.'; end if;
end;
$$;

create or replace function public.nexora_asaas_sandbox_begin_charge(
  p_owner_id uuid,p_business_id uuid,p_request_id uuid,p_request_hash text,
  p_customer_name text,p_customer_email text,p_customer_document text,
  p_amount numeric,p_description text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_operation public.nexora_asaas_sandbox_operations;
  v_inserted integer;
  v_claimed boolean := false;
  v_customer_id uuid;
  v_transaction_id uuid;
  v_external_reference text;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_owner_id is null or p_business_id is null or p_request_id is null
    or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
    or length(trim(coalesce(p_customer_name,''))) not between 2 and 160
    or p_customer_document is null or p_customer_document !~ '^[0-9]{11}([0-9]{3})?$'
    or p_amount is null or p_amount<=0 or p_amount<>round(p_amount,2) or p_amount>999999.99
    or length(trim(coalesce(p_description,''))) not between 2 and 120 then
    raise exception 'Dados da cobrança inválidos.';
  end if;
  if not exists(select 1 from public.businesses b where b.id=p_business_id and b.owner_id=p_owner_id)
    or not exists(select 1 from public.merchant_onboarding m where m.user_id=p_owner_id and m.status='APPROVED')
    or not public.nexora_account_active(p_owner_id)
    or not exists(select 1 from public.nexora_merchant_controls c where c.business_id=p_business_id
      and c.owner_id=p_owner_id and c.payments_enabled)
    or not exists(select 1 from public.nexora_merchant_provider_connections c
      join public.nexora_acquirers a on a.id=c.acquirer_id
      where c.business_id=p_business_id and c.owner_id=p_owner_id and c.status='active'
        and c.api_key_ciphertext is not null and a.code='asaas_sandbox'
        and a.environment='sandbox' and a.api_base_url='https://api-sandbox.asaas.com/v3' and a.status='enabled') then
    raise exception 'Cadastro aprovado, recebimentos liberados e conexão Asaas Sandbox ativa são necessários.';
  end if;

  v_external_reference := 'NX-'||upper(replace(p_request_id::text,'-',''));
  insert into public.nexora_asaas_sandbox_operations(business_id,owner_id,idempotency_key,request_hash,external_reference,lease_expires_at)
  values(p_business_id,p_owner_id,p_request_id,p_request_hash,v_external_reference,now()+interval '90 seconds')
  on conflict(business_id,idempotency_key) do nothing;
  get diagnostics v_inserted = row_count;
  select * into v_operation from public.nexora_asaas_sandbox_operations
    where business_id=p_business_id and idempotency_key=p_request_id for update;
  if v_operation.request_hash<>p_request_hash then raise exception 'Esta chave de idempotência já foi usada com outros dados.'; end if;

  if v_inserted=1 then
    v_claimed := true;
    if nullif(trim(coalesce(p_customer_email,'')),'') is not null then
      insert into public.nexora_customers(owner_id,business_id,name,email,last_activity)
      values(p_owner_id,p_business_id,trim(p_customer_name),lower(trim(p_customer_email)),now())
      on conflict(business_id,email) do update set name=excluded.name,last_activity=now()
      returning id into v_customer_id;
    else
      insert into public.nexora_customers(owner_id,business_id,name,email,last_activity)
      values(p_owner_id,p_business_id,trim(p_customer_name),null,now()) returning id into v_customer_id;
    end if;
    insert into public.nexora_transactions(owner_id,business_id,external_id,title,customer_id,customer_name,
      customer_email,amount,kind,status,source,payment_method,request_id,test_mode)
    values(p_owner_id,p_business_id,'NX-'||upper(substr(replace(p_request_id::text,'-',''),1,12)),
      trim(p_description),v_customer_id,trim(p_customer_name),nullif(lower(trim(coalesce(p_customer_email,''))),''),
      p_amount,'payment','pending','gateway','pix',p_request_id,true)
    returning id into v_transaction_id;
    update public.nexora_asaas_sandbox_operations set transaction_id=v_transaction_id,updated_at=now()
      where id=v_operation.id returning * into v_operation;
  else
    v_transaction_id := v_operation.transaction_id;
    if v_operation.status not in ('failed','succeeded')
       and v_operation.payment_attempted_at is null
       and (v_operation.lease_expires_at is null or v_operation.lease_expires_at<=now()) then
      update public.nexora_asaas_sandbox_operations set status='processing',lease_expires_at=now()+interval '90 seconds',updated_at=now()
        where id=v_operation.id returning * into v_operation;
      v_claimed := true;
    end if;
  end if;
  return jsonb_build_object('operation_id',v_operation.id,'status',v_operation.status,
    'is_new',v_claimed,'payment_attempted_at',v_operation.payment_attempted_at,
    'transaction_id',coalesce(v_transaction_id,v_operation.transaction_id),
    'external_reference',v_operation.external_reference,'provider_reference',v_operation.provider_reference,
    'owner_id',v_operation.owner_id,'business_id',v_operation.business_id);
end;
$$;

create or replace function public.nexora_asaas_sandbox_mark_payment_attempt(p_operation_id bigint,p_customer_id text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_operation public.nexora_asaas_sandbox_operations;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_operation_id is null or nullif(trim(p_customer_id),'') is null or length(p_customer_id)>100 then
    raise exception 'Referência do pagador inválida.';
  end if;
  select * into v_operation from public.nexora_asaas_sandbox_operations where id=p_operation_id for update;
  if not found or v_operation.transaction_id is null or v_operation.status in ('failed','succeeded') then
    raise exception 'Operação indisponível para envio.';
  end if;
  if v_operation.payment_attempted_at is not null then raise exception 'Esta cobrança já foi enviada ou está em verificação.'; end if;
  update public.nexora_asaas_sandbox_operations set provider_customer_id=trim(p_customer_id),
    payment_attempted_at=now(),lease_expires_at=null,status='unknown',updated_at=now() where id=p_operation_id;
end;
$$;

create or replace function public.nexora_asaas_sandbox_complete_charge(
  p_operation_id bigint,p_provider_reference text,p_provider_status text,p_transaction_status text,
  p_invoice_url text,p_pix_copy_paste text,p_pix_encoded_image text,p_pix_expiration timestamptz
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_operation public.nexora_asaas_sandbox_operations;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_operation_id is null or nullif(trim(p_provider_reference),'') is null
    or length(p_provider_reference)>255 or length(coalesce(p_provider_status,''))>80
    or p_transaction_status not in ('pending','processing','paid','cancelled')
    or length(coalesce(p_invoice_url,''))>2000 or length(coalesce(p_pix_copy_paste,''))>5000
    or length(coalesce(p_pix_encoded_image,''))>100000 then raise exception 'Resposta do provedor inválida.'; end if;
  select * into v_operation from public.nexora_asaas_sandbox_operations where id=p_operation_id for update;
  if not found or v_operation.transaction_id is null then raise exception 'Operação não encontrada.'; end if;
  update public.nexora_transactions set provider_reference=p_provider_reference,status=p_transaction_status,
    paid_at=case when p_transaction_status='paid' then coalesce(paid_at,now()) else null end
    where id=v_operation.transaction_id and owner_id=v_operation.owner_id and test_mode;
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

create or replace function public.nexora_asaas_sandbox_fail_operation(p_operation_id bigint,p_status text,p_error_code text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_operation public.nexora_asaas_sandbox_operations;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_status not in ('failed','unknown') then raise exception 'Estado de operação inválido.'; end if;
  select * into v_operation from public.nexora_asaas_sandbox_operations where id=p_operation_id for update;
  if not found then raise exception 'Operação não encontrada.'; end if;
  update public.nexora_asaas_sandbox_operations set status=p_status,last_error_code=left(coalesce(p_error_code,'provider_error'),80),
    lease_expires_at=null,updated_at=now()
    where id=p_operation_id;
  if p_status='failed' then update public.nexora_transactions set status='cancelled'
    where id=v_operation.transaction_id and status='pending' and test_mode; end if;
end;
$$;

-- Snapshots seguem mostrando cobranças Sandbox, sem somá-las a valores recebidos reais.
create or replace function public.nexora_get_merchant_setup()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_business uuid := public.nexora_assert_workspace(); v_result jsonb;
begin
  select jsonb_build_object(
    'providers',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'code',a.code,'name',a.name,
      'api_base_url',a.api_base_url,'webhook_url',a.webhook_url,'environment',a.environment,
      'payment_methods',a.payment_methods,'status',a.status,'notes',a.notes)
      order by a.name) from public.nexora_acquirers a where a.status='enabled'),'[]'::jsonb),
    'connection',(select jsonb_build_object('acquirer_id',c.acquirer_id,'acquirer_name',a.name,
      'acquirer_code',a.code,'environment',a.environment,'status',c.status,'webhook_url',c.webhook_url,
      'api_key_configured',c.api_key_ciphertext is not null,'webhook_secret_configured',c.webhook_secret_ciphertext is not null,
      'updated_at',c.updated_at)
      from public.nexora_merchant_provider_connections c join public.nexora_acquirers a on a.id=c.acquirer_id
      where c.business_id=v_business and c.owner_id=auth.uid() order by c.updated_at desc limit 1),
    'controls',(select jsonb_build_object('payments_enabled',m.payments_enabled,'withdrawals_enabled',m.withdrawals_enabled,
      'withdrawal_mode',m.withdrawal_mode,'max_transfer_amount',m.max_transfer_amount,
      'daily_transfer_limit',m.daily_transfer_limit,'alert_threshold_amount',m.alert_threshold_amount,
      'reserve_percentage',m.reserve_percentage)
      from public.nexora_merchant_controls m where m.business_id=v_business and m.owner_id=auth.uid())
  ) into v_result;
  if v_result->'controls' is null then
    insert into public.nexora_merchant_controls(business_id,owner_id) values(v_business,auth.uid()) on conflict(business_id) do nothing;
    v_result := v_result || jsonb_build_object('controls',jsonb_build_object('payments_enabled',true,
      'withdrawals_enabled',true,'withdrawal_mode','manual','max_transfer_amount',5000,
      'daily_transfer_limit',20000,'alert_threshold_amount',5000,'reserve_percentage',0));
  end if;
  return v_result;
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
  v_provider jsonb;
begin
  select coalesce(m.status,'DRAFT') into v_status from public.merchant_onboarding m where m.user_id=auth.uid();
  v_can_operate := public.is_nexora_super_admin() or v_status='APPROVED';
  select to_jsonb(s) into v_settings from public.user_settings s where s.user_id=auth.uid();
  if v_can_operate then
    select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc,t.id),'[]'::jsonb)
      into v_transactions from public.nexora_transactions t where t.business_id=v_id and t.owner_id=auth.uid();
    select coalesce(jsonb_agg(to_jsonb(c) order by c.last_activity desc,c.id),'[]'::jsonb)
      into v_customers from (
        select c.id,c.name,c.email,
          coalesce(sum(t.amount) filter(where t.kind<>'withdrawal' and t.status='paid' and not t.test_mode),0) as total,
          coalesce(max(coalesce(t.paid_at,t.created_at)) filter(where not t.test_mode),c.created_at) as last_activity
        from public.nexora_customers c left join public.nexora_transactions t
          on t.customer_id=c.id and t.business_id=c.business_id and t.owner_id=c.owner_id
        where c.business_id=v_id and c.owner_id=auth.uid() group by c.id
      ) c;
    select jsonb_build_object('code',a.code,'name',a.name,'environment',a.environment,'status',c.status,
      'api_key_configured',c.api_key_ciphertext is not null,'payments_enabled',coalesce(m.payments_enabled,false))
      into v_provider from public.nexora_merchant_provider_connections c
      join public.nexora_acquirers a on a.id=c.acquirer_id
      left join public.nexora_merchant_controls m on m.business_id=c.business_id and m.owner_id=c.owner_id
      where c.business_id=v_id and c.owner_id=auth.uid() limit 1;
  end if;
  return jsonb_build_object(
    'transactions',v_transactions,'customers',v_customers,'settings',coalesce(v_settings,'{}'::jsonb),
    'business_id',v_id,'business_name',(select b.name from public.businesses b where b.id=v_id),
    'balance',case when v_can_operate then public.nexora_balance(v_id) else null end,
    'sandbox',case when v_can_operate then (select r.sandbox from public.nexora_runtime_config r where r.id=true) else false end,
    'gateway_ready',case when v_can_operate then (select r.gateway_ready from public.nexora_runtime_config r where r.id=true) else false end,
    'provider',coalesce(v_provider,'null'::jsonb),'can_operate',v_can_operate,'onboarding_status',coalesce(v_status,'APPROVED')
  );
end;
$$;

create or replace function public.nexora_admin_provider_connections()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_nexora_super_admin() then raise exception 'Acesso restrito ao Painel Nexora Pay.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('owner_id',c.owner_id,'business_id',c.business_id,
    'business_name',b.name,'email',u.email,'acquirer_id',c.acquirer_id,'acquirer_name',a.name,
    'acquirer_code',a.code,'environment',a.environment,'api_base_url',a.api_base_url,
    'status',c.status,'webhook_url',c.webhook_url,'api_key_configured',c.api_key_ciphertext is not null,
    'webhook_secret_configured',c.webhook_secret_ciphertext is not null,'updated_at',c.updated_at)
    order by c.updated_at desc) from public.nexora_merchant_provider_connections c
    join public.businesses b on b.id=c.business_id and b.owner_id=c.owner_id
    join auth.users u on u.id=c.owner_id join public.nexora_acquirers a on a.id=c.acquirer_id),'[]'::jsonb);
end;
$$;

-- Totais do backoffice excluem cobranças Sandbox para nunca parecerem saldo real.
create or replace function public.nexora_admin_snapshot(p_query text default '',p_page integer default 0,p_limit integer default 25,
  p_customer_query text default '',p_customer_page integer default 0)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_accounts jsonb; v_customers jsonb; v_count integer; v_customer_count integer; v_limit integer := least(greatest(coalesce(p_limit,25),1),100);
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
    order by u.created_at desc,u.id limit v_limit offset greatest(coalesce(p_page,0),0)*v_limit
  ) a;
  select count(*) into v_customer_count from public.nexora_customers c join public.businesses b on b.id=c.business_id and b.owner_id=c.owner_id
    where concat_ws(' ',c.name,c.email,b.name) ilike '%'||left(p_customer_query,160)||'%';
  select coalesce(jsonb_agg(to_jsonb(c)),'[]') into v_customers from (
    select c.id,c.name,c.email,c.owner_id,c.business_id,b.name as business_name,
      coalesce((select sum(t.amount) from public.nexora_transactions t where t.customer_id=c.id and t.owner_id=c.owner_id
        and t.business_id=c.business_id and t.source='gateway' and t.kind<>'withdrawal' and t.status='paid' and not t.test_mode),0) as total,
      coalesce((select max(coalesce(t.paid_at,t.created_at)) from public.nexora_transactions t where t.customer_id=c.id
        and t.owner_id=c.owner_id and t.business_id=c.business_id and t.source='gateway' and not t.test_mode),c.created_at) as last_activity
    from public.nexora_customers c join public.businesses b on b.id=c.business_id and b.owner_id=c.owner_id
    where concat_ws(' ',c.name,c.email,b.name) ilike '%'||left(p_customer_query,160)||'%'
    order by c.created_at desc,c.id limit v_limit offset greatest(coalesce(p_customer_page,0),0)*v_limit
  ) c;
  return jsonb_build_object('accounts',v_accounts,'account_count',v_count,'customers',v_customers,'customer_count',v_customer_count,
    'stats',jsonb_build_object('accounts',(select count(*) from auth.users),
      'active_accounts',(select count(*) from auth.users u where public.nexora_account_active(u.id)),
      'suspended_accounts',(select count(*) from public.nexora_account_controls where status='suspended'),
      'workspaces',(select count(*) from public.businesses)),
    'withdrawals',(select coalesce(jsonb_agg(to_jsonb(w)),'[]') from (
      select w.*,b.name as business_name,u.email from public.nexora_withdrawals w
      join public.businesses b on b.id=w.business_id and b.owner_id=w.owner_id
      join auth.users u on u.id=w.owner_id join public.nexora_transactions t on t.id=w.transaction_id
      where t.source='gateway' and not t.test_mode order by w.created_at desc limit 100) w),
    'audit',(select coalesce(jsonb_agg(to_jsonb(l)),'[]') from (select id,action,target_id,created_at from public.nexora_audit_log order by id desc limit 30) l),
    'site',public.nexora_public_site_settings(),'sandbox',(select sandbox from public.nexora_runtime_config where id),
    'gateway_ready',(select gateway_ready from public.nexora_runtime_config where id));
end;
$$;

revoke all on function public.nexora_admin_save_provider_credential(uuid,text) from public,anon;
grant execute on function public.nexora_admin_save_provider_credential(uuid,text) to authenticated;
revoke all on function public.nexora_asaas_sandbox_begin_charge(uuid,uuid,uuid,text,text,text,text,numeric,text) from public,anon,authenticated;
revoke all on function public.nexora_asaas_sandbox_complete_charge(bigint,text,text,text,text,text,text,timestamptz) from public,anon,authenticated;
revoke all on function public.nexora_asaas_sandbox_fail_operation(bigint,text,text) from public,anon,authenticated;
revoke all on function public.nexora_asaas_sandbox_mark_payment_attempt(bigint,text) from public,anon,authenticated;
grant execute on function public.nexora_asaas_sandbox_begin_charge(uuid,uuid,uuid,text,text,text,text,numeric,text) to service_role;
grant execute on function public.nexora_asaas_sandbox_complete_charge(bigint,text,text,text,text,text,text,timestamptz) to service_role;
grant execute on function public.nexora_asaas_sandbox_fail_operation(bigint,text,text) to service_role;
grant execute on function public.nexora_asaas_sandbox_mark_payment_attempt(bigint,text) to service_role;
revoke all on function public.nexora_admin_provider_connections() from public,anon;
grant execute on function public.nexora_admin_provider_connections() to authenticated;
revoke all on function public.nexora_admin_snapshot(text,integer,integer,text,integer) from public,anon;
grant execute on function public.nexora_admin_snapshot(text,integer,integer,text,integer) to authenticated;
revoke all on function public.nexora_get_merchant_setup() from public,anon;
grant execute on function public.nexora_get_merchant_setup() to authenticated;
revoke all on function public.nexora_workspace_snapshot() from public,anon;
grant execute on function public.nexora_workspace_snapshot() to authenticated;
-- Desativa as RPCs antigas de lançamentos fictícios, sem remover o histórico já salvo.
do $$ begin
  if to_regprocedure('public.nexora_sandbox_snapshot()') is not null then execute 'revoke all on function public.nexora_sandbox_snapshot() from public,anon,authenticated'; end if;
  if to_regprocedure('public.nexora_sandbox_create_payment(uuid,numeric,text,text)') is not null then execute 'revoke all on function public.nexora_sandbox_create_payment(uuid,numeric,text,text) from public,anon,authenticated'; end if;
  if to_regprocedure('public.nexora_sandbox_request_withdrawal(uuid,numeric)') is not null then execute 'revoke all on function public.nexora_sandbox_request_withdrawal(uuid,numeric) from public,anon,authenticated'; end if;
  if to_regprocedure('public.nexora_sandbox_transition(uuid,uuid,text)') is not null then execute 'revoke all on function public.nexora_sandbox_transition(uuid,uuid,text) from public,anon,authenticated'; end if;
  if to_regprocedure('public.nexora_sandbox_assert()') is not null then execute 'revoke all on function public.nexora_sandbox_assert() from public,anon,authenticated'; end if;
  if to_regprocedure('public.nexora_sandbox_event_immutable()') is not null then execute 'revoke all on function public.nexora_sandbox_event_immutable() from public,anon,authenticated'; end if;
end $$;
notify pgrst,'reload schema';
commit;

-- Verificação recomendada:
-- select code,name,api_base_url,environment,status from public.nexora_acquirers where code='asaas_sandbox';
-- select column_name from information_schema.columns where table_name='nexora_transactions' and column_name='test_mode';

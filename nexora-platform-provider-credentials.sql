-- Centraliza as credenciais próprias da Nexora por adquirente e ambiente.
-- Aditivo: mantém conexões e snapshots antigos para consulta/webhook histórico.
-- Não habilita rotas, pagamentos ou altera credenciais existentes.
begin;

do $$ begin
  if to_regclass('public.nexora_acquirers') is null
     or to_regclass('public.nexora_merchant_provider_connections') is null
     or to_regclass('public.nexora_audit_log') is null
     or to_regprocedure('public.is_nexora_super_admin()') is null then
    raise exception 'Execute antes as migrações de adquirentes, pagamentos e segurança.';
  end if;
end $$;

create table if not exists public.nexora_platform_provider_credentials (
  id uuid primary key default gen_random_uuid(),
  acquirer_id uuid not null references public.nexora_acquirers(id) on delete restrict,
  environment text not null check (environment in ('sandbox','production')),
  version integer not null check (version > 0),
  api_key_ciphertext text not null check (length(api_key_ciphertext) between 30 and 12000),
  key_fingerprint text not null check (key_fingerprint ~ '^[a-f0-9]{64}$'),
  key_hint text not null check (key_hint ~ '^[A-Za-z0-9_-]{4}$'),
  status text not null check (status in ('active','rotated','disabled')),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  validated_at timestamptz not null default now(),
  retired_at timestamptz,
  unique (acquirer_id,environment,version)
);
create unique index if not exists nexora_one_active_platform_credential
  on public.nexora_platform_provider_credentials(acquirer_id,environment)
  where status='active';
create index if not exists nexora_platform_credentials_history
  on public.nexora_platform_provider_credentials(acquirer_id,environment,version desc);

alter table public.nexora_platform_provider_credentials enable row level security;
revoke all on public.nexora_platform_provider_credentials from public,anon,authenticated,service_role;
grant select on public.nexora_platform_provider_credentials to service_role;
do $$ begin
  if to_regclass('public.nexora_asaas_sandbox_operations') is not null then
    execute 'alter table public.nexora_asaas_sandbox_operations add column if not exists platform_credential_id uuid references public.nexora_platform_provider_credentials(id) on delete restrict';
  end if;
end $$;

drop function if exists public.nexora_admin_save_platform_provider_credential(uuid,text,text,text,text);
create or replace function public.nexora_admin_save_platform_provider_credential(
  p_actor_id uuid,p_acquirer_id uuid,p_environment text,p_api_key_ciphertext text,
  p_key_fingerprint text,p_key_hint text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_version integer; v_code text; v_base_url text;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' or p_actor_id is null
    or not exists(select 1 from auth.users u join public.nexora_admins a
      on lower(trim(a.email))=lower(trim(u.email))
      where u.id=p_actor_id and a.role='super_admin') then
    raise exception 'Credencial só pode ser salva pelo backend para um Super Admin autorizado.';
  end if;
  if p_acquirer_id is null or p_environment is null or p_environment not in ('sandbox','production')
    or p_api_key_ciphertext is null or length(p_api_key_ciphertext) not between 30 and 12000
    or p_api_key_ciphertext !~ '^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$'
    or p_key_fingerprint is null or p_key_fingerprint !~ '^[a-f0-9]{64}$'
    or p_key_hint is null or p_key_hint !~ '^[A-Za-z0-9_-]{4}$' then
    raise exception 'Credencial central inválida.';
  end if;
  select a.code,a.api_base_url into v_code,v_base_url
    from public.nexora_acquirers a
    where a.id=p_acquirer_id and a.environment=p_environment and a.status='enabled';
  if not found or v_code !~ '^[a-z][a-z0-9_-]{1,79}$'
    or v_base_url !~ '^https://[^/@[:space:]]+(/[^[:space:]]*)?$'
    or v_base_url ~ '[?#]' then
    raise exception 'Adquirente ou ambiente não homologado para credencial central.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_acquirer_id::text||':'||p_environment,0));
  select coalesce(max(c.version),0)+1 into v_version
    from public.nexora_platform_provider_credentials c
    where c.acquirer_id=p_acquirer_id and c.environment=p_environment;
  update public.nexora_platform_provider_credentials
    set status='rotated',retired_at=now()
    where acquirer_id=p_acquirer_id and environment=p_environment and status='active';
  insert into public.nexora_platform_provider_credentials(
    acquirer_id,environment,version,api_key_ciphertext,key_fingerprint,key_hint,status,created_by
  ) values(
    p_acquirer_id,p_environment,v_version,p_api_key_ciphertext,p_key_fingerprint,p_key_hint,'active',p_actor_id
  ) returning id into v_id;
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(p_actor_id,'provider.platform_credential.rotated',v_id::text,
      jsonb_build_object('acquirer_id',p_acquirer_id,'environment',p_environment,
        'version',v_version,'key_hint',p_key_hint,'fingerprint',p_key_fingerprint));
  return v_id;
end;
$$;
revoke all on function public.nexora_admin_save_platform_provider_credential(uuid,uuid,text,text,text,text)
  from public,anon;
grant execute on function public.nexora_admin_save_platform_provider_credential(uuid,uuid,text,text,text,text)
  to service_role;

create or replace function public.nexora_admin_platform_provider_credentials()
returns table(
  acquirer_id uuid,acquirer_code text,acquirer_name text,environment text,
  status text,version integer,key_hint text,validated_at timestamptz,created_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_nexora_super_admin() then
    raise exception 'Acesso restrito ao Painel Nexora Pay.';
  end if;
  return query
    select c.acquirer_id,a.code,a.name,c.environment,c.status,c.version,c.key_hint,c.validated_at,c.created_at
    from public.nexora_platform_provider_credentials c
    join public.nexora_acquirers a on a.id=c.acquirer_id
    order by c.environment,a.name,c.version desc
    limit 200;
end;
$$;
revoke all on function public.nexora_admin_platform_provider_credentials() from public,anon;
grant execute on function public.nexora_admin_platform_provider_credentials() to authenticated;

create or replace function public.nexora_admin_activate_provider_route(p_business_id uuid,p_acquirer_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_environment text;
begin
  if not public.is_nexora_super_admin() then
    raise exception 'Acesso restrito ao Painel Nexora Pay com MFA.';
  end if;
  select b.owner_id,a.environment into v_owner,v_environment
    from public.businesses b
    join public.nexora_merchant_provider_connections c on c.business_id=b.id and c.owner_id=b.owner_id
    join public.nexora_acquirers a on a.id=c.acquirer_id
    where b.id=p_business_id and c.acquirer_id=p_acquirer_id and c.status in ('pending','active')
      and a.status='enabled';
  if not found then raise exception 'Rota atribuída ou adquirente habilitado não encontrado.'; end if;
  if not exists(select 1 from public.nexora_platform_provider_credentials k
      where k.acquirer_id=p_acquirer_id and k.environment=v_environment and k.status='active') then
    raise exception 'Configure e valide primeiro a credencial central da Nexora.';
  end if;
  update public.nexora_merchant_provider_connections set status='active',last_error=null,updated_at=now()
    where business_id=p_business_id and owner_id=v_owner and acquirer_id=p_acquirer_id;
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(auth.uid(),'provider.merchant_route.activated',p_business_id::text,
      jsonb_build_object('acquirer_id',p_acquirer_id,'environment',v_environment));
end;
$$;
revoke all on function public.nexora_admin_activate_provider_route(uuid,uuid) from public,anon;
grant execute on function public.nexora_admin_activate_provider_route(uuid,uuid) to authenticated;

create or replace function public.nexora_admin_set_provider_route_status(
  p_business_id uuid,p_acquirer_id uuid,p_status text
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_old_status text;
begin
  if not public.is_nexora_super_admin() then
    raise exception 'Acesso restrito ao Painel Nexora Pay com MFA.';
  end if;
  if p_status is null or p_status not in ('pending','disabled','error') then
    raise exception 'Use a ação de ativação para habilitar uma rota.';
  end if;
  select c.owner_id,c.status into v_owner,v_old_status
    from public.nexora_merchant_provider_connections c
    where c.business_id=p_business_id and c.acquirer_id=p_acquirer_id
    for update;
  if not found then raise exception 'Rota do lojista não encontrada.'; end if;
  update public.nexora_merchant_provider_connections
    set status=p_status,updated_at=now()
    where business_id=p_business_id and owner_id=v_owner and acquirer_id=p_acquirer_id;
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(auth.uid(),'merchant.provider_route_status',p_business_id::text,
      jsonb_build_object('acquirer_id',p_acquirer_id,'from',v_old_status,'to',p_status));
end;
$$;
revoke all on function public.nexora_admin_set_provider_route_status(uuid,uuid,text) from public,anon;
grant execute on function public.nexora_admin_set_provider_route_status(uuid,uuid,text) to authenticated;

-- Gate immediately before the provider POST. The old Edge Function does not
-- create pricing snapshots, so applying only this migration cannot allow it
-- to send a new charge even if an active central credential already exists.
create or replace function public.nexora_asaas_mark_payment_attempt(
  p_operation_id bigint,p_customer_id text,p_lease_token uuid
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_operation record;
  v_amount numeric;
  v_priced boolean;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_operation_id is null or nullif(trim(p_customer_id),'') is null or length(p_customer_id)>100 then
    raise exception 'Referência do pagador inválida.';
  end if;
  select * into v_operation from public.nexora_asaas_sandbox_operations where id=p_operation_id for update;
  if not found or v_operation.transaction_id is null or v_operation.status in ('failed','succeeded') then
    raise exception 'Operação indisponível para envio.';
  end if;
  if p_lease_token is null or v_operation.lease_token is distinct from p_lease_token
    or v_operation.lease_expires_at is null or v_operation.lease_expires_at<=now() then
    raise exception 'A tentativa perdeu a reserva de execução. Consulte o estado antes de continuar.';
  end if;
  if v_operation.payment_attempted_at is not null then raise exception 'Esta cobrança já foi enviada ou está em verificação.'; end if;
  if to_regclass('public.nexora_applied_pricing') is null then
    raise exception 'Pricing não instalado; nenhuma cobrança foi enviada.';
  end if;
  select t.amount into v_amount from public.nexora_transactions t
    where t.id=v_operation.transaction_id and t.business_id=v_operation.business_id
      and t.owner_id=v_operation.owner_id and t.kind='payment' and t.payment_method='pix';
  select exists(select 1 from public.nexora_applied_pricing p
    where p.transaction_id=v_operation.transaction_id
      and p.business_id=v_operation.business_id and p.owner_id=v_operation.owner_id
      and p.acquirer_id=v_operation.acquirer_id and p.payment_method='pix'
      and p.gross_amount_cents=round(v_amount*100)::bigint and p.merchant_net_cents>0
  ) into v_priced;
  if v_amount is null or not v_priced then
    raise exception 'Snapshot de tarifa válido não encontrado; nenhuma cobrança foi enviada.';
  end if;
  update public.nexora_asaas_sandbox_operations set provider_customer_id=trim(p_customer_id),
    payment_attempted_at=now(),lease_expires_at=null,status='unknown',updated_at=now()
    where id=p_operation_id;
end;
$$;
revoke all on function public.nexora_asaas_mark_payment_attempt(bigint,text,uuid) from public,anon,authenticated;
grant execute on function public.nexora_asaas_mark_payment_attempt(bigint,text,uuid) to service_role;

-- New operations snapshot the central credential version in the existing
-- encrypted operation field. Existing operation snapshots remain untouched.
create or replace function public.nexora_asaas_begin_charge(
  p_owner_id uuid,p_business_id uuid,p_request_id uuid,p_request_hash text,
  p_customer_name text,p_customer_email text,p_customer_document text,
  p_amount numeric,p_description text,p_acquirer_id uuid,p_environment text,p_connection_version timestamptz
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_operation record;
  v_connection public.nexora_merchant_provider_connections;
  v_lease uuid := gen_random_uuid();
  v_inserted integer;
  v_claimed boolean := false;
  v_customer_id uuid;
  v_transaction_id uuid;
  v_external_reference text;
  v_platform_credential_id uuid;
  v_platform_key_ciphertext text;
  v_fixed_fee_cents bigint;
  v_variable_fee_bps integer;
  v_gross_cents bigint;
  v_merchant_fee_cents bigint;
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
  if p_environment is null or p_environment not in ('production','sandbox') then raise exception 'Ambiente inválido.'; end if;
  select * into v_connection from public.nexora_merchant_provider_connections
    where business_id=p_business_id and owner_id=p_owner_id for share;
  if not found or v_connection.acquirer_id is distinct from p_acquirer_id
    or v_connection.updated_at is distinct from p_connection_version then
    raise exception 'A conexão mudou. Atualize a página e tente novamente.';
  end if;
  if not exists(select 1 from public.businesses b where b.id=p_business_id and b.owner_id=p_owner_id)
    or not exists(select 1 from public.merchant_onboarding m where m.user_id=p_owner_id and m.status='APPROVED')
    or not public.nexora_account_active(p_owner_id)
    or not exists(select 1 from public.nexora_merchant_controls c where c.business_id=p_business_id
      and c.owner_id=p_owner_id and c.payments_enabled)
    or not exists(select 1 from public.nexora_merchant_provider_connections c
      join public.nexora_acquirers a on a.id=c.acquirer_id
      where c.business_id=p_business_id and c.owner_id=p_owner_id and c.status='active'
        and a.id=p_acquirer_id and a.environment=p_environment
        and ((a.code='asaas_sandbox' and a.environment='sandbox' and a.api_base_url='https://api-sandbox.asaas.com/v3')
          or (a.code='asaas_production' and a.environment='production' and a.api_base_url='https://api.asaas.com/v3'))
        and a.status='enabled') then
    raise exception 'Cadastro aprovado, recebimentos liberados e rota Asaas ativa são necessários.';
  end if;
  select c.id,c.api_key_ciphertext into v_platform_credential_id,v_platform_key_ciphertext
    from public.nexora_platform_provider_credentials c
    where c.acquirer_id=p_acquirer_id and c.environment=p_environment and c.status='active'
    for share;
  if not found then raise exception 'Credencial central da Nexora não configurada para este adquirente e ambiente.'; end if;

  v_external_reference := 'NX-'||upper(replace(p_request_id::text,'-',''));
  insert into public.nexora_asaas_sandbox_operations(
    business_id,owner_id,idempotency_key,request_hash,external_reference,lease_expires_at,
    lease_token,environment,acquirer_id,api_key_ciphertext,platform_credential_id
  ) values(
    p_business_id,p_owner_id,p_request_id,p_request_hash,v_external_reference,now()+interval '90 seconds',
    v_lease,p_environment,p_acquirer_id,v_platform_key_ciphertext,v_platform_credential_id
  ) on conflict(business_id,idempotency_key) do nothing;
  get diagnostics v_inserted = row_count;
  select * into v_operation from public.nexora_asaas_sandbox_operations
    where business_id=p_business_id and idempotency_key=p_request_id for update;
  if v_operation.environment is distinct from p_environment or v_operation.acquirer_id is distinct from p_acquirer_id then
    raise exception 'Esta tentativa pertence a outra rota. Consulte a cobrança original.';
  end if;
  if v_operation.request_hash<>p_request_hash then raise exception 'Esta chave de idempotência já foi usada com outros dados.'; end if;

  if v_inserted=1 then
    -- Database gate protects deployments running the previous Edge Function:
    -- installing only this migration must never permit a new charge without
    -- a valid pricing rule. Existing idempotent operations remain recoverable.
    if to_regclass('public.nexora_pricing_rules') is null then
      raise exception 'Pricing não instalado; nenhuma cobrança nova foi criada.';
    end if;
    select r.fixed_fee_cents,r.variable_fee_bps into v_fixed_fee_cents,v_variable_fee_bps
      from public.nexora_pricing_rules r
      where r.business_id=p_business_id and r.owner_id=p_owner_id
        and r.acquirer_id=p_acquirer_id and r.payment_method='pix'
        and r.effective_from<=now()
      order by r.effective_from desc limit 1;
    if not found then raise exception 'Tarifa Pix vigente não configurada; nenhuma cobrança nova foi criada.'; end if;
    v_gross_cents := round(p_amount*100)::bigint;
    v_merchant_fee_cents := v_fixed_fee_cents
      + round(v_gross_cents::numeric*v_variable_fee_bps/10000)::bigint;
    if v_merchant_fee_cents<0 or v_merchant_fee_cents>=v_gross_cents then
      raise exception 'Tarifa Pix inválida para o valor informado; nenhuma cobrança nova foi criada.';
    end if;
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
      p_amount,'payment','pending','gateway','pix',p_request_id,p_environment='sandbox')
    returning id into v_transaction_id;
    update public.nexora_asaas_sandbox_operations set transaction_id=v_transaction_id,updated_at=now()
      where id=v_operation.id returning * into v_operation;
  else
    v_transaction_id := v_operation.transaction_id;
    if v_operation.status not in ('failed','succeeded') and v_operation.payment_attempted_at is null
      and (v_operation.lease_expires_at is null or v_operation.lease_expires_at<=now()) then
      update public.nexora_asaas_sandbox_operations set status='processing',lease_token=v_lease,
        lease_expires_at=now()+interval '90 seconds',updated_at=now()
        where id=v_operation.id returning * into v_operation;
      v_claimed := true;
    end if;
  end if;
  return jsonb_build_object('operation_id',v_operation.id,'status',v_operation.status,
    'is_new',v_claimed,'payment_attempted_at',v_operation.payment_attempted_at,
    'transaction_id',coalesce(v_transaction_id,v_operation.transaction_id),
    'external_reference',v_operation.external_reference,'provider_reference',v_operation.provider_reference,
    'owner_id',v_operation.owner_id,'business_id',v_operation.business_id,
    'lease_token',v_operation.lease_token,'environment',v_operation.environment,'acquirer_id',v_operation.acquirer_id,
    'api_key_ciphertext',v_operation.api_key_ciphertext,'platform_credential_id',v_operation.platform_credential_id);
end;
$$;

revoke all on function public.nexora_asaas_begin_charge(uuid,uuid,uuid,text,text,text,text,numeric,text,uuid,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.nexora_asaas_begin_charge(uuid,uuid,uuid,text,text,text,text,numeric,text,uuid,text,timestamptz)
  to service_role;

notify pgrst,'reload schema';
commit;

-- Expected: RLS enabled; authenticated users have no direct table privileges;
-- service_role can read, but cannot directly mutate central credentials.
select c.relname as table_name,c.relrowsecurity as rls_enabled,
  has_table_privilege('authenticated',c.oid,'SELECT') as authenticated_can_select,
  has_table_privilege('authenticated',c.oid,'INSERT') as authenticated_can_insert,
  has_table_privilege('authenticated',c.oid,'UPDATE') as authenticated_can_update,
  has_table_privilege('authenticated',c.oid,'DELETE') as authenticated_can_delete,
  has_table_privilege('service_role',c.oid,'SELECT') as service_role_can_select,
  has_table_privilege('service_role',c.oid,'INSERT') as service_role_can_insert,
  has_table_privilege('service_role',c.oid,'UPDATE') as service_role_can_update,
  has_table_privilege('service_role',c.oid,'DELETE') as service_role_can_delete
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname='nexora_platform_provider_credentials';

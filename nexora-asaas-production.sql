-- Nexora Pay: Asaas produção e testes. SQL complementar ao nexora-asaas-sandbox.sql.
-- Cole SOMENTE este arquivo .sql no SQL Editor. Arquivos .js/.ts são publicados com a aplicação.
-- Não efetua cobranças, não transfere valores e não muda automaticamente a conexão de nenhum cliente.
begin;
do $$ begin
  if to_regclass('public.nexora_asaas_sandbox_operations') is null then
    raise exception 'Execute primeiro nexora-asaas-sandbox.sql.';
  end if;
end $$;

-- Os nomes históricos das tabelas são preservados para manter os registros da primeira migração.
alter table public.nexora_asaas_sandbox_operations
  add column if not exists environment text not null default 'sandbox' check(environment in ('sandbox','production')),
  add column if not exists acquirer_id uuid references public.nexora_acquirers(id),
  add column if not exists api_key_ciphertext text,
  add column if not exists lease_token uuid;
update public.nexora_asaas_sandbox_operations o set acquirer_id=c.acquirer_id,api_key_ciphertext=c.api_key_ciphertext
  from public.nexora_merchant_provider_connections c join public.nexora_acquirers a on a.id=c.acquirer_id
  where o.business_id=c.business_id and o.owner_id=c.owner_id and o.acquirer_id is null
    and o.environment='sandbox' and a.code='asaas_sandbox' and a.environment='sandbox';

alter table public.nexora_transactions drop constraint if exists nexora_transactions_status_check;
alter table public.nexora_transactions add constraint nexora_transactions_status_check
  check(status in ('pending','processing','paid','cancelled','refunded','refund_pending','under_review','overdue'));

insert into public.nexora_acquirers(code,name,api_base_url,environment,payment_methods,status,notes)
values('asaas_production','Asaas · produção','https://api.asaas.com/v3','production',array['pix']::text[],'enabled',
 'Cobranças Pix reais na conta Asaas da chave atribuída pelo Super Admin.')
on conflict(code) do nothing;

revoke all on public.nexora_asaas_sandbox_operations,public.nexora_asaas_sandbox_payment_details from public,anon,authenticated;
revoke all on function public.nexora_admin_save_provider_credential(uuid,text) from public,anon,authenticated;

create or replace function public.nexora_admin_save_provider_credential(p_owner_id uuid,p_api_key_ciphertext text,p_acquirer_id uuid,p_environment text,p_connection_version timestamptz)
returns void language plpgsql security definer set search_path = '' as $$
declare v_business uuid; v_connection public.nexora_merchant_provider_connections;
begin
  if not public.is_nexora_super_admin() then raise exception 'Acesso restrito ao Painel Nexora Pay.'; end if;
  if p_owner_id is null or p_api_key_ciphertext is null or length(p_api_key_ciphertext)>12000
    or p_api_key_ciphertext !~ '^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$' then
    raise exception 'Credencial criptografada inválida.';
  end if;
  select b.id into v_business from public.businesses b where b.owner_id=p_owner_id order by b.id limit 1;
  if v_business is null then raise exception 'Workspace não encontrado.'; end if;
  select * into v_connection from public.nexora_merchant_provider_connections where business_id=v_business and owner_id=p_owner_id for update;
  if not found or v_connection.acquirer_id is distinct from p_acquirer_id
    or v_connection.updated_at is distinct from p_connection_version then
    raise exception 'A conexão foi alterada. Atualize o painel e configure novamente.';
  end if;
  if not exists(select 1 from public.nexora_merchant_provider_connections c
      join public.nexora_acquirers a on a.id=c.acquirer_id
      where c.business_id=v_business and c.owner_id=p_owner_id and a.id=p_acquirer_id and a.environment=p_environment
        and ((a.code='asaas_sandbox' and a.environment='sandbox' and a.api_base_url='https://api-sandbox.asaas.com/v3')
          or (a.code='asaas_production' and a.environment='production' and a.api_base_url='https://api.asaas.com/v3'))
        and a.status='enabled') then
    raise exception 'Atribua o Asaas a esta conta antes de configurar a chave.';
  end if;
  update public.nexora_merchant_provider_connections
  set api_key_ciphertext=p_api_key_ciphertext,status='active',last_error=null,
      configured_at=now(),updated_at=now()
  where business_id=v_business and owner_id=p_owner_id;
  if not found then raise exception 'Conexão Asaas não encontrada.'; end if;
end;
$$;

create or replace function public.nexora_asaas_begin_charge(
  p_owner_id uuid,p_business_id uuid,p_request_id uuid,p_request_hash text,
  p_customer_name text,p_customer_email text,p_customer_document text,
  p_amount numeric,p_description text,p_acquirer_id uuid,p_environment text,p_connection_version timestamptz
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_operation public.nexora_asaas_sandbox_operations;
  v_connection public.nexora_merchant_provider_connections;
  v_lease uuid := gen_random_uuid();
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
        and c.api_key_ciphertext is not null and a.id=p_acquirer_id and a.environment=p_environment
        and ((a.code='asaas_sandbox' and a.environment='sandbox' and a.api_base_url='https://api-sandbox.asaas.com/v3')
          or (a.code='asaas_production' and a.environment='production' and a.api_base_url='https://api.asaas.com/v3'))
        and a.status='enabled') then
    raise exception 'Cadastro aprovado, recebimentos liberados e conexão Asaas ativa são necessários.';
  end if;

  v_external_reference := 'NX-'||upper(replace(p_request_id::text,'-',''));
  insert into public.nexora_asaas_sandbox_operations(business_id,owner_id,idempotency_key,request_hash,external_reference,lease_expires_at,lease_token,environment,acquirer_id,api_key_ciphertext)
  values(p_business_id,p_owner_id,p_request_id,p_request_hash,v_external_reference,now()+interval '90 seconds',
    v_lease,p_environment,p_acquirer_id,v_connection.api_key_ciphertext)
  on conflict(business_id,idempotency_key) do nothing;
  get diagnostics v_inserted = row_count;
  select * into v_operation from public.nexora_asaas_sandbox_operations
    where business_id=p_business_id and idempotency_key=p_request_id for update;
  if v_operation.environment is distinct from p_environment or v_operation.acquirer_id is distinct from p_acquirer_id then
    raise exception 'Esta tentativa pertence a outra conexão. Consulte o histórico da cobrança original.';
  end if;
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
      p_amount,'payment','pending','gateway','pix',p_request_id,p_environment='sandbox')
    returning id into v_transaction_id;
    update public.nexora_asaas_sandbox_operations set transaction_id=v_transaction_id,updated_at=now()
      where id=v_operation.id returning * into v_operation;
  else
    v_transaction_id := v_operation.transaction_id;
    if v_operation.status not in ('failed','succeeded')
       and v_operation.payment_attempted_at is null
       and (v_operation.lease_expires_at is null or v_operation.lease_expires_at<=now()) then
      update public.nexora_asaas_sandbox_operations set status='processing',lease_token=v_lease,lease_expires_at=now()+interval '90 seconds',updated_at=now()
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
    'api_key_ciphertext',v_operation.api_key_ciphertext);
end;
$$;

create or replace function public.nexora_asaas_mark_payment_attempt(p_operation_id bigint,p_customer_id text,p_lease_token uuid)
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
  if p_lease_token is null or v_operation.lease_token is distinct from p_lease_token
    or v_operation.lease_expires_at is null or v_operation.lease_expires_at<=now() then
    raise exception 'A tentativa perdeu a reserva de execução. Consulte o estado antes de continuar.';
  end if;
  if v_operation.payment_attempted_at is not null then raise exception 'Esta cobrança já foi enviada ou está em verificação.'; end if;
  update public.nexora_asaas_sandbox_operations set provider_customer_id=trim(p_customer_id),
    payment_attempted_at=now(),lease_expires_at=null,status='unknown',updated_at=now() where id=p_operation_id;
end;
$$;

create or replace function public.nexora_asaas_complete_charge(
  p_operation_id bigint,p_provider_reference text,p_provider_status text,p_transaction_status text,
  p_invoice_url text,p_pix_copy_paste text,p_pix_encoded_image text,p_pix_expiration timestamptz
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_operation public.nexora_asaas_sandbox_operations;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_operation_id is null or nullif(trim(p_provider_reference),'') is null
    or length(p_provider_reference)>255 or length(coalesce(p_provider_status,''))>80
    or p_transaction_status not in ('pending','processing','paid','cancelled','refunded','refund_pending','under_review','overdue')
    or length(coalesce(p_invoice_url,''))>2000 or length(coalesce(p_pix_copy_paste,''))>5000
    or length(coalesce(p_pix_encoded_image,''))>100000 then raise exception 'Resposta do provedor inválida.'; end if;
  select * into v_operation from public.nexora_asaas_sandbox_operations where id=p_operation_id for update;
  if not found or v_operation.transaction_id is null then raise exception 'Operação não encontrada.'; end if;
  if v_operation.provider_reference is not null and v_operation.provider_reference<>p_provider_reference then
    raise exception 'A referência do provedor não corresponde à cobrança.';
  end if;
  -- Consultas concorrentes não podem rebaixar uma confirmação ou desfazer um estorno.
  if exists(select 1 from public.nexora_transactions t where t.id=v_operation.transaction_id
    and ((t.status='refunded' and p_transaction_status<>'refunded')
      or (t.status='paid' and p_transaction_status in ('pending','processing','overdue'))
      or (t.status='refund_pending' and p_transaction_status in ('pending','processing','paid','overdue')))) then return; end if;
  update public.nexora_transactions set provider_reference=p_provider_reference,status=p_transaction_status,
    paid_at=case when p_transaction_status='paid' then coalesce(paid_at,now()) else null end
    where id=v_operation.transaction_id and owner_id=v_operation.owner_id and test_mode=(v_operation.environment='sandbox');
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

create or replace function public.nexora_asaas_fail_operation(p_operation_id bigint,p_status text,p_error_code text,p_lease_token uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_operation public.nexora_asaas_sandbox_operations;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_status not in ('failed','unknown') then raise exception 'Estado de operação inválido.'; end if;
  select * into v_operation from public.nexora_asaas_sandbox_operations where id=p_operation_id for update;
  if not found then raise exception 'Operação não encontrada.'; end if;
  if v_operation.status='succeeded' or p_lease_token is null or v_operation.lease_token is distinct from p_lease_token then return; end if;
  update public.nexora_asaas_sandbox_operations set status=p_status,last_error_code=left(coalesce(p_error_code,'provider_error'),80),
    lease_expires_at=null,updated_at=now()
    where id=p_operation_id;
  if p_status='failed' then update public.nexora_transactions set status='cancelled'
    where id=v_operation.transaction_id and status='pending' and test_mode=(v_operation.environment='sandbox'); end if;
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
    select coalesce(jsonb_agg(to_jsonb(t) || jsonb_build_object('provider_adapter',
      case when exists(select 1 from public.nexora_asaas_sandbox_operations op where op.transaction_id=t.id) then 'asaas' else null end)
      order by t.created_at desc,t.id),'[]'::jsonb)
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
    select jsonb_build_object('acquirer_id',a.id,'code',a.code,'name',a.name,'environment',a.environment,'status',c.status,
      'api_key_configured',c.api_key_ciphertext is not null,'payments_enabled',coalesce(m.payments_enabled,false))
      into v_provider from public.nexora_merchant_provider_connections c
      join public.nexora_acquirers a on a.id=c.acquirer_id
      left join public.nexora_merchant_controls m on m.business_id=c.business_id and m.owner_id=c.owner_id
      where c.business_id=v_id and c.owner_id=auth.uid() limit 1;
  end if;
  return jsonb_build_object(
    'transactions',v_transactions,'customers',v_customers,'settings',coalesce(v_settings,'{}'::jsonb),
    'business_id',v_id,'business_name',(select b.name from public.businesses b where b.id=v_id),
    'balance',null, -- Cobrança recebida não equivale a saldo disponível para saque.
    'sandbox',case when v_can_operate then (select r.sandbox from public.nexora_runtime_config r where r.id=true) else false end,
    'gateway_ready',case when v_can_operate then (select r.gateway_ready from public.nexora_runtime_config r where r.id=true) else false end,
    'provider',coalesce(v_provider,'null'::jsonb),'can_operate',v_can_operate,'onboarding_status',coalesce(v_status,'APPROVED')
  );
end;
$$;

revoke all on function public.nexora_asaas_begin_charge(uuid,uuid,uuid,text,text,text,text,numeric,text,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.nexora_asaas_begin_charge(uuid,uuid,uuid,text,text,text,text,numeric,text,uuid,text,timestamptz) to service_role;
revoke all on function public.nexora_asaas_mark_payment_attempt(bigint,text,uuid) from public,anon,authenticated;
grant execute on function public.nexora_asaas_mark_payment_attempt(bigint,text,uuid) to service_role;
revoke all on function public.nexora_asaas_complete_charge(bigint,text,text,text,text,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.nexora_asaas_complete_charge(bigint,text,text,text,text,text,text,timestamptz) to service_role;
revoke all on function public.nexora_asaas_fail_operation(bigint,text,text,uuid) from public,anon,authenticated;
grant execute on function public.nexora_asaas_fail_operation(bigint,text,text,uuid) to service_role;
revoke all on function public.nexora_admin_save_provider_credential(uuid,text,uuid,text,timestamptz) from public,anon;
grant execute on function public.nexora_admin_save_provider_credential(uuid,text,uuid,text,timestamptz) to authenticated;
revoke all on function public.nexora_workspace_snapshot() from public,anon;
grant execute on function public.nexora_workspace_snapshot() to authenticated;
notify pgrst,'reload schema';
commit;
select code,name,api_base_url,environment,status
from public.nexora_acquirers
where code in ('asaas_sandbox','asaas_production')
order by environment;

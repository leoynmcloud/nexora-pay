-- Allow encrypted Nexora-owned Mercado Pago Access Tokens to be validated and
-- versioned centrally. This does not register a payment adapter or enable routes.
begin;

do $$ begin
  if to_regclass('public.nexora_acquirers') is null
     or to_regclass('public.nexora_platform_provider_credentials') is null
     or to_regclass('public.nexora_audit_log') is null
     or to_regprocedure('public.is_nexora_super_admin()') is null then
    raise exception 'Apply acquirer catalog, central credentials, audit log and security migrations first.';
  end if;
end $$;

insert into public.nexora_acquirers(code,name,api_base_url,environment,payment_methods,status,notes)
values
  ('mercadopago_sandbox','Mercado Pago · testes','https://api.mercadopago.com','sandbox',array['pix']::text[],'disabled',
   'Credencial de testes preparada; adapter de pagamentos ainda não homologado.'),
  ('mercadopago_production','Mercado Pago · produção','https://api.mercadopago.com','production',array['pix']::text[],'disabled',
   'Credencial de produção preparada; pagamentos e rotas permanecem desativados até homologação.')
on conflict(code) do nothing;

do $$ begin
  if exists(select 1 from public.nexora_acquirers
    where code in ('mercadopago_sandbox','mercadopago_production') and status<>'disabled') then
    raise exception 'Disable Mercado Pago catalog entries before applying this credential-preparation migration.';
  end if;
  if not exists(select 1 from pg_constraint
    where conrelid='public.nexora_acquirers'::regclass and conname='nexora_mercadopago_disabled_until_adapter') then
    alter table public.nexora_acquirers add constraint nexora_mercadopago_disabled_until_adapter
      check (code not in ('mercadopago_sandbox','mercadopago_production') or status='disabled');
  end if;
end $$;

drop function if exists public.nexora_admin_save_platform_provider_credential(uuid,text,text,text,text);
create or replace function public.nexora_admin_save_platform_provider_credential(
  p_actor_id uuid,p_acquirer_id uuid,p_environment text,p_api_key_ciphertext text,
  p_key_fingerprint text,p_key_hint text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_version integer; v_code text; v_base_url text; v_status text;
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
  select a.code,a.api_base_url,a.status into v_code,v_base_url,v_status
    from public.nexora_acquirers a
    where a.id=p_acquirer_id and a.environment=p_environment;
  if not found or not (
    (v_code='asaas_production' and p_environment='production' and v_base_url='https://api.asaas.com/v3' and v_status='enabled')
    or (v_code='asaas_sandbox' and p_environment='sandbox' and v_base_url='https://api-sandbox.asaas.com/v3' and v_status='enabled')
    or (v_code='mercadopago_production' and p_environment='production' and v_base_url='https://api.mercadopago.com' and v_status='disabled')
    or (v_code='mercadopago_sandbox' and p_environment='sandbox' and v_base_url='https://api.mercadopago.com' and v_status='disabled')
  ) then raise exception 'Adquirente, ambiente ou URL não homologados para credencial central.'; end if;

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

notify pgrst,'reload schema';
commit;

select code,name,api_base_url,environment,status
from public.nexora_acquirers
where code in ('mercadopago_sandbox','mercadopago_production')
order by environment;

select c.relname as table_name,c.relrowsecurity as rls_enabled,
  has_table_privilege('anon',c.oid,'SELECT') as anon_can_select,
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

select p.oid::regprocedure as function_name,
  has_function_privilege('anon',p.oid,'EXECUTE') as anon_can_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_can_execute,
  has_function_privilege('service_role',p.oid,'EXECUTE') as service_role_can_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname='nexora_admin_save_platform_provider_credential';

select conname,pg_get_constraintdef(oid) as definition,convalidated as validated
from pg_constraint
where conrelid='public.nexora_acquirers'::regclass
  and conname='nexora_mercadopago_disabled_until_adapter';

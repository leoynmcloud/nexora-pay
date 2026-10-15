-- Verificação somente leitura de isolamento e permissões da Nexora Pay.
-- Execute no SQL Editor do Supabase. Não retorna dados de clientes/documentos.

select n.nspname as schema_name,c.relname as table_name,c.relrowsecurity as rls_enabled
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in (
  'businesses','workspace_members','user_settings','nexora_customers','nexora_transactions',
  'nexora_withdrawals','merchant_onboarding','merchant_kyc_documents',
  'nexora_sandbox_transactions','nexora_sandbox_events',
  'nexora_provider_webhook_inbox','nexora_provider_operations'
) order by c.relname;

select schemaname,tablename,policyname,roles,cmd
from pg_policies
where schemaname='public' and tablename in (
  'businesses','workspace_members','user_settings','nexora_customers','nexora_transactions',
  'nexora_withdrawals','merchant_onboarding','merchant_kyc_documents',
  'nexora_sandbox_transactions','nexora_sandbox_events'
) order by tablename,policyname;

select id as bucket_id,public as is_public,file_size_limit
from storage.buckets where id in ('nexora-kyc','nexora-site') order by id;

select
  has_table_privilege('anon','public.nexora_sandbox_transactions','INSERT') as anon_can_insert_sandbox,
  has_table_privilege('authenticated','public.nexora_sandbox_transactions','INSERT') as user_can_insert_sandbox_directly,
  has_table_privilege('authenticated','public.nexora_sandbox_transactions','SELECT') as user_can_read_sandbox_via_rls,
  has_table_privilege('authenticated','public.nexora_provider_operations','SELECT') as user_can_read_provider_secrets_metadata,
  has_function_privilege('anon','public.nexora_sandbox_create_payment(uuid,numeric,text,text)','EXECUTE') as anon_can_create_sandbox,
  has_function_privilege('authenticated','public.nexora_provider_reserve_operation(uuid,uuid,text,text,text,text,uuid)','EXECUTE') as client_can_reserve_provider_operation;

-- Expected: all listed private tables have RLS=true; nexora-kyc is_public=false;
-- anon_can_insert_sandbox=false; user_can_insert_sandbox_directly=false;
-- user_can_read_sandbox_via_rls=true; user_can_read_provider_secrets_metadata=false;
-- anon_can_create_sandbox=false; client_can_reserve_provider_operation=false.

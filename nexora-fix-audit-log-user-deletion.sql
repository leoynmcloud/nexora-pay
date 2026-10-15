-- Permite exclusão de contas sem violação de chave estrangeira no log de auditoria imutável
begin;

-- Remove constraint estrita do audit log para que o histórico de ações não impeça remoção de usuários de teste
alter table if exists public.nexora_audit_log
  drop constraint if exists nexora_audit_log_actor_id_fkey;

-- Ajusta created_by para SET NULL caso o criador venha a ser removido
alter table if exists public.nexora_platform_provider_credentials
  drop constraint if exists nexora_platform_provider_credentials_created_by_fkey,
  add constraint nexora_platform_provider_credentials_created_by_fkey
    foreign key (created_by) references auth.users(id) on delete set null;

alter table if exists public.nexora_pricing_rules
  drop constraint if exists nexora_pricing_rules_created_by_fkey,
  add constraint nexora_pricing_rules_created_by_fkey
    foreign key (created_by) references auth.users(id) on delete set null;

alter table if exists public.nexora_payout_admin_events
  drop constraint if exists nexora_payout_admin_events_actor_id_fkey,
  add constraint nexora_payout_admin_events_actor_id_fkey
    foreign key (actor_id) references auth.users(id) on delete set null;

commit;

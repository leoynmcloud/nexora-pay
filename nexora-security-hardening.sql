-- Nexora Pay: hardening final para instalação existente.
-- Executar DEPOIS dos SQLs atuais de repair, onboarding e sandbox.
-- Reexecutável; preserva dados e não habilita pagamentos reais.
begin;

do $$ begin
  if to_regclass('public.nexora_customers') is null
     or to_regclass('public.nexora_transactions') is null
     or to_regclass('public.nexora_withdrawals') is null
     or to_regclass('public.nexora_sandbox_transactions') is null
     or to_regclass('public.nexora_sandbox_events') is null
     or to_regclass('public.nexora_admins') is null
     or to_regprocedure('public.nexora_account_active(uuid)') is null
     or to_regprocedure('public.get_nexora_admin_customers()') is null
     or to_regprocedure('public.get_nexora_client_transactions(uuid)') is null
     or to_regprocedure('public.get_nexora_admin_clients()') is null then
    raise exception 'Pré-requisito ausente: aplique os SQLs base, repair e as migrações de sandbox antes deste hardening.';
  end if;
end $$;

-- Evita que a reaplicação de scripts antigos conceda escrita direta a usuários.
alter table public.nexora_customers enable row level security;
alter table public.nexora_transactions enable row level security;
alter table public.nexora_withdrawals enable row level security;
alter table public.nexora_sandbox_transactions enable row level security;
alter table public.nexora_sandbox_events enable row level security;

revoke all on public.nexora_customers, public.nexora_transactions,
  public.nexora_withdrawals, public.nexora_sandbox_transactions,
  public.nexora_sandbox_events from public, anon, authenticated;
grant select on public.nexora_customers, public.nexora_transactions,
  public.nexora_withdrawals, public.nexora_sandbox_transactions,
  public.nexora_sandbox_events to authenticated;

-- Centraliza a autorização do admin e exige MFA aal2 no próprio banco.
-- As RPCs administrativas existentes já consultam esta função antes de agir.
create or replace function public.is_nexora_super_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(auth.jwt()->>'aal','aal1') = 'aal2'
    and exists (
      select 1 from auth.users u
      join public.nexora_admins a on lower(trim(a.email)) = lower(trim(u.email))
      where u.id = auth.uid()
        and a.role = 'super_admin'
        and public.nexora_account_active(u.id)
    );
$$;
revoke all on function public.is_nexora_super_admin() from public, anon;
grant execute on function public.is_nexora_super_admin() to authenticated;

-- Endpoints legados substituídos pelo snapshot atual: não deixe que uma RPC
-- antiga contorne os controles centrais ou devolva listagens sem paginação.
revoke all on function public.get_nexora_admin_customers() from public, anon, authenticated;
revoke all on function public.get_nexora_client_transactions(uuid) from public, anon, authenticated;
revoke all on function public.get_nexora_admin_clients() from public, anon, authenticated;

-- MFA é validado no Postgres usando o claim assinado do Supabase, não apenas
-- pela navegação do frontend. O trigger é uma segunda barreira além do RPC.
create or replace function public.nexora_require_aal2_for_sandbox_withdrawal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := coalesce(current_setting('request.jwt.claim.role', true), '');
  v_aal text := coalesce(auth.jwt()->>'aal', 'aal1');
begin
  if new.kind = 'withdrawal' and v_role <> 'service_role' and v_aal <> 'aal2' then
    raise exception 'Confirme sua identidade com o código de duas etapas antes de solicitar um saque.';
  end if;
  return new;
end;
$$;

revoke all on function public.nexora_require_aal2_for_sandbox_withdrawal() from public, anon, authenticated;
drop trigger if exists nexora_sandbox_withdrawal_requires_mfa on public.nexora_sandbox_transactions;
create trigger nexora_sandbox_withdrawal_requires_mfa
before insert on public.nexora_sandbox_transactions
for each row execute function public.nexora_require_aal2_for_sandbox_withdrawal();

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'nexora_customers','nexora_transactions','nexora_withdrawals',
    'nexora_sandbox_transactions','nexora_sandbox_events'
  ] loop
    if not coalesce((select c.relrowsecurity from pg_class c
      where c.oid = ('public.' || v_table)::regclass), false) then
      raise exception 'RLS não está habilitado em public.%', v_table;
    end if;
    if has_table_privilege('authenticated', 'public.' || v_table, 'INSERT')
       or has_table_privilege('authenticated', 'public.' || v_table, 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || v_table, 'DELETE')
       or has_table_privilege('authenticated', 'public.' || v_table, 'TRUNCATE') then
      raise exception 'Permissão DML direta ainda existe em public.%', v_table;
    end if;
  end loop;
  if has_function_privilege('authenticated','public.get_nexora_admin_customers()','EXECUTE')
     or has_function_privilege('authenticated','public.get_nexora_client_transactions(uuid)','EXECUTE')
     or has_function_privilege('authenticated','public.get_nexora_admin_clients()','EXECUTE') then
    raise exception 'RPC administrativa legada ainda está executável.';
  end if;
  if not exists (select 1 from pg_trigger
    where tgrelid = 'public.nexora_sandbox_transactions'::regclass
      and tgname = 'nexora_sandbox_withdrawal_requires_mfa' and not tgisinternal) then
    raise exception 'Trigger de MFA para saques de teste não foi instalado.';
  end if;
  if position('aal2' in pg_get_functiondef('public.is_nexora_super_admin()'::regprocedure)) = 0 then
    raise exception 'Exigência de MFA do super admin não foi instalada.';
  end if;
end $$;

select 'security hardening ok' as resultado,
       'RLS habilitado; DML direto bloqueado; MFA de saque validado no banco' as verificacoes;
commit;

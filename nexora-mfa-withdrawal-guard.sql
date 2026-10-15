-- MFA gate for sandbox withdrawal creation only.
-- Run after nexora-financial-core.sql. No real Pix or gateway is enabled here.
begin;

do $$ begin
  if to_regclass('public.nexora_sandbox_transactions') is null then
    raise exception 'Execute nexora-financial-core.sql first.';
  end if;
end $$;

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

commit;

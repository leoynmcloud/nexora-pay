-- Require a complete address when an editable KYC application is submitted.
-- The address is stored inside merchant_onboarding.data (JSONB), so no table change is needed.
begin;

do $$ begin
  if to_regclass('public.merchant_onboarding') is null then
    raise exception 'Execute nexora-onboarding-kyc.sql first.';
  end if;
end $$;

create or replace function public.nexora_kyc_require_complete_address()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'SUBMITTED'
     and old.status in ('DRAFT','PENDING_SUBMISSION','PENDING_DOCUMENTS','REJECTED')
     and (
       coalesce(new.data #>> '{company,postal_code}','') = ''
       or coalesce(new.data #>> '{company,address_street}','') = ''
       or coalesce(new.data #>> '{company,address_extra}','') = ''
       or coalesce(new.data #>> '{company,address_neighborhood}','') = ''
     ) then
    raise exception 'Preencha CEP, rua, número e bairro antes de enviar o cadastro.';
  end if;
  return new;
end;
$$;

revoke all on function public.nexora_kyc_require_complete_address() from public, anon, authenticated;
drop trigger if exists nexora_kyc_complete_address on public.merchant_onboarding;
create trigger nexora_kyc_complete_address
before update of status, data on public.merchant_onboarding
for each row execute function public.nexora_kyc_require_complete_address();

commit;

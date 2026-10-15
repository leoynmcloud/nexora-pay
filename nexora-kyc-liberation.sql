-- ==============================================================================
-- Nexora Pay - Liberação de KYC e Simplificação de Cadastro
-- ==============================================================================

begin;

-- 1. Aprova todos os cadastros pendentes ou em rascunho
update public.merchant_onboarding
set status = 'APPROVED',
    reviewed_at = coalesce(reviewed_at, now()),
    updated_at = now()
where status in ('DRAFT', 'PENDING_SUBMISSION', 'SUBMITTED', 'PENDING_DOCUMENTS', 'UNDER_REVIEW', 'MANUAL_REVIEW');

-- 2. Garante documento nas empresas de todos os lojistas
update public.businesses
set document = '19171665757'
where document is null or trim(document) = '';

-- 3. Habilita controles para todos os lojistas (pagamentos e saques)
insert into public.nexora_merchant_controls (
  business_id, owner_id, payments_enabled, withdrawals_enabled,
  api_enabled, pix_out_enabled, balance_movements_blocked, updated_by, updated_at
)
select
  b.id,
  b.owner_id,
  true,
  true,
  true,
  true,
  false,
  b.owner_id,
  now()
from public.businesses b
on conflict (business_id) do update set
  payments_enabled = true,
  withdrawals_enabled = true,
  api_enabled = true,
  pix_out_enabled = true,
  balance_movements_blocked = false,
  updated_at = now();

-- 4. Conecta todas as empresas ao Mercado Pago Produção
insert into public.nexora_merchant_provider_connections (
  business_id, owner_id, acquirer_id, status, configured_at, updated_at
)
select
  b.id,
  b.owner_id,
  a.id,
  'active',
  now(),
  now()
from public.businesses b
cross join public.nexora_acquirers a
where a.code = 'mercadopago_production'
on conflict (business_id) do update set
  acquirer_id = excluded.acquirer_id,
  status = 'active',
  updated_at = now();

-- 5. Garante regra de precificação Pix para todos os negócios
insert into public.nexora_pricing_rules (
  business_id, owner_id, acquirer_id, payment_method,
  fixed_fee_cents, variable_fee_bps, effective_from, reason, created_by
)
select
  b.id,
  b.owner_id,
  a.id,
  'pix',
  99,
  0,
  now() - interval '1 hour',
  'Tarifa padrão inicial Pix R$ 0,99',
  b.owner_id
from public.businesses b
cross join public.nexora_acquirers a
where a.code = 'mercadopago_production'
  and not exists (
    select 1 from public.nexora_pricing_rules r
    where r.business_id = b.id
      and r.acquirer_id = a.id
      and r.payment_method = 'pix'
  );

-- 6. Simplifica nexora_kyc_submit: sem bloqueio de MFA AAL2, sem exigência de arquivos obrigatórios,
--    aprovação direta das informações necessárias e provisionamento automático
create or replace function public.nexora_kyc_submit(p_data jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_status text;
  v_document text;
  v_type text;
  v_business_id uuid;
  v_acquirer_id uuid;
begin
  if v_user is null then raise exception 'Faça login para enviar o cadastro.'; end if;
  if jsonb_typeof(p_data) <> 'object' or pg_column_size(p_data) > 65536 then
    raise exception 'Dados cadastrais inválidos.';
  end if;

  v_type := coalesce(p_data #>> '{company,account_type}', 'individual');
  v_document := public.nexora_normalize_brazilian_document(coalesce(p_data #>> '{company,document_number}', '19171665757'));

  if v_type = 'company' then
    if not public.nexora_valid_cnpj(v_document) and length(v_document) <> 14 then
      raise exception 'Informe um CNPJ válido com 14 posições.';
    end if;
  else
    if not public.nexora_valid_cpf(v_document) and length(v_document) <> 11 then
      raise exception 'Informe um CPF válido com 11 dígitos.';
    end if;
  end if;

  p_data := jsonb_set(p_data, '{company,document_number}', to_jsonb(v_document), true);
  p_data := jsonb_set(p_data, '{company,cnpj}', to_jsonb(v_document), true);

  -- Atualiza o onboarding para APROVADO diretamente
  insert into public.merchant_onboarding (
    user_id, status, data, consented_at, privacy_notice_version,
    submitted_at, reviewed_by, reviewed_at, updated_at
  ) values (
    v_user, 'APPROVED', p_data, now(), '2026-10-12-kyb-v1',
    now(), v_user, now(), now()
  ) on conflict (user_id) do update set
    status = 'APPROVED',
    data = p_data,
    consented_at = now(),
    submitted_at = now(),
    reviewed_at = now(),
    reason_code = null,
    reason_description = null,
    updated_at = now();

  insert into public.merchant_kyc_reviews(user_id, reviewer_id, from_status, to_status, reason)
  values (v_user, v_user, 'DRAFT', 'APPROVED', 'Cadastro simplificado aprovado automaticamente.');

  -- Garante o negócio do usuário
  select id into v_business_id from public.businesses where owner_id = v_user order by id limit 1;
  if v_business_id is not null then
    update public.businesses
    set document = v_document,
        name = coalesce(nullif(trim(p_data #>> '{company,legal_name}'), ''), name)
    where id = v_business_id;
  else
    insert into public.businesses(owner_id, name, document)
    values (v_user, coalesce(nullif(trim(p_data #>> '{company,legal_name}'), ''), 'Minha Empresa'), v_document)
    returning id into v_business_id;
  end if;

  -- Localiza Mercado Pago Produção
  select id into v_acquirer_id from public.nexora_acquirers where code = 'mercadopago_production' limit 1;

  if v_business_id is not null then
    -- Controles do lojista
    insert into public.nexora_merchant_controls (
      business_id, owner_id, payments_enabled, withdrawals_enabled,
      api_enabled, pix_out_enabled, balance_movements_blocked, updated_by, updated_at
    ) values (
      v_business_id, v_user, true, true, true, true, false, v_user, now()
    ) on conflict (business_id) do update set
      payments_enabled = true,
      withdrawals_enabled = true,
      api_enabled = true,
      pix_out_enabled = true,
      balance_movements_blocked = false,
      updated_at = now();

    -- Rota de pagamento
    if v_acquirer_id is not null then
      insert into public.nexora_merchant_provider_connections (
        business_id, owner_id, acquirer_id, status, configured_at, updated_at
      ) values (
        v_business_id, v_user, v_acquirer_id, 'active', now(), now()
      ) on conflict (business_id) do update set
        acquirer_id = v_acquirer_id,
        status = 'active',
        updated_at = now();

      -- Regra de tarifa padrão Pix
      insert into public.nexora_pricing_rules (
        business_id, owner_id, acquirer_id, payment_method,
        fixed_fee_cents, variable_fee_bps, effective_from, reason, created_by
      ) select
        v_business_id, v_user, v_acquirer_id, 'pix', 99, 0,
        now() - interval '1 hour', 'Tarifa padrão inicial Pix R$ 0,99', v_user
      where not exists (
        select 1 from public.nexora_pricing_rules r
        where r.business_id = v_business_id and r.acquirer_id = v_acquirer_id and r.payment_method = 'pix'
      );
    end if;
  end if;

  return jsonb_build_object('status', 'APPROVED');
end;
$$;

revoke all on function public.nexora_kyc_submit(jsonb) from public, anon;
grant execute on function public.nexora_kyc_submit(jsonb) to authenticated;

-- 7. Simplifica nexora_admin_review_merchant para permitir aprovação sem exigir arquivos
create or replace function public.nexora_admin_review_merchant(p_user_id uuid, p_decision text, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
  v_reason text := left(trim(coalesce(p_reason, '')), 1000);
begin
  if not public.is_nexora_super_admin() then raise exception 'Acesso restrito ao super admin.'; end if;
  if p_decision not in ('APPROVED', 'PENDING_DOCUMENTS', 'REJECTED') then raise exception 'Decisão inválida.'; end if;
  if length(v_reason) < 3 then raise exception 'Registre um motivo válido.'; end if;

  select status into v_status from public.merchant_onboarding where user_id = p_user_id for update;
  if not found then raise exception 'Cadastro não encontrado.'; end if;

  update public.merchant_onboarding
  set status = p_decision,
      reason_code = case p_decision when 'APPROVED' then null when 'REJECTED' then 'REJECTED_BY_REVIEW' else 'ADDITIONAL_INFORMATION_REQUIRED' end,
      reason_description = case when p_decision = 'APPROVED' then null else v_reason end,
      reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
  where user_id = p_user_id;

  insert into public.merchant_kyc_reviews(user_id, reviewer_id, from_status, to_status, reason)
  values (p_user_id, auth.uid(), coalesce(v_status, 'DRAFT'), p_decision, v_reason);
end;
$$;

revoke all on function public.nexora_admin_review_merchant(uuid, text, text) from public, anon;
grant execute on function public.nexora_admin_review_merchant(uuid, text, text) to authenticated;

commit;

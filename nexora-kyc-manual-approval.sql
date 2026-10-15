-- nexora-kyc-manual-approval.sql
-- Restaura o fluxo de aprovação manual de KYC:
-- 1. O lojista preenche e envia o cadastro -> status fica 'SUBMITTED' (Em análise)
-- 2. O Super Admin visualiza na fila do Painel Admin (nexora_admin_kyc_list)
-- 3. O Super Admin aprova (APPROVED) ou rejeita (REJECTED) via nexora_admin_review_merchant
-- 4. Somente após a aprovação do Super Admin a conta é liberada para operar e transacionar

begin;

-- 1. nexora_kyc_submit: salva dados e marca status = 'SUBMITTED' (sem aprovação automática)
create or replace function public.nexora_kyc_submit(p_data jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_account_type text;
  v_document text;
  v_business_id uuid;
begin
  if v_user is null then
    raise exception 'Sessão expirada. Entre novamente.';
  end if;

  if not public.nexora_account_active(v_user) then
    raise exception 'Conta suspensa. Entre em contato com o suporte.';
  end if;

  if coalesce(auth.jwt()->>'aal', 'aal1') <> 'aal2' then
    if exists (
      select 1 from auth.mfa_factors f
      where f.user_id = v_user and f.status = 'verified'
    ) then
      raise exception 'Confirme a verificação em duas etapas antes de enviar o cadastro.';
    end if;
  end if;

  v_account_type := coalesce(nullif(trim(p_data #>> '{company,account_type}'), ''), 'individual');
  if v_account_type not in ('individual', 'company') then
    raise exception 'Tipo de conta inválido. Escolha pessoa física ou jurídica.';
  end if;

  v_document := coalesce(nullif(trim(p_data #>> '{company,document_number}'), ''),
                         nullif(trim(p_data #>> '{company,cnpj}'), ''));

  if v_document is null or length(v_document) < 11 then
    raise exception 'Informe um CPF ou CNPJ válido.';
  end if;

  v_document := regexp_replace(v_document, '[^0-9A-Za-z]', '', 'g');

  if length(coalesce(nullif(trim(p_data #>> '{company,legal_name}'), ''), '')) < 3 then
    raise exception 'Informe o nome completo ou razão social.';
  end if;

  if coalesce(nullif(trim(p_data #>> '{company,email}'), ''), '') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Informe um e-mail de contato válido.';
  end if;

  if length(regexp_replace(coalesce(p_data #>> '{company,phone}', ''), '[^0-9]', '', 'g')) < 10 then
    raise exception 'Informe um telefone com DDD válido.';
  end if;

  if length(regexp_replace(coalesce(p_data #>> '{address,postal_code}', ''), '[^0-9]', '', 'g')) <> 8 then
    raise exception 'Informe um CEP válido com 8 dígitos.';
  end if;

  if length(coalesce(nullif(trim(p_data #>> '{address,street}'), ''), '')) < 2 or
     length(coalesce(nullif(trim(p_data #>> '{address,number}'), ''), '')) < 1 or
     length(coalesce(nullif(trim(p_data #>> '{address,neighborhood}'), ''), '')) < 2 then
    raise exception 'Preencha o endereço completo (logradouro, número e bairro).';
  end if;

  if v_account_type = 'company' then
    if not public.nexora_valid_cnpj(v_document) and length(v_document) <> 14 then
      raise exception 'Informe um CNPJ válido com 14 caracteres.';
    end if;
  else
    if not public.nexora_valid_cpf(v_document) and length(v_document) <> 11 then
      raise exception 'Informe um CPF válido com 11 dígitos.';
    end if;
  end if;

  p_data := jsonb_set(p_data, '{company,document_number}', to_jsonb(v_document), true);
  p_data := jsonb_set(p_data, '{company,cnpj}', to_jsonb(v_document), true);

  -- Atualiza o onboarding para SUBMITTED (Em análise manual)
  insert into public.merchant_onboarding (
    user_id, status, data, consented_at, privacy_notice_version,
    submitted_at, reviewed_by, reviewed_at, reason_code, reason_description, updated_at
  ) values (
    v_user, 'SUBMITTED', p_data, now(), '2026-10-12-kyb-v1',
    now(), null, null, null, null, now()
  ) on conflict (user_id) do update set
    status = 'SUBMITTED',
    data = p_data,
    consented_at = now(),
    submitted_at = now(),
    reviewed_by = null,
    reviewed_at = null,
    reason_code = null,
    reason_description = null,
    updated_at = now();

  insert into public.merchant_kyc_reviews(user_id, reviewer_id, from_status, to_status, reason)
  values (v_user, v_user, 'DRAFT', 'SUBMITTED', 'Cadastro enviado pelo lojista para análise da equipe Nexora.');

  -- Garante registro em businesses para vincular ao lojista
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

  return jsonb_build_object(
    'status', 'SUBMITTED',
    'message', 'Cadastro enviado com sucesso! Seus dados estão em análise.'
  );
end;
$$;

revoke all on function public.nexora_kyc_submit(jsonb) from public, anon;
grant execute on function public.nexora_kyc_submit(jsonb) to authenticated;

-- 2. nexora_admin_kyc_list: lista cadastros enviados para análise do Super Admin
create or replace function public.nexora_admin_kyc_list()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_nexora_super_admin() then
    raise exception 'Acesso restrito ao Super Admin.';
  end if;
  if coalesce(auth.jwt()->>'aal','aal1') <> 'aal2' and exists(
    select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified'
  ) then
    raise exception 'Confirme MFA para consultar cadastros e documentos.';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(items) order by items.submitted_at desc nulls last)
    from (
      select
        m.user_id,
        u.email,
        coalesce(nullif(trim(u.raw_user_meta_data->>'full_name'), ''), split_part(u.email, '@', 1)) as full_name,
        m.status,
        m.data,
        m.reason_code,
        m.reason_description,
        m.submitted_at,
        m.reviewed_at,
        m.updated_at,
        m.created_at,
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', d.id,
            'document_type', d.document_type,
            'subject_key', d.subject_key,
            'storage_path', d.storage_path,
            'file_name', d.file_name,
            'content_type', d.content_type,
            'size_bytes', d.size_bytes,
            'uploaded_at', d.uploaded_at
          ) order by d.uploaded_at desc)
          from public.merchant_kyc_documents d
          where d.user_id = m.user_id
        ), '[]'::jsonb) as documents,
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'from_status', r.from_status,
            'to_status', r.to_status,
            'reason', r.reason,
            'created_at', r.created_at,
            'reviewer_email', (select reviewer.email from auth.users reviewer where reviewer.id = r.reviewer_id)
          ) order by r.created_at desc)
          from public.merchant_kyc_reviews r
          where r.user_id = m.user_id
        ), '[]'::jsonb) as review_history,
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'batch_id', s.batch_id,
            'subject_key', s.subject_key,
            'pep_result', s.pep_result,
            'sanctions_result', s.sanctions_result,
            'source_name', s.source_name,
            'reference_id', s.reference_id,
            'notes', s.notes,
            'screened_at', s.screened_at,
            'reviewer_email', (select reviewer.email from auth.users reviewer where reviewer.id = s.reviewer_id)
          ) order by s.screened_at desc, s.subject_key)
          from public.merchant_kyc_screenings s
          where s.user_id = m.user_id
        ), '[]'::jsonb) as screening_history
      from public.merchant_onboarding m
      join auth.users u on u.id = m.user_id
      where m.status <> 'DRAFT'
    ) items
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.nexora_admin_kyc_list() from public, anon;
grant execute on function public.nexora_admin_kyc_list() to authenticated;

-- 3. nexora_admin_review_merchant: Super Admin decide o cadastro (Aprova / Solicita Ajustes / Recusa)
-- Ao aprovar, ativa os controles do lojista, a conexão com gateway e as regras de precificação.
create or replace function public.nexora_admin_review_merchant(p_user_id uuid, p_decision text, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
  v_reason text := left(trim(coalesce(p_reason, '')), 1000);
  v_business_id uuid;
  v_acquirer_id uuid;
  v_onboarding_data jsonb;
begin
  if not public.is_nexora_super_admin() then
    raise exception 'Acesso restrito ao Super Admin.';
  end if;

  if coalesce(auth.jwt()->>'aal','aal1') <> 'aal2' and exists(
    select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified'
  ) then
    raise exception 'Confirme MFA antes de decidir o cadastro.';
  end if;

  if p_decision not in ('APPROVED', 'PENDING_DOCUMENTS', 'REJECTED') then
    raise exception 'Decisão inválida.';
  end if;

  if length(v_reason) < 3 then
    v_reason := case p_decision
      when 'APPROVED' then 'Cadastro aprovado pelo Super Admin'
      when 'REJECTED' then 'Cadastro recusado pela análise'
      else 'Documentos adicionais solicitados'
    end;
  end if;

  select status, data into v_status, v_onboarding_data
  from public.merchant_onboarding
  where user_id = p_user_id for update;

  if not found or v_status not in ('SUBMITTED', 'UNDER_REVIEW', 'MANUAL_REVIEW', 'PENDING_DOCUMENTS', 'REJECTED') then
    raise exception 'Cadastro indisponível para análise.';
  end if;

  update public.merchant_onboarding set
    status = p_decision,
    reason_code = case p_decision
      when 'APPROVED' then null
      when 'REJECTED' then 'REJECTED_BY_REVIEW'
      else 'ADDITIONAL_INFORMATION_REQUIRED'
    end,
    reason_description = case when p_decision = 'APPROVED' then null else v_reason end,
    reviewed_by = auth.uid(),
    reviewed_at = now(),
    updated_at = now()
  where user_id = p_user_id;

  -- Se for aprovado, ativa os recursos da conta para operar
  if p_decision = 'APPROVED' then
    select id into v_business_id from public.businesses where owner_id = p_user_id order by id limit 1;
    if v_business_id is null then
      insert into public.businesses(owner_id, name, document)
      values (
        p_user_id,
        coalesce(nullif(trim(v_onboarding_data #>> '{company,legal_name}'), ''), 'Minha Empresa'),
        v_onboarding_data #>> '{company,document_number}'
      )
      returning id into v_business_id;
    else
      update public.businesses
      set document = coalesce(v_onboarding_data #>> '{company,document_number}', document),
          name = coalesce(nullif(trim(v_onboarding_data #>> '{company,legal_name}'), ''), name)
      where id = v_business_id;
    end if;

    -- Ativa controles operacionais
    insert into public.nexora_merchant_controls (
      business_id, owner_id, payments_enabled, withdrawals_enabled,
      api_enabled, pix_out_enabled, balance_movements_blocked, updated_by, updated_at
    ) values (
      v_business_id, p_user_id, true, true, true, true, false, auth.uid(), now()
    ) on conflict (business_id) do update set
      payments_enabled = true,
      withdrawals_enabled = true,
      api_enabled = true,
      pix_out_enabled = true,
      balance_movements_blocked = false,
      updated_by = auth.uid(),
      updated_at = now();

    -- Conecta provedor de pagamento (Mercado Pago Produção)
    select id into v_acquirer_id from public.nexora_acquirers where code = 'mercadopago_production' limit 1;
    if v_acquirer_id is not null then
      insert into public.nexora_merchant_provider_connections (
        business_id, owner_id, acquirer_id, status, configured_at, updated_at
      ) values (
        v_business_id, p_user_id, v_acquirer_id, 'active', now(), now()
      ) on conflict (business_id) do update set
        acquirer_id = v_acquirer_id,
        status = 'active',
        updated_at = now();

      -- Regra de precificação padrão Pix R$ 0,99
      insert into public.nexora_pricing_rules (
        business_id, owner_id, acquirer_id, payment_method,
        fixed_fee_cents, variable_fee_bps, effective_from, reason, created_by
      ) select
        v_business_id, p_user_id, v_acquirer_id, 'pix', 99, 0,
        now() - interval '1 hour', 'Tarifa padrão inicial Pix R$ 0,99', auth.uid()
      where not exists (
        select 1 from public.nexora_pricing_rules r
        where r.business_id = v_business_id and r.acquirer_id = v_acquirer_id and r.payment_method = 'pix'
      );
    end if;
  elsif p_decision = 'REJECTED' then
    -- Se rejeitado, bloqueia pagamentos
    update public.nexora_merchant_controls
    set payments_enabled = false,
        updated_by = auth.uid(),
        updated_at = now()
    where owner_id = p_user_id;
  end if;

  insert into public.merchant_kyc_reviews(user_id, reviewer_id, from_status, to_status, reason)
  values (p_user_id, auth.uid(), coalesce(v_status, 'DRAFT'), p_decision, v_reason);

  insert into public.nexora_audit_log(actor_id, action, target_id, details)
  values (auth.uid(), 'kyc.merchant_reviewed', p_user_id::text,
    jsonb_build_object('from_status', v_status, 'to_status', p_decision, 'reason', v_reason));
end;
$$;

revoke all on function public.nexora_admin_review_merchant(uuid, text, text) from public, anon;
grant execute on function public.nexora_admin_review_merchant(uuid, text, text) to authenticated;

-- 4. Reposiciona o lojista de teste recente para 'SUBMITTED' para que o admin possa aprovar/reprovar
update public.merchant_onboarding
set status = 'SUBMITTED',
    reviewed_by = null,
    reviewed_at = null,
    reason_code = null,
    reason_description = null,
    updated_at = now()
where user_id = '537c72c8-1ef5-449e-878a-03b67e4e857a'
  and status = 'APPROVED';

update public.nexora_merchant_controls
set payments_enabled = false
where owner_id = '537c72c8-1ef5-449e-878a-03b67e4e857a';

notify pgrst, 'reload schema';

commit;

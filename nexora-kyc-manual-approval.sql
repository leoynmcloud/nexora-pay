-- =============================================================================
-- NEXORA PAY — FLUXO DE APROVAÇÃO MANUAL DE CADASTRO (KYC / ONBOARDING)
-- =============================================================================
-- Garante que:
-- 1. Novos cadastros iniciem como 'DRAFT' com operações bloqueadas (NUNCA aprovados automaticamente).
-- 2. Quando o cliente preenche o onboarding.html (nexora_kyc_submit), o status vai para 'SUBMITTED'.
-- 3. O Super Admin analisa no nexora-admin.html e aprova (APPROVED) ou recusa (REJECTED).
-- 4. Somente após a aprovação manual do Super Admin a conta e os controles são liberados.
-- =============================================================================

-- 1. Função de provisionamento inicial (chamada no signup e em get_my_access)
-- Cria estrutura básica do lojista em modo DRAFT e com controles desabilitados até aprovação.
create or replace function public.nexora_provision_merchant(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user record;
  v_is_admin boolean := false;
  v_name text;
  v_business_id uuid;
  v_acquirer_id uuid;
  v_kyc_status text;
  v_acct_type text;
begin
  if p_user_id is null then
    return null;
  end if;

  select id, email, raw_user_meta_data
  into v_user
  from auth.users
  where id = p_user_id;

  if v_user.id is null then
    return null;
  end if;

  select exists(
    select 1 from public.nexora_admins na
    where lower(na.email) = lower(coalesce(v_user.email, ''))
  ) into v_is_admin;

  v_name := coalesce(
    nullif(trim(v_user.raw_user_meta_data->>'full_name'), ''),
    nullif(trim(split_part(coalesce(v_user.email, ''), '@', 1)), ''),
    'Minha Empresa'
  );

  -- 1. Garante perfil ativo
  insert into public.profiles (id, email, full_name, role, status)
  values (v_user.id, coalesce(v_user.email, ''), v_name, case when v_is_admin then 'admin' else 'owner' end, 'active')
  on conflict (id) do update
  set email = excluded.email,
      full_name = coalesce(nullif(public.profiles.full_name, ''), excluded.full_name);

  -- 2. Garante onboarding inicial como DRAFT para clientes (ou APPROVED apenas para Super Admin)
  insert into public.merchant_onboarding (
    user_id,
    status,
    data,
    submitted_at,
    reviewed_at,
    reason_description,
    updated_at
  )
  values (
    v_user.id,
    case when v_is_admin then 'APPROVED' else 'DRAFT' end,
    jsonb_build_object(
      'company', jsonb_build_object(
        'legal_name', v_name,
        'email', coalesce(v_user.email, ''),
        'phone', coalesce(v_user.raw_user_meta_data->>'phone', '')
      )
    ),
    case when v_is_admin then now() else null end,
    case when v_is_admin then now() else null end,
    case when v_is_admin then 'Conta administrativa Nexora Pay' else null end,
    now()
  )
  on conflict (user_id) do nothing;

  select status into v_kyc_status
  from public.merchant_onboarding
  where user_id = v_user.id;

  -- 3. Garante workspace (business)
  select id into v_business_id
  from public.businesses
  where owner_id = v_user.id
  order by created_at asc, id asc
  limit 1;

  if v_business_id is null then
    insert into public.businesses (owner_id, name, status)
    values (v_user.id, v_name, 'active')
    returning id into v_business_id;
  end if;

  -- 4. Garante membro no workspace
  insert into public.workspace_members (business_id, user_id, role, status)
  values (v_business_id, v_user.id, 'owner', 'active')
  on conflict do nothing;

  -- 5. Garante contas do ledger
  foreach v_acct_type in array array['available', 'pending', 'reserved', 'blocked', 'fee_revenue'] loop
    insert into public.nexora_ledger_accounts (business_id, owner_id, account_type, currency)
    values (v_business_id, v_user.id, v_acct_type, 'BRL')
    on conflict (business_id, account_type, currency) do nothing;
  end loop;

  -- 6. Garante controles operacionais (desabilitados enquanto não aprovado)
  insert into public.nexora_merchant_controls (
    business_id,
    owner_id,
    payments_enabled,
    withdrawals_enabled,
    api_enabled,
    pix_out_enabled,
    balance_movements_blocked,
    withdrawal_mode,
    max_transfer_amount,
    daily_transfer_limit,
    alert_threshold_amount,
    reserve_percentage,
    reserve_days,
    updated_at
  )
  values (
    v_business_id,
    v_user.id,
    (v_is_admin or v_kyc_status = 'APPROVED'),
    (v_is_admin or v_kyc_status = 'APPROVED'),
    (v_is_admin or v_kyc_status = 'APPROVED'),
    (v_is_admin or v_kyc_status = 'APPROVED'),
    false,
    'manual',
    5000,
    20000,
    5000,
    0,
    0,
    now()
  )
  on conflict (business_id) do nothing;

  -- 7. Se já estiver aprovado (ou for admin), garante rota de adquirente e regras de preço padrão
  if v_is_admin or v_kyc_status = 'APPROVED' then
    select id into v_acquirer_id
    from public.nexora_acquirers
    where status = 'enabled' and environment = 'production'
    order by (case when code = 'mercadopago_production' then 0 else 1 end), created_at asc
    limit 1;

    if v_acquirer_id is not null then
      insert into public.nexora_merchant_provider_connections (
        business_id,
        owner_id,
        acquirer_id,
        environment,
        status,
        api_key_configured,
        updated_at
      )
      values (
        v_business_id,
        v_user.id,
        v_acquirer_id,
        'production',
        'active',
        true,
        now()
      )
      on conflict (business_id) do nothing;

      insert into public.nexora_pricing_rules (
        business_id,
        owner_id,
        acquirer_id,
        payment_method,
        fixed_fee_cents,
        variable_fee_bps,
        effective_from,
        created_by,
        reason
      )
      select
        v_business_id,
        v_user.id,
        v_acquirer_id,
        'pix',
        99,
        0,
        now() - interval '5 minutes',
        v_user.id,
        'Tarifa padrão Pix'
      where not exists (
        select 1 from public.nexora_pricing_rules r
        where r.business_id = v_business_id
          and r.acquirer_id = v_acquirer_id
          and r.payment_method = 'pix'
      );

      insert into public.nexora_pricing_rules (
        business_id,
        owner_id,
        acquirer_id,
        payment_method,
        fixed_fee_cents,
        variable_fee_bps,
        effective_from,
        created_by,
        reason
      )
      select
        v_business_id,
        v_user.id,
        v_acquirer_id,
        'credit_card',
        49,
        399,
        now() - interval '5 minutes',
        v_user.id,
        'Tarifa padrão Cartão de Crédito'
      where not exists (
        select 1 from public.nexora_pricing_rules r
        where r.business_id = v_business_id
          and r.acquirer_id = v_acquirer_id
          and r.payment_method = 'credit_card'
      );
    end if;
  end if;

  return v_business_id;
end;
$$;

-- 2. Trigger de novos cadastros em auth.users
create or replace function public.nexora_create_merchant_onboarding()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  perform public.nexora_provision_merchant(new.id);
  return new;
end;
$$;

-- 3. Função get_my_access: NUNCA aprova automaticamente; retorna can_operate = true somente se APPROVED
create or replace function public.get_my_access()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_profile record;
  v_control_status text;
  v_access_status text;
  v_status text;
  v_is_super boolean := false;
begin
  if v_uid is null then
    return jsonb_build_object(
      'status', 'unauthenticated',
      'access_status', 'unauthenticated',
      'onboarding_status', 'DRAFT',
      'is_admin', false,
      'is_super_admin', false,
      'can_access', false,
      'can_operate', false
    );
  end if;

  select public.is_nexora_super_admin_account() into v_is_super;

  if v_is_super then
    return jsonb_build_object(
      'status', 'active',
      'access_status', 'active',
      'onboarding_status', 'APPROVED',
      'is_admin', true,
      'is_super_admin', true,
      'can_access', true,
      'can_operate', true
    );
  end if;

  perform public.nexora_provision_merchant(v_uid);

  select id, role, status, is_admin into v_profile
  from public.profiles
  where id = v_uid;

  select status into v_control_status
  from public.nexora_account_controls
  where user_id = v_uid;

  v_access_status := case
    when v_control_status = 'suspended' then 'suspended'
    else coalesce(v_profile.status, 'active')
  end;

  select status into v_status
  from public.merchant_onboarding
  where user_id = v_uid;

  v_status := coalesce(v_status, 'DRAFT');

  return jsonb_build_object(
    'status', v_access_status,
    'access_status', v_access_status,
    'onboarding_status', v_status,
    'is_admin', coalesce(v_profile.is_admin, false),
    'is_super_admin', false,
    'can_access', v_access_status = 'active' and v_status not in ('SUSPENDED', 'BLOCKED', 'CLOSED'),
    'can_operate', v_access_status = 'active' and v_status = 'APPROVED'
  );
end;
$$;

grant execute on function public.get_my_access() to authenticated;

-- 4. Permissão para upload e registro de documentos KYC mesmo sem MFA ativo no lojista
drop policy if exists "merchant uploads own pending kyc files" on storage.objects;
create policy "merchant uploads own pending kyc files"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'nexora-kyc'
  and (storage.foldername(name))[1] = (auth.uid())::text
  and (
    coalesce(auth.jwt()->>'aal', 'aal1') = 'aal2'
    or not exists (
      select 1 from auth.mfa_factors f
      where f.user_id = auth.uid() and f.status = 'verified'
    )
  )
  and exists (
    select 1 from public.merchant_onboarding m
    where m.user_id = auth.uid()
      and m.status in ('DRAFT', 'PENDING_SUBMISSION', 'PENDING_DOCUMENTS', 'REJECTED')
  )
);

create or replace function public.nexora_kyc_register_document_v2(
  p_document_type text,
  p_subject_key text,
  p_storage_path text,
  p_file_name text,
  p_content_type text,
  p_size_bytes bigint
)
returns void
language plpgsql
security definer
set search_path = public, storage, auth
as $$
declare
  v_status text;
begin
  if auth.uid() is null then
    raise exception 'Faça login para enviar documentos.';
  end if;
  if coalesce(auth.jwt()->>'aal', 'aal1') <> 'aal2' and exists (
    select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified'
  ) then
    raise exception 'Confirme a verificação em duas etapas.';
  end if;
  select status into v_status from public.merchant_onboarding where user_id = auth.uid() for update;
  if not found or v_status not in ('DRAFT', 'PENDING_SUBMISSION', 'PENDING_DOCUMENTS', 'REJECTED') then
    raise exception 'O cadastro não está aberto para alteração.';
  end if;
  if p_document_type not in (
    'cnpj_proof', 'company_articles', 'representative_id_front', 'representative_id_back',
    'company_address_proof', 'bank_proof', 'additional_document', 'power_of_attorney', 'activity_license',
    'financial_document', 'owner_id_front', 'owner_id_back', 'owner_address_proof'
  ) then
    raise exception 'Tipo de documento inválido.';
  end if;
  if p_subject_key is null or p_subject_key !~ '^(company|representative|owner:[0-9a-fA-F-]{36})$' then
    raise exception 'Pessoa relacionada ao documento inválida.';
  end if;
  if (p_document_type in ('owner_id_front', 'owner_id_back', 'owner_address_proof')) <> (p_subject_key like 'owner:%') then
    raise exception 'O documento não corresponde à pessoa selecionada.';
  end if;
  if p_document_type in ('cnpj_proof', 'company_articles', 'company_address_proof', 'bank_proof', 'activity_license', 'financial_document')
     and p_subject_key <> 'company' then
    raise exception 'Documento deve estar vinculado à empresa.';
  end if;
  if p_document_type in ('representative_id_front', 'representative_id_back', 'additional_document', 'power_of_attorney')
     and p_subject_key <> 'representative' then
    raise exception 'Documento deve estar vinculado ao representante.';
  end if;
  if p_storage_path is null or left(p_storage_path, length(auth.uid()::text) + 1) <> auth.uid()::text || '/'
     or (storage.foldername(p_storage_path))[2] <> p_document_type then
    raise exception 'Caminho de documento inválido.';
  end if;
  if p_content_type not in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf') or p_size_bytes < 1 or p_size_bytes > 10485760 then
    raise exception 'Arquivo não permitido. Use PDF, JPG, PNG ou WebP de até 10 MB.';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'nexora-kyc' and o.name = p_storage_path) then
    raise exception 'O arquivo não foi encontrado no armazenamento privado.';
  end if;
  insert into public.merchant_kyc_documents(user_id, document_type, subject_key, storage_path, file_name, content_type, size_bytes)
  values (auth.uid(), p_document_type, p_subject_key, p_storage_path, left(coalesce(p_file_name, 'documento'), 255), p_content_type, p_size_bytes)
  on conflict (user_id, document_type, subject_key) do update set
    storage_path = excluded.storage_path,
    file_name = excluded.file_name,
    content_type = excluded.content_type,
    size_bytes = excluded.size_bytes,
    uploaded_at = now();
end;
$$;

grant execute on function public.nexora_kyc_register_document_v2(text, text, text, text, text, bigint) to authenticated;

-- 5. Submissão do formulário de Onboarding/KYC (nexora_kyc_submit)
-- Aceita tanto company.postal_code/address_street/address_extra/address_neighborhood quanto address.*
-- e grava status = 'SUBMITTED' (aguardando aprovação manual do Super Admin).
create or replace function public.nexora_kyc_submit(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user uuid := auth.uid();
  v_account_type text;
  v_document text;
  v_postal_code text;
  v_street text;
  v_number text;
  v_neighborhood text;
  v_city text;
  v_state text;
  v_business_id uuid;
  v_prev_status text;
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

  v_document := coalesce(
    nullif(trim(p_data #>> '{company,document_number}'), ''),
    nullif(trim(p_data #>> '{company,cnpj}'), '')
  );

  if v_document is null or length(v_document) < 11 then
    raise exception 'Informe um CPF ou CNPJ válido.';
  end if;

  v_document := upper(regexp_replace(v_document, '[^0-9A-Za-z]', '', 'g'));

  if length(coalesce(nullif(trim(p_data #>> '{company,legal_name}'), ''), '')) < 3 then
    raise exception 'Informe o nome completo ou razão social.';
  end if;

  if coalesce(nullif(trim(p_data #>> '{company,email}'), ''), '') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Informe um e-mail de contato válido.';
  end if;

  if length(regexp_replace(coalesce(p_data #>> '{company,phone}', ''), '[^0-9]', '', 'g')) < 10 then
    raise exception 'Informe um telefone com DDD válido.';
  end if;

  v_postal_code := regexp_replace(
    coalesce(
      nullif(trim(p_data #>> '{company,postal_code}'), ''),
      nullif(trim(p_data #>> '{address,postal_code}'), ''),
      ''
    ),
    '[^0-9]', '', 'g'
  );
  if length(v_postal_code) <> 8 then
    raise exception 'Informe um CEP válido com 8 dígitos.';
  end if;

  v_street := coalesce(
    nullif(trim(p_data #>> '{company,address_street}'), ''),
    nullif(trim(p_data #>> '{address,street}'), ''),
    ''
  );
  v_number := coalesce(
    nullif(trim(p_data #>> '{company,address_extra}'), ''),
    nullif(trim(p_data #>> '{address,number}'), ''),
    ''
  );
  v_neighborhood := coalesce(
    nullif(trim(p_data #>> '{company,address_neighborhood}'), ''),
    nullif(trim(p_data #>> '{address,neighborhood}'), ''),
    ''
  );
  v_city := coalesce(
    nullif(trim(p_data #>> '{company,address_city}'), ''),
    nullif(trim(p_data #>> '{address,city}'), ''),
    ''
  );
  v_state := upper(coalesce(
    nullif(trim(p_data #>> '{company,address_state}'), ''),
    nullif(trim(p_data #>> '{address,state}'), ''),
    ''
  ));

  if length(v_street) < 2 or length(v_number) < 1 or length(v_neighborhood) < 2 then
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
  p_data := jsonb_set(
    p_data,
    '{address}',
    jsonb_build_object(
      'postal_code', v_postal_code,
      'street', v_street,
      'number', v_number,
      'neighborhood', v_neighborhood,
      'city', v_city,
      'state', v_state
    ),
    true
  );

  select coalesce(status, 'DRAFT') into v_prev_status
  from public.merchant_onboarding
  where user_id = v_user;

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
  values (v_user, v_user, coalesce(v_prev_status, 'DRAFT'), 'SUBMITTED', 'Cadastro enviado pelo lojista para análise da equipe Nexora.');

  -- Garante registro em businesses com razão social e documento atualizados
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

grant execute on function public.nexora_kyc_submit(jsonb) to authenticated;

-- 6. Lista de cadastros no Painel Super Admin (inclui pendentes, rascunhos, aprovados e recusados de lojistas)
create or replace function public.nexora_admin_kyc_list()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.is_nexora_super_admin() then
    raise exception 'Acesso restrito ao Super Admin.';
  end if;
  if coalesce(auth.jwt()->>'aal', 'aal1') <> 'aal2' and exists(
    select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified'
  ) then
    raise exception 'Confirme MFA para consultar cadastros e documentos.';
  end if;

  return coalesce((
    select jsonb_agg(
      to_jsonb(items)
      order by
        case
          when items.status in ('SUBMITTED', 'UNDER_REVIEW', 'MANUAL_REVIEW', 'PENDING_DOCUMENTS') then 0
          when items.status = 'DRAFT' then 1
          when items.status in ('REJECTED', 'SUSPENDED', 'BLOCKED') then 2
          else 3
        end,
        coalesce(items.submitted_at, items.updated_at, items.created_at) desc nulls last
    )
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
      where not exists (
        select 1 from public.nexora_admins na
        where lower(na.email) = lower(u.email)
      )
    ) items
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.nexora_admin_kyc_list() to authenticated;

-- 7. Aprovação / Revisão Manual pelo Super Admin (nexora_admin_review_merchant)
create or replace function public.nexora_admin_review_merchant(
  p_user_id uuid,
  p_decision text,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_current public.merchant_onboarding;
  v_business_id uuid;
  v_acquirer_id uuid;
  v_document text;
  v_acct_type text;
begin
  if not public.is_nexora_super_admin() then
    raise exception 'Acesso restrito ao Super Admin.';
  end if;

  if coalesce(auth.jwt()->>'aal', 'aal1') <> 'aal2' and exists (
    select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified'
  ) then
    raise exception 'Confirme MFA para aprovar ou reprovar cadastros.';
  end if;

  if p_decision not in ('UNDER_REVIEW', 'MANUAL_REVIEW', 'PENDING_DOCUMENTS', 'APPROVED', 'REJECTED', 'SUSPENDED', 'BLOCKED', 'CLOSED') then
    raise exception 'Decisão cadastral inválida.';
  end if;

  if p_decision in ('PENDING_DOCUMENTS', 'REJECTED', 'SUSPENDED', 'BLOCKED', 'CLOSED')
     and length(coalesce(trim(p_reason), '')) < 3 then
    raise exception 'Informe o motivo para esta decisão.';
  end if;

  perform public.nexora_provision_merchant(p_user_id);

  select * into v_current
  from public.merchant_onboarding
  where user_id = p_user_id
  for update;

  if v_current.status is null then
    raise exception 'Cadastro não encontrado.';
  end if;

  update public.merchant_onboarding set
    status = p_decision,
    reviewed_by = auth.uid(),
    reviewed_at = now(),
    submitted_at = coalesce(submitted_at, now()),
    reason_code = lower(p_decision),
    reason_description = left(nullif(trim(p_reason), ''), 1000),
    updated_at = now()
  where user_id = p_user_id;

  insert into public.merchant_kyc_reviews(user_id, reviewer_id, from_status, to_status, reason)
  values (p_user_id, auth.uid(), v_current.status, p_decision, left(coalesce(nullif(trim(p_reason), ''), 'Decisão registrada pelo Super Admin.'), 1000));

  v_document := coalesce(
    nullif(trim(v_current.data #>> '{company,document_number}'), ''),
    nullif(trim(v_current.data #>> '{company,cnpj}'), '')
  );

  select id into v_business_id
  from public.businesses
  where owner_id = p_user_id
  order by id
  limit 1;

  if p_decision = 'APPROVED' then
    if v_business_id is not null then
      update public.businesses
      set document = coalesce(v_document, document),
          name = coalesce(nullif(trim(v_current.data #>> '{company,legal_name}'), ''), name)
      where id = v_business_id;
    else
      insert into public.businesses(owner_id, name, document)
      values (
        p_user_id,
        coalesce(nullif(trim(v_current.data #>> '{company,legal_name}'), ''), 'Minha Empresa'),
        v_document
      )
      returning id into v_business_id;
    end if;

    insert into public.workspace_members(business_id, user_id, role, status)
    values (v_business_id, p_user_id, 'owner', 'active')
    on conflict do nothing;

    foreach v_acct_type in array array['available', 'pending', 'reserved', 'blocked', 'fee_revenue'] loop
      insert into public.nexora_ledger_accounts (business_id, owner_id, account_type, currency)
      values (v_business_id, p_user_id, v_acct_type, 'BRL')
      on conflict (business_id, account_type, currency) do nothing;
    end loop;

    insert into public.nexora_merchant_controls (
      business_id, owner_id, payments_enabled, withdrawals_enabled, api_enabled, pix_out_enabled,
      balance_movements_blocked, withdrawal_mode, max_transfer_amount, daily_transfer_limit,
      alert_threshold_amount, reserve_percentage, reserve_days, updated_at
    ) values (
      v_business_id, p_user_id, true, true, true, true,
      false, 'manual', 5000, 20000, 5000, 0, 0, now()
    ) on conflict (business_id) do update set
      payments_enabled = true,
      withdrawals_enabled = true,
      api_enabled = true,
      pix_out_enabled = true,
      updated_at = now();

    select id into v_acquirer_id
    from public.nexora_acquirers
    where status = 'enabled' and environment = 'production'
    order by (case when code = 'mercadopago_production' then 0 else 1 end), created_at asc
    limit 1;

    if v_acquirer_id is not null then
      insert into public.nexora_merchant_provider_connections (
        business_id, owner_id, acquirer_id, environment, status, api_key_configured, updated_at
      ) values (
        v_business_id, p_user_id, v_acquirer_id, 'production', 'active', true, now()
      ) on conflict (business_id) do update set
        status = 'active',
        api_key_configured = true,
        updated_at = now();

      insert into public.nexora_pricing_rules (
        business_id, owner_id, acquirer_id, payment_method,
        fixed_fee_cents, variable_fee_bps, effective_from, created_by, reason
      )
      select
        v_business_id, p_user_id, v_acquirer_id, 'pix',
        99, 0, now() - interval '5 minutes', auth.uid(), 'Tarifa padrão Pix (Aprovação KYC)'
      where not exists (
        select 1 from public.nexora_pricing_rules r
        where r.business_id = v_business_id and r.acquirer_id = v_acquirer_id and r.payment_method = 'pix'
      );

      insert into public.nexora_pricing_rules (
        business_id, owner_id, acquirer_id, payment_method,
        fixed_fee_cents, variable_fee_bps, effective_from, created_by, reason
      )
      select
        v_business_id, p_user_id, v_acquirer_id, 'credit_card',
        49, 399, now() - interval '5 minutes', auth.uid(), 'Tarifa padrão Cartão (Aprovação KYC)'
      where not exists (
        select 1 from public.nexora_pricing_rules r
        where r.business_id = v_business_id and r.acquirer_id = v_acquirer_id and r.payment_method = 'credit_card'
      );
    end if;
  elsif v_business_id is not null and p_decision in ('REJECTED', 'PENDING_DOCUMENTS', 'SUSPENDED', 'BLOCKED', 'CLOSED') then
    update public.nexora_merchant_controls
    set payments_enabled = false,
        withdrawals_enabled = false,
        api_enabled = false,
        pix_out_enabled = false,
        updated_at = now()
    where business_id = v_business_id;
  end if;

  if p_decision in ('SUSPENDED', 'BLOCKED', 'CLOSED') then
    insert into public.nexora_account_controls(user_id, status, reason, updated_at)
    values (p_user_id, 'suspended', left(p_reason, 500), now())
    on conflict (user_id) do update set
      status = 'suspended',
      reason = excluded.reason,
      updated_at = now();
  elsif p_decision = 'APPROVED' then
    insert into public.nexora_account_controls(user_id, status, reason, updated_at)
    values (p_user_id, 'active', left(coalesce(p_reason, 'KYC aprovado'), 500), now())
    on conflict (user_id) do update set
      status = 'active',
      reason = excluded.reason,
      updated_at = now();
  end if;

  insert into public.nexora_audit_log(actor_id, action, target_id, details)
  values (
    auth.uid(),
    'kyc.' || lower(p_decision),
    p_user_id::text,
    jsonb_build_object('from_status', v_current.status, 'to_status', p_decision, 'reason', left(coalesce(p_reason, ''), 500))
  );
end;
$$;

grant execute on function public.nexora_admin_review_merchant(uuid, text, text) to authenticated;

-- 8. Preserva campos existentes ao salvar configurações parciais do site (ex.: modal de logo)
create or replace function public.nexora_admin_save_site(p_content jsonb)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_clean jsonb;
begin
  if not public.is_nexora_super_admin() then
    raise exception 'Acesso restrito ao Painel Nexora Pay.';
  end if;

  select coalesce(jsonb_object_agg(key, trim(value)), '{}'::jsonb)
  into v_clean
  from jsonb_each_text(coalesce(p_content, '{}'::jsonb))
  where key in (
    'accent', 'hero_title', 'hero_subtitle', 'hero_description',
    'hero_image', 'logo_url', 'pix_rate', 'withdrawal_rate',
    'support_email', 'privacy_email', 'legal_name', 'document'
  )
    and length(trim(value)) <= 2000;

  if coalesce(v_clean->>'accent', '') <> '' and (v_clean->>'accent') !~ '^#[0-9A-Fa-f]{6}$' then
    raise exception 'Cor principal inválida.';
  end if;
  if coalesce(v_clean->>'hero_image', '') <> '' and (v_clean->>'hero_image') !~ '^https://' then
    raise exception 'Use uma URL HTTPS para a imagem de fundo.';
  end if;
  if coalesce(v_clean->>'logo_url', '') <> '' and (v_clean->>'logo_url') !~ '^https://' then
    raise exception 'Use uma URL HTTPS para a logo.';
  end if;

  insert into public.nexora_site_settings (id, content, updated_at, updated_by)
  values (1, v_clean, now(), auth.uid())
  on conflict (id) do update
  set content = coalesce(public.nexora_site_settings.content, '{}'::jsonb) || excluded.content,
      updated_at = now(),
      updated_by = auth.uid();

  insert into public.nexora_audit_log (actor_id, action, target_id, details)
  values (auth.uid(), 'site.updated', '1', jsonb_build_object('fields', (select jsonb_agg(key) from jsonb_object_keys(v_clean) as key)));
end;
$$;

grant execute on function public.nexora_admin_save_site(jsonb) to authenticated;

-- 9. Reverte contas de clientes que foram aprovadas automaticamente sem envio real de KYC
update public.merchant_onboarding m
set status = 'DRAFT',
    submitted_at = null,
    reviewed_at = null,
    reviewed_by = null,
    reason_code = null,
    reason_description = null,
    updated_at = now()
from auth.users u
where u.id = m.user_id
  and m.reason_description = 'Aprovação automática de novo lojista'
  and coalesce(nullif(trim(m.data #>> '{company,document_number}'), ''), '') = ''
  and not exists (
    select 1 from public.nexora_admins na
    where lower(na.email) = lower(u.email)
  );

update public.nexora_merchant_controls mc
set payments_enabled = false,
    withdrawals_enabled = false,
    api_enabled = false,
    pix_out_enabled = false,
    updated_at = now()
from public.merchant_onboarding m
where m.user_id = mc.owner_id
  and m.status <> 'APPROVED'
  and not exists (
    select 1 from auth.users u
    join public.nexora_admins na on lower(na.email) = lower(u.email)
    where u.id = mc.owner_id
  );

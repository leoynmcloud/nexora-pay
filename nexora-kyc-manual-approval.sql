-- =============================================================================
-- NEXORA PAY — FLUXO DE APROVAÇÃO MANUAL DE CADASTRO (KYC / ONBOARDING)
-- =============================================================================
-- Garante que:
-- 1. Novos cadastros iniciem como 'DRAFT' com operações bloqueadas (NUNCA aprovados automaticamente).
-- 2. Quando o cliente preenche o onboarding.html (nexora_kyc_submit), o status vai para 'SUBMITTED'.
-- 3. O Super Admin analisa no nexora-admin.html e aprova (APPROVED) ou recusa (REJECTED).
-- 4. Somente após a aprovação manual do Super Admin a conta e os controles são liberados.
-- =============================================================================

-- 0. Garante colunas de perfil
alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists status text not null default 'active';
alter table public.profiles add column if not exists is_admin boolean not null default false;

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
  insert into public.profiles (id, email, full_name, role, status, is_admin)
  values (
    v_user.id,
    coalesce(v_user.email, ''),
    v_name,
    case when v_is_admin then 'admin' else 'owner' end,
    'active',
    v_is_admin
  )
  on conflict (id) do update
  set email = coalesce(nullif(excluded.email, ''), public.profiles.email),
      full_name = coalesce(nullif(public.profiles.full_name, ''), excluded.full_name),
      role = case when excluded.role = 'admin' then 'admin' else public.profiles.role end,
      status = coalesce(public.profiles.status, 'active'),
      is_admin = (v_is_admin or public.profiles.is_admin);

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
  insert into public.workspace_members (business_id, user_id, role)
  values (v_business_id, v_user.id, 'owner')
  on conflict do nothing;

  -- 5. Garante contas do ledger
  insert into public.nexora_ledger_accounts (owner_id, business_id, account_code, account_class, currency)
  values
    (v_user.id, v_business_id, 'provider_clearing', 'asset', 'BRL'),
    (v_user.id, v_business_id, 'merchant_pending', 'liability', 'BRL'),
    (v_user.id, v_business_id, 'merchant_available', 'liability', 'BRL'),
    (v_user.id, v_business_id, 'merchant_reserved', 'liability', 'BRL'),
    (v_user.id, v_business_id, 'merchant_blocked', 'liability', 'BRL'),
    (v_user.id, v_business_id, 'platform_fee_revenue', 'income', 'BRL'),
    (v_user.id, v_business_id, 'provider_fee_expense', 'expense', 'BRL')
  on conflict (business_id, account_code) do nothing;

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
        status,
        updated_at
      )
      values (
        v_business_id,
        v_user.id,
        v_acquirer_id,
        'active',
        now()
      )
      on conflict (business_id) do update set
        acquirer_id = excluded.acquirer_id,
        status = 'active',
        updated_at = now();

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
create or replace function public.nexora_user_mfa_ok()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select coalesce(auth.jwt()->>'aal', 'aal1') = 'aal2'
    or not exists (
      select 1 from auth.mfa_factors f
      where f.user_id = auth.uid() and f.status = 'verified'
    );
$$;

grant execute on function public.nexora_user_mfa_ok() to authenticated;

drop policy if exists "merchant uploads own pending kyc files" on storage.objects;
create policy "merchant uploads own pending kyc files"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'nexora-kyc'
  and (storage.foldername(name))[1] = (auth.uid())::text
  and public.nexora_user_mfa_ok()
  and exists (
    select 1 from public.merchant_onboarding m
    where m.user_id = auth.uid()
      and m.status in ('DRAFT', 'PENDING_SUBMISSION', 'PENDING_DOCUMENTS', 'REJECTED')
  )
);

drop policy if exists "merchant removes own replaceable kyc files" on storage.objects;
create policy "merchant removes own replaceable kyc files"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'nexora-kyc'
  and (storage.foldername(name))[1] = (auth.uid())::text
  and exists (
    select 1 from public.merchant_onboarding m
    where m.user_id = auth.uid()
      and m.status in ('DRAFT', 'PENDING_SUBMISSION', 'PENDING_DOCUMENTS', 'REJECTED')
  )
);

drop policy if exists "nexora_site_public_read" on storage.objects;
create policy "nexora_site_public_read"
on storage.objects
for select
to public
using (bucket_id = 'nexora-site');

drop policy if exists "nexora_site_image_upload" on storage.objects;
create policy "nexora_site_image_upload"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'nexora-site'
  and (public.is_nexora_super_admin() or public.is_nexora_super_admin_account())
);

drop policy if exists "nexora_site_image_update" on storage.objects;
create policy "nexora_site_image_update"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'nexora-site'
  and (public.is_nexora_super_admin() or public.is_nexora_super_admin_account())
)
with check (
  bucket_id = 'nexora-site'
  and (public.is_nexora_super_admin() or public.is_nexora_super_admin_account())
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
  if not public.nexora_user_mfa_ok() then
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

  if not public.nexora_user_mfa_ok() then
    raise exception 'Confirme a verificação em duas etapas antes de enviar o cadastro.';
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
  if not public.nexora_user_mfa_ok() then
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
begin
  if not public.is_nexora_super_admin() then
    raise exception 'Acesso restrito ao Super Admin.';
  end if;

  if not public.nexora_user_mfa_ok() then
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

    insert into public.workspace_members(business_id, user_id, role)
    values (v_business_id, p_user_id, 'owner')
    on conflict do nothing;

    insert into public.nexora_ledger_accounts (owner_id, business_id, account_code, account_class, currency)
    values
      (p_user_id, v_business_id, 'provider_clearing', 'asset', 'BRL'),
      (p_user_id, v_business_id, 'merchant_pending', 'liability', 'BRL'),
      (p_user_id, v_business_id, 'merchant_available', 'liability', 'BRL'),
      (p_user_id, v_business_id, 'merchant_reserved', 'liability', 'BRL'),
      (p_user_id, v_business_id, 'merchant_blocked', 'liability', 'BRL'),
      (p_user_id, v_business_id, 'platform_fee_revenue', 'income', 'BRL'),
      (p_user_id, v_business_id, 'provider_fee_expense', 'expense', 'BRL')
    on conflict (business_id, account_code) do nothing;

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
        business_id, owner_id, acquirer_id, status, updated_at
      ) values (
        v_business_id, p_user_id, v_acquirer_id, 'active', now()
      ) on conflict (business_id) do update set
        acquirer_id = excluded.acquirer_id,
        status = 'active',
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

-- 9. Corrige trigger legada handle_new_user para nunca gerar erro de chave duplicada em public.profiles
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'), ''), split_part(coalesce(new.email, ''), '@', 1))
  )
  on conflict (id) do update
  set email = coalesce(nullif(excluded.email, ''), public.profiles.email),
      full_name = coalesce(nullif(public.profiles.full_name, ''), excluded.full_name);

  return new;
end;
$$;

-- 10. Atualiza nexora_workspace_read_id e nexora_workspace_snapshot
-- Garante que onboarding_status NUNCA tenha fallback 'APPROVED' quando nulo (usa 'DRAFT') e inclui c.document nos clientes
create or replace function public.nexora_workspace_read_id()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sessão expirada. Entre novamente.';
  end if;
  if not public.nexora_account_active(auth.uid()) then
    raise exception 'Conta suspensa. Entre em contato com o suporte.';
  end if;
  perform public.nexora_provision_merchant(auth.uid());
  if not (public.is_nexora_super_admin() or public.is_nexora_super_admin_account()) and not exists (
    select 1 from public.merchant_onboarding m
    where m.user_id = auth.uid()
      and m.status not in ('SUSPENDED', 'BLOCKED', 'CLOSED')
  ) then
    raise exception 'Acesso indisponível para esta conta.';
  end if;
  select b.id into v_id from public.businesses b where b.owner_id = auth.uid() order by b.id limit 1;
  if v_id is null then
    raise exception 'Workspace não encontrado. Atualize a sessão.';
  end if;
  return v_id;
end;
$$;

create or replace function public.nexora_workspace_snapshot()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := public.nexora_workspace_read_id();
  v_status text;
  v_can_operate boolean;
  v_settings jsonb;
  v_transactions jsonb := '[]'::jsonb;
  v_customers jsonb := '[]'::jsonb;
  v_provider jsonb;
begin
  select coalesce(m.status, 'DRAFT') into v_status
  from public.merchant_onboarding m
  where m.user_id = auth.uid();

  if public.is_nexora_super_admin() or public.is_nexora_super_admin_account() then
    v_status := 'APPROVED';
    v_can_operate := true;
  else
    v_status := coalesce(v_status, 'DRAFT');
    v_can_operate := (v_status = 'APPROVED');
  end if;

  select to_jsonb(s) into v_settings from public.user_settings s where s.user_id = auth.uid();

  if v_can_operate then
    select coalesce(jsonb_agg(to_jsonb(t) || jsonb_build_object(
      'provider_adapter', route.provider_code,
      'provider_code', route.provider_code
    ) order by t.created_at desc, t.id), '[]'::jsonb)
    into v_transactions
    from public.nexora_transactions t
    left join lateral (
      select op.provider_code from public.nexora_provider_payment_operations op
      where op.transaction_id = t.id
      order by op.created_at desc, op.id desc limit 1
    ) route on true
    where t.business_id = v_id and t.owner_id = auth.uid();

    select coalesce(jsonb_agg(to_jsonb(c) order by c.last_activity desc, c.id), '[]'::jsonb)
    into v_customers
    from (
      select c.id, c.name, c.email, c.document,
        coalesce(sum(t.amount) filter(where t.kind <> 'withdrawal' and t.status = 'paid' and not t.test_mode), 0) as total,
        coalesce(max(coalesce(t.paid_at, t.created_at)) filter(where not t.test_mode), c.created_at) as last_activity
      from public.nexora_customers c
      left join public.nexora_transactions t
        on t.customer_id = c.id and t.business_id = c.business_id and t.owner_id = c.owner_id
      where c.business_id = v_id and c.owner_id = auth.uid()
      group by c.id
    ) c;

    select jsonb_build_object(
      'acquirer_id', a.id,
      'code', a.code,
      'name', a.name,
      'environment', a.environment,
      'status', c.status,
      'api_key_configured', (c.api_key_ciphertext is not null or exists(select 1 from public.nexora_platform_provider_credentials p where p.acquirer_id = a.id and p.status = 'active')),
      'payments_enabled', coalesce(m.payments_enabled, false)
    )
    into v_provider
    from public.nexora_merchant_provider_connections c
    join public.nexora_acquirers a on a.id = c.acquirer_id
    left join public.nexora_merchant_controls m on m.business_id = c.business_id and m.owner_id = c.owner_id
    where c.business_id = v_id and c.owner_id = auth.uid()
    limit 1;
  end if;

  return jsonb_build_object(
    'transactions', v_transactions,
    'customers', v_customers,
    'settings', coalesce(v_settings, '{}'::jsonb),
    'business_id', v_id,
    'business_name', (select b.name from public.businesses b where b.id = v_id),
    'balance', null,
    'sandbox', case when v_can_operate then (select r.sandbox from public.nexora_runtime_config r where r.id = true) else false end,
    'gateway_ready', case when v_can_operate then (select r.gateway_ready from public.nexora_runtime_config r where r.id = true) else false end,
    'provider', coalesce(v_provider, 'null'::jsonb),
    'can_operate', v_can_operate,
    'onboarding_status', coalesce(v_status, 'DRAFT')
  );
end;
$$;

-- 11. Normaliza métodos de pagamento ('card' e 'credit_card') nos RPCs administrativos de adquirentes e tarifas
create or replace function public.nexora_admin_save_acquirer(
  p_id uuid,
  p_code text,
  p_name text,
  p_api_base_url text,
  p_webhook_url text,
  p_environment text,
  p_payment_methods text[],
  p_status text,
  p_notes text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not public.is_nexora_super_admin() then
    raise exception 'Acesso restrito ao Painel Nexora Pay.';
  end if;
  if p_code !~ '^[a-z0-9][a-z0-9_-]{1,49}$'
    or length(trim(coalesce(p_name, ''))) not between 2 and 120
    or p_api_base_url !~ '^https://'
    or p_environment not in ('sandbox', 'production')
    or p_status not in ('enabled', 'disabled', 'degraded') then
    raise exception 'Dados do adquirente inválidos.';
  end if;
  if coalesce(array_length(p_payment_methods, 1), 0) = 0
    or exists(select 1 from unnest(p_payment_methods) m where m not in ('pix', 'card', 'credit_card', 'debit_card', 'boleto')) then
    raise exception 'Selecione ao menos um meio de pagamento válido.';
  end if;
  if p_webhook_url is not null and p_webhook_url <> '' and p_webhook_url !~ '^https://' then
    raise exception 'A URL do webhook precisa usar HTTPS.';
  end if;
  if p_id is null then
    insert into public.nexora_acquirers(code, name, api_base_url, webhook_url, environment, payment_methods, status, notes)
    values (lower(trim(p_code)), trim(p_name), trim(p_api_base_url), nullif(trim(p_webhook_url), ''), p_environment, p_payment_methods, p_status, left(coalesce(p_notes, ''), 1000))
    returning id into v_id;
  else
    update public.nexora_acquirers
    set code = lower(trim(p_code)),
        name = trim(p_name),
        api_base_url = trim(p_api_base_url),
        webhook_url = nullif(trim(p_webhook_url), ''),
        environment = p_environment,
        payment_methods = p_payment_methods,
        status = p_status,
        notes = left(coalesce(p_notes, ''), 1000),
        updated_at = now()
    where id = p_id
    returning id into v_id;
    if v_id is null then
      raise exception 'Adquirente não encontrado.';
    end if;
  end if;
  insert into public.nexora_audit_log(actor_id, action, target_id, details)
  values (auth.uid(), 'acquirer.saved', v_id::text, jsonb_build_object('code', p_code, 'name', p_name, 'status', p_status));
  return v_id;
end;
$$;

create or replace function public.nexora_admin_add_pricing_rule(
  p_business_id uuid,
  p_acquirer_id uuid,
  p_payment_method text,
  p_fixed_fee_cents bigint,
  p_variable_fee_bps integer,
  p_effective_from timestamp with time zone,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_id uuid;
begin
  if not public.is_nexora_super_admin() then
    raise exception 'MFA administrativo obrigatório.';
  end if;
  if p_business_id is null or p_acquirer_id is null or p_payment_method is null
    or p_payment_method not in ('pix', 'credit_card', 'debit_card', 'boleto')
    or p_fixed_fee_cents is null or p_fixed_fee_cents not between 0 and 100000000
    or p_variable_fee_bps is null or p_variable_fee_bps not between 0 and 10000
    or p_effective_from is null or p_effective_from < (now() - interval '10 minutes')
    or length(trim(coalesce(p_reason, ''))) not between 10 and 240 then
    raise exception 'Parâmetros da regra de tarifa inválidos.';
  end if;
  select b.owner_id into v_owner from public.businesses b where b.id = p_business_id;
  if v_owner is null then
    raise exception 'Workspace não encontrado.';
  end if;
  if not exists(
    select 1 from public.nexora_acquirers a
    where a.id = p_acquirer_id
      and a.status = 'enabled'
      and (
        p_payment_method = any(a.payment_methods)
        or (p_payment_method in ('credit_card', 'debit_card') and ('card' = any(a.payment_methods) or 'credit_card' = any(a.payment_methods)))
      )
  ) or not exists(
    select 1 from public.nexora_merchant_provider_connections c
    where c.business_id = p_business_id
      and c.owner_id = v_owner
      and c.acquirer_id = p_acquirer_id
      and c.status in ('pending', 'active')
  ) then
    raise exception 'Adquirente ou método indisponível.';
  end if;
  insert into public.nexora_pricing_rules(
    business_id, owner_id, acquirer_id, payment_method,
    fixed_fee_cents, variable_fee_bps, effective_from, reason, created_by
  )
  values (
    p_business_id, v_owner, p_acquirer_id, p_payment_method,
    p_fixed_fee_cents, p_variable_fee_bps, p_effective_from, trim(p_reason), auth.uid()
  )
  returning id into v_id;
  insert into public.nexora_audit_log(actor_id, action, target_id, details)
  values (
    auth.uid(), 'pricing.rule.created', v_id::text,
    jsonb_build_object(
      'business_id', p_business_id, 'acquirer_id', p_acquirer_id,
      'payment_method', p_payment_method, 'fixed_fee_cents', p_fixed_fee_cents,
      'variable_fee_bps', p_variable_fee_bps, 'effective_from', p_effective_from, 'reason', trim(p_reason)
    )
  );
  return v_id;
end;
$$;

create or replace function public.nexora_admin_assign_acquirer(p_owner_id uuid, p_acquirer_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business uuid;
  v_old uuid;
  v_name text;
begin
  if not public.is_nexora_super_admin() then
    raise exception 'Acesso restrito ao Painel Nexora Pay.';
  end if;
  if not exists(select 1 from auth.users where id = p_owner_id) then
    raise exception 'Conta não encontrada.';
  end if;
  select id into v_business from public.businesses where owner_id = p_owner_id order by id limit 1;
  if v_business is null then
    raise exception 'Esta conta ainda não possui workspace.';
  end if;
  select acquirer_id into v_old from public.nexora_merchant_provider_connections where business_id = v_business for update;
  if p_acquirer_id is null then
    delete from public.nexora_merchant_provider_connections where business_id = v_business;
    insert into public.nexora_audit_log(actor_id, action, target_id, details)
    values (auth.uid(), 'merchant.acquirer_unassigned', p_owner_id::text, jsonb_build_object('previous_acquirer_id', v_old));
    return;
  end if;
  select name into v_name from public.nexora_acquirers where id = p_acquirer_id and status = 'enabled';
  if v_name is null then
    raise exception 'Adquirente indisponível. Escolha um provedor liberado.';
  end if;
  if v_old is distinct from p_acquirer_id then
    insert into public.nexora_merchant_provider_connections(
      business_id, owner_id, acquirer_id, api_key_ciphertext,
      webhook_secret_ciphertext, webhook_url, status, last_error, configured_at, updated_at
    )
    values (v_business, p_owner_id, p_acquirer_id, null, null, null, 'pending', null, now(), now())
    on conflict(business_id) do update set
      owner_id = excluded.owner_id,
      acquirer_id = excluded.acquirer_id,
      api_key_ciphertext = null,
      webhook_secret_ciphertext = null,
      webhook_url = null,
      status = 'pending',
      last_error = null,
      configured_at = now(),
      updated_at = now();
  end if;

  insert into public.nexora_pricing_rules (
    business_id, owner_id, acquirer_id, payment_method,
    fixed_fee_cents, variable_fee_bps, effective_from, reason, created_by
  ) select
    v_business, p_owner_id, p_acquirer_id, 'pix', 99, 0,
    now() - interval '1 hour', 'Tarifa padrão inicial Pix R$ 0,99', auth.uid()
  where not exists (
    select 1 from public.nexora_pricing_rules r
    where r.business_id = v_business and r.acquirer_id = p_acquirer_id and r.payment_method = 'pix'
  );

  if exists(select 1 from public.nexora_acquirers where id = p_acquirer_id and ('credit_card' = any(payment_methods) or 'card' = any(payment_methods))) then
    insert into public.nexora_pricing_rules (
      business_id, owner_id, acquirer_id, payment_method,
      fixed_fee_cents, variable_fee_bps, effective_from, reason, created_by
    ) select
      v_business, p_owner_id, p_acquirer_id, 'credit_card', 49, 399,
      now() - interval '1 hour', 'Tarifa padrão inicial Cartão de Crédito 3.99% + R$ 0,49', auth.uid()
    where not exists (
      select 1 from public.nexora_pricing_rules r
      where r.business_id = v_business and r.acquirer_id = p_acquirer_id and r.payment_method = 'credit_card'
    );
  end if;

  insert into public.nexora_audit_log(actor_id, action, target_id, details)
  values (auth.uid(), 'merchant.acquirer_assigned', p_owner_id::text, jsonb_build_object(
    'previous_acquirer_id', v_old, 'acquirer_id', p_acquirer_id, 'acquirer_name', v_name,
    'credentials_configured', exists(select 1 from public.nexora_platform_provider_credentials p where p.acquirer_id = p_acquirer_id and p.status = 'active')
  ));
end;
$$;

create or replace function public.nexora_admin_activate_provider_route(p_business_id uuid, p_acquirer_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_environment text;
begin
  if not public.is_nexora_super_admin() then
    raise exception 'Acesso restrito ao Painel Nexora Pay com MFA.';
  end if;
  select b.owner_id, a.environment into v_owner, v_environment
  from public.businesses b
  join public.nexora_merchant_provider_connections c on c.business_id = b.id and c.owner_id = b.owner_id
  join public.nexora_acquirers a on a.id = c.acquirer_id
  where b.id = p_business_id and c.acquirer_id = p_acquirer_id and c.status in ('pending', 'active')
    and a.status = 'enabled';
  if not found then
    raise exception 'Rota atribuída ou adquirente habilitado não encontrado.';
  end if;
  if not exists(select 1 from public.nexora_platform_provider_credentials k
      where k.acquirer_id = p_acquirer_id and k.environment = v_environment and k.status = 'active') then
    raise exception 'Configure e valide primeiro a credencial central da Nexora.';
  end if;
  update public.nexora_merchant_provider_connections
  set status = 'active', last_error = null, updated_at = now()
  where business_id = p_business_id and owner_id = v_owner and acquirer_id = p_acquirer_id;

  insert into public.nexora_pricing_rules (
    business_id, owner_id, acquirer_id, payment_method,
    fixed_fee_cents, variable_fee_bps, effective_from, reason, created_by
  ) select
    p_business_id, v_owner, p_acquirer_id, 'pix', 99, 0,
    now() - interval '1 hour', 'Tarifa padrão inicial Pix R$ 0,99', auth.uid()
  where not exists (
    select 1 from public.nexora_pricing_rules r
    where r.business_id = p_business_id and r.acquirer_id = p_acquirer_id and r.payment_method = 'pix'
  );

  if exists(select 1 from public.nexora_acquirers where id = p_acquirer_id and ('credit_card' = any(payment_methods) or 'card' = any(payment_methods))) then
    insert into public.nexora_pricing_rules (
      business_id, owner_id, acquirer_id, payment_method,
      fixed_fee_cents, variable_fee_bps, effective_from, reason, created_by
    ) select
      p_business_id, v_owner, p_acquirer_id, 'credit_card', 49, 399,
      now() - interval '1 hour', 'Tarifa padrão inicial Cartão de Crédito 3.99% + R$ 0,49', auth.uid()
    where not exists (
      select 1 from public.nexora_pricing_rules r
      where r.business_id = p_business_id and r.acquirer_id = p_acquirer_id and r.payment_method = 'credit_card'
    );
  end if;

  insert into public.nexora_audit_log(actor_id, action, target_id, details)
  values (auth.uid(), 'provider.merchant_route.activated', p_business_id::text,
    jsonb_build_object('acquirer_id', p_acquirer_id, 'environment', v_environment));
end;
$$;

-- 12. Atualiza nexora_admin_provider_connections, nexora_admin_merchant_controls e nexora_admin_snapshot
create or replace function public.nexora_admin_provider_connections()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_nexora_super_admin() then
    raise exception 'Acesso restrito ao Painel Nexora Pay.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'owner_id', c.owner_id,
      'business_id', c.business_id,
      'business_name', b.name,
      'email', u.email,
      'acquirer_id', c.acquirer_id,
      'acquirer_name', a.name,
      'acquirer_code', a.code,
      'environment', a.environment,
      'api_base_url', a.api_base_url,
      'status', c.status,
      'webhook_url', c.webhook_url,
      'api_key_configured', (c.api_key_ciphertext is not null or exists(select 1 from public.nexora_platform_provider_credentials p where p.acquirer_id = a.id and p.status = 'active')),
      'webhook_secret_configured', c.webhook_secret_ciphertext is not null,
      'updated_at', c.updated_at
    ) order by c.updated_at desc)
    from public.nexora_merchant_provider_connections c
    join public.businesses b on b.id = c.business_id and b.owner_id = c.owner_id
    join auth.users u on u.id = c.owner_id
    join public.nexora_acquirers a on a.id = c.acquirer_id
  ), '[]'::jsonb);
end;
$$;

create or replace function public.nexora_admin_merchant_controls()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_nexora_super_admin() then
    raise exception 'Acesso administrativo com MFA obrigatório.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'owner_id', b.owner_id,
      'business_id', b.id,
      'business_name', b.name,
      'email', u.email,
      'onboarding_status', coalesce(k.status, 'DRAFT'),
      'payments_enabled', coalesce(m.payments_enabled, k.status = 'APPROVED'),
      'withdrawals_enabled', coalesce(m.withdrawals_enabled, k.status = 'APPROVED'),
      'pix_out_enabled', coalesce(m.pix_out_enabled, false),
      'balance_movements_blocked', coalesce(m.balance_movements_blocked, false),
      'api_enabled', coalesce(m.api_enabled, false),
      'withdrawal_mode', coalesce(m.withdrawal_mode, 'manual'),
      'max_transfer_amount', coalesce(m.max_transfer_amount, 5000),
      'daily_transfer_limit', coalesce(m.daily_transfer_limit, 20000),
      'alert_threshold_amount', coalesce(m.alert_threshold_amount, 5000),
      'reserve_percentage', coalesce(m.reserve_percentage, 0),
      'reserve_days', coalesce(m.reserve_days, 0),
      'updated_at', m.updated_at
    ) order by b.name)
    from public.businesses b
    join auth.users u on u.id = b.owner_id
    left join public.merchant_onboarding k on k.user_id = b.owner_id
    left join public.nexora_merchant_controls m on m.business_id = b.id and m.owner_id = b.owner_id
  ), '[]'::jsonb);
end;
$$;

create or replace function public.nexora_admin_snapshot(
  p_query text default ''::text,
  p_page integer default 0,
  p_limit integer default 25,
  p_customer_query text default ''::text,
  p_customer_page integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_accounts jsonb;
  v_customers jsonb;
  v_count integer;
  v_customer_count integer;
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
begin
  if not public.is_nexora_super_admin() then
    raise exception 'Acesso restrito ao Painel Nexora Pay.';
  end if;
  select count(*) into v_count
  from auth.users u
  left join public.user_settings s on s.user_id = u.id
  where concat_ws(' ', u.email, s.profile_name, u.raw_user_meta_data->>'full_name') ilike '%' || left(p_query, 160) || '%';

  select coalesce(jsonb_agg(to_jsonb(a)), '[]') into v_accounts
  from (
    select
      u.id as user_id,
      u.email,
      coalesce(nullif(s.profile_name, ''), nullif(u.raw_user_meta_data->>'full_name', ''), split_part(u.email, '@', 1)) as full_name,
      u.created_at,
      u.last_sign_in_at,
      coalesce(ac.status, 'active') as status,
      ac.reason,
      coalesce(
        mo.status,
        case when exists(select 1 from public.nexora_admins na where lower(na.email) = lower(u.email)) then 'APPROVED' else 'DRAFT' end
      ) as onboarding_status,
      (
        select jsonb_agg(jsonb_build_object(
          'id', b.id,
          'name', b.name,
          'customer_count', (select count(*) from public.nexora_customers c where c.business_id = b.id and c.owner_id = b.owner_id)
        ))
        from public.businesses b
        where b.owner_id = u.id
      ) as workspaces,
      (select exists(select 1 from public.nexora_admins na where lower(na.email) = lower(u.email))) as is_admin
    from auth.users u
    left join public.user_settings s on s.user_id = u.id
    left join public.nexora_account_controls ac on ac.user_id = u.id
    left join public.merchant_onboarding mo on mo.user_id = u.id
    where concat_ws(' ', u.email, s.profile_name, u.raw_user_meta_data->>'full_name') ilike '%' || left(p_query, 160) || '%'
    order by u.created_at desc, u.id
    limit v_limit offset greatest(coalesce(p_page, 0), 0) * v_limit
  ) a;

  select count(*) into v_customer_count
  from public.nexora_customers c
  join public.businesses b on b.id = c.business_id and b.owner_id = c.owner_id
  where concat_ws(' ', c.name, c.email, b.name) ilike '%' || left(p_customer_query, 160) || '%';

  select coalesce(jsonb_agg(to_jsonb(c)), '[]') into v_customers
  from (
    select
      c.id, c.name, c.email, c.owner_id, c.business_id, b.name as business_name,
      coalesce((
        select sum(t.amount) from public.nexora_transactions t
        where t.customer_id = c.id and t.owner_id = c.owner_id and t.business_id = c.business_id
          and t.source = 'gateway' and t.kind <> 'withdrawal' and t.status = 'paid' and not t.test_mode
      ), 0) as total,
      coalesce((
        select max(coalesce(t.paid_at, t.created_at)) from public.nexora_transactions t
        where t.customer_id = c.id and t.owner_id = c.owner_id and t.business_id = c.business_id
          and t.source = 'gateway' and not t.test_mode
      ), c.created_at) as last_activity
    from public.nexora_customers c
    join public.businesses b on b.id = c.business_id and b.owner_id = c.owner_id
    where concat_ws(' ', c.name, c.email, b.name) ilike '%' || left(p_customer_query, 160) || '%'
    order by c.created_at desc, c.id
    limit v_limit offset greatest(coalesce(p_customer_page, 0), 0) * v_limit
  ) c;

  return jsonb_build_object(
    'accounts', v_accounts,
    'account_count', v_count,
    'customers', v_customers,
    'customer_count', v_customer_count,
    'stats', jsonb_build_object(
      'accounts', (select count(*) from auth.users),
      'active_accounts', (select count(*) from auth.users u where public.nexora_account_active(u.id)),
      'suspended_accounts', (select count(*) from public.nexora_account_controls where status = 'suspended'),
      'workspaces', (select count(*) from public.businesses)
    ),
    'withdrawals', (
      select coalesce(jsonb_agg(to_jsonb(w)), '[]')
      from (
        select w.*, b.name as business_name, u.email
        from public.nexora_withdrawals w
        join public.businesses b on b.id = w.business_id and b.owner_id = w.owner_id
        join auth.users u on u.id = w.owner_id
        join public.nexora_transactions t on t.id = w.transaction_id
        where t.source = 'gateway' and not t.test_mode
        order by w.created_at desc limit 100
      ) w
    ),
    'audit', (
      select coalesce(jsonb_agg(to_jsonb(l)), '[]')
      from (select id, action, target_id, created_at from public.nexora_audit_log order by id desc limit 30) l
    ),
    'site', public.nexora_public_site_settings(),
    'sandbox', (select sandbox from public.nexora_runtime_config where id),
    'gateway_ready', (select gateway_ready from public.nexora_runtime_config where id)
  );
end;
$$;

-- 13. Reverte contas de clientes que foram aprovadas automaticamente sem envio real de KYC
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


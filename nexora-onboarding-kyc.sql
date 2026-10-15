-- Cadastro e análise KYC/KYB inicial da Nexora Pay.
-- Pré-requisitos: nexora-super-admin.sql, access-control.sql e nexora-repair.sql.
-- Senhas e sessões continuam exclusivamente no Supabase Auth.
-- Documentos ficam no bucket privado nexora-kyc, com URLs temporárias no backoffice.
begin;

do $$ begin
  if to_regclass('public.nexora_admins') is null
     or to_regclass('public.businesses') is null
     or to_regclass('public.workspace_members') is null
     or to_regprocedure('public.is_nexora_super_admin()') is null
     or to_regprocedure('public.nexora_account_active(uuid)') is null then
    raise exception 'Pré-requisito ausente. Execute os SQLs base do Supabase antes de nexora-onboarding-kyc.sql.';
  end if;
end $$;

create table if not exists public.merchant_onboarding (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'DRAFT' check (status in (
    'DRAFT','PENDING_SUBMISSION','SUBMITTED','PENDING_DOCUMENTS','UNDER_REVIEW',
    'MANUAL_REVIEW','APPROVED','REJECTED','SUSPENDED','BLOCKED','CLOSED'
  )),
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  consented_at timestamptz,
  privacy_notice_version text,
  reason_code text,
  reason_description text,
  submitted_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.merchant_kyc_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  document_type text not null check (document_type in (
    'cnpj_proof','company_articles','representative_id_front','representative_id_back',
    'company_address_proof','bank_proof','additional_document'
  )),
  storage_path text not null unique,
  file_name text not null,
  content_type text not null check (content_type in ('image/jpeg','image/png','image/webp','application/pdf')),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  uploaded_at timestamptz not null default now(),
  unique (user_id, document_type)
);

create table if not exists public.merchant_kyc_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  reviewer_id uuid references auth.users(id) on delete set null,
  from_status text not null,
  to_status text not null,
  reason text not null,
  created_at timestamptz not null default now()
);

create index if not exists merchant_onboarding_status_submitted_idx
  on public.merchant_onboarding(status, submitted_at desc);
create index if not exists merchant_kyc_documents_user_idx
  on public.merchant_kyc_documents(user_id, uploaded_at desc);
create index if not exists merchant_kyc_reviews_user_idx
  on public.merchant_kyc_reviews(user_id, created_at desc);

alter table public.merchant_onboarding enable row level security;
alter table public.merchant_kyc_documents enable row level security;
alter table public.merchant_kyc_reviews enable row level security;

revoke all on public.merchant_onboarding from anon, authenticated;
revoke all on public.merchant_kyc_documents from anon, authenticated;
revoke all on public.merchant_kyc_reviews from anon, authenticated;
grant select on public.merchant_onboarding, public.merchant_kyc_documents to authenticated;

drop policy if exists "users read own onboarding" on public.merchant_onboarding;
create policy "users read own onboarding" on public.merchant_onboarding
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "users read own kyc document metadata" on public.merchant_kyc_documents;
create policy "users read own kyc document metadata" on public.merchant_kyc_documents
  for select to authenticated using (user_id = auth.uid());

-- Cria a ficha vazia no mesmo momento que o Supabase Auth cria a conta.
create or replace function public.nexora_create_merchant_onboarding()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.merchant_onboarding(user_id, status, data)
  values (new.id, 'DRAFT', '{}'::jsonb)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists nexora_auth_create_merchant_onboarding on auth.users;
create trigger nexora_auth_create_merchant_onboarding
  after insert on auth.users
  for each row execute function public.nexora_create_merchant_onboarding();

-- Bucket privado: sem leitura pública; arquivos limitados a imagens e PDF de até 10 MB.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('nexora-kyc','nexora-kyc',false,10485760,array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do update set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "merchant uploads own pending kyc files" on storage.objects;
create policy "merchant uploads own pending kyc files" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'nexora-kyc'
    and coalesce(auth.jwt()->>'aal','aal1') = 'aal2'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1 from public.merchant_onboarding m
      where m.user_id = auth.uid()
        and m.status in ('DRAFT','PENDING_SUBMISSION','PENDING_DOCUMENTS','REJECTED')
    )
  );

drop policy if exists "merchant and admin read private kyc files" on storage.objects;
create policy "merchant and admin read private kyc files" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'nexora-kyc'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_nexora_super_admin())
  );

drop policy if exists "merchant removes own replaceable kyc files" on storage.objects;
create policy "merchant removes own replaceable kyc files" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'nexora-kyc'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1 from public.merchant_onboarding m
      where m.user_id = auth.uid() and m.status in ('DRAFT','PENDING_DOCUMENTS','REJECTED')
    )
  );

create or replace function public.nexora_kyc_register_document(
  p_document_type text, p_storage_path text, p_file_name text,
  p_content_type text, p_size_bytes bigint
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  if auth.uid() is null then raise exception 'Faça login para enviar documentos.'; end if;
  if coalesce(auth.jwt()->>'aal','aal1') <> 'aal2' then
    raise exception 'Confirme sua identidade com a verificação em duas etapas antes de enviar documentos.';
  end if;
  select status into v_status from public.merchant_onboarding where user_id = auth.uid() for update;
  if not found or v_status not in ('DRAFT','PENDING_SUBMISSION','PENDING_DOCUMENTS','REJECTED') then
    raise exception 'O cadastro não está aberto para alteração.';
  end if;
  if p_document_type not in ('cnpj_proof','company_articles','representative_id_front','representative_id_back','company_address_proof','bank_proof','additional_document') then
    raise exception 'Tipo de documento inválido.';
  end if;
  if p_storage_path is null or left(p_storage_path, length(auth.uid()::text) + 1) <> auth.uid()::text || '/' then
    raise exception 'Caminho de documento inválido.';
  end if;
  if (storage.foldername(p_storage_path))[2] <> p_document_type then raise exception 'O documento não corresponde à pasta de armazenamento.'; end if;
  if p_content_type not in ('image/jpeg','image/png','image/webp','application/pdf') or p_size_bytes < 1 or p_size_bytes > 10485760 then
    raise exception 'Arquivo não permitido. Use JPG, PNG, WebP ou PDF de até 10 MB.';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'nexora-kyc' and o.name = p_storage_path) then
    raise exception 'O arquivo não foi encontrado no armazenamento privado.';
  end if;
  insert into public.merchant_kyc_documents(user_id, document_type, storage_path, file_name, content_type, size_bytes)
  values (auth.uid(), p_document_type, p_storage_path, left(coalesce(p_file_name,'documento'),255), p_content_type, p_size_bytes)
  on conflict (user_id, document_type) do update set
    storage_path = excluded.storage_path,
    file_name = excluded.file_name,
    content_type = excluded.content_type,
    size_bytes = excluded.size_bytes,
    uploaded_at = now();
end;
$$;

create or replace function public.nexora_kyc_submit(p_data jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_status text; v_missing text[];
begin
  if auth.uid() is null then raise exception 'Faça login para enviar o cadastro.'; end if;
  if coalesce(auth.jwt()->>'aal','aal1') <> 'aal2' then
    raise exception 'Confirme sua identidade com a verificação em duas etapas antes de enviar o cadastro.';
  end if;
  if jsonb_typeof(p_data) <> 'object' then raise exception 'Dados cadastrais inválidos.'; end if;
  if pg_column_size(p_data) > 65536 then raise exception 'O cadastro excede o tamanho permitido.'; end if;
  if jsonb_typeof(p_data->'company') <> 'object' or jsonb_typeof(p_data->'representative') <> 'object'
     or jsonb_typeof(coalesce(p_data->'owners','[]'::jsonb)) <> 'array' then
    raise exception 'Seções do cadastro inválidas.';
  end if;
  if jsonb_array_length(coalesce(p_data->'owners','[]'::jsonb)) > 50 then raise exception 'Limite de 50 sócios/beneficiários excedido.'; end if;
  if coalesce(p_data->>'privacy_consent','false') <> 'true'
     or coalesce(p_data->>'privacy_notice_version','') <> '2026-10-08-beta-v3' then
    raise exception 'Confirme o aviso de privacidade antes de enviar.';
  end if;
  if coalesce(p_data #>> '{company,account_type}','') not in ('company','individual')
     or coalesce(p_data #>> '{company,legal_name}','') = ''
     or coalesce(p_data #>> '{company,phone}','') = ''
     or coalesce(p_data #>> '{company,email}','') = ''
     or coalesce(p_data #>> '{company,postal_code}','') = ''
     or coalesce(p_data #>> '{representative,full_name}','') = '' then
    raise exception 'Preencha nome, documento, e-mail, celular e CEP.';
  end if;
  if p_data #>> '{company,account_type}' = 'company'
     and (coalesce(p_data #>> '{company,document_type}','') <> 'cnpj'
       or length(regexp_replace(coalesce(p_data #>> '{company,document_number}',''), '[^0-9]','','g')) <> 14) then
    raise exception 'Informe um CNPJ válido com 14 dígitos.';
  elsif p_data #>> '{company,account_type}' = 'individual'
     and (coalesce(p_data #>> '{company,document_type}','') <> 'cpf'
       or length(regexp_replace(coalesce(p_data #>> '{company,document_number}',''), '[^0-9]','','g')) <> 11) then
    raise exception 'Informe um CPF válido com 11 dígitos.';
  end if;
  if exists (
    select 1 from unnest(array[
      'company.postal_code','company.address_street','company.address_extra','company.address_neighborhood'
    ]) as required(field_path)
    where coalesce(p_data #>> string_to_array(required.field_path,'.'),'') = ''
  ) then raise exception 'Preencha CEP, rua, número e bairro.'; end if;
  select status into v_status from public.merchant_onboarding where user_id = auth.uid() for update;
  if not found then raise exception 'Ficha cadastral não encontrada. Entre novamente.'; end if;
  if v_status not in ('DRAFT','PENDING_SUBMISSION','PENDING_DOCUMENTS','REJECTED') then
    raise exception 'Este cadastro já está em análise ou foi aprovado; não pode ser alterado agora.';
  end if;
  select array_agg(required_type) into v_missing
  from unnest(array['representative_id_front','representative_id_back','additional_document']) as required(required_type)
  where not exists (
    select 1 from public.merchant_kyc_documents d
    where d.user_id = auth.uid() and d.document_type = required_type
  );
  if coalesce(array_length(v_missing,1),0) > 0 then
    raise exception 'Documentos obrigatórios ausentes: %', array_to_string(v_missing, ', ');
  end if;
  update public.merchant_onboarding
  set data = p_data, status = 'SUBMITTED', reason_code = null, reason_description = null,
      consented_at = now(), privacy_notice_version = '2026-10-08-beta-v3',
      submitted_at = now(), reviewed_by = null, reviewed_at = null, updated_at = now()
  where user_id = auth.uid();
  insert into public.merchant_kyc_reviews(user_id, reviewer_id, from_status, to_status, reason)
  values (auth.uid(), auth.uid(), v_status, 'SUBMITTED', 'Cliente enviou o cadastro para análise.');
  return jsonb_build_object('status','SUBMITTED');
end;
$$;

create or replace function public.nexora_admin_kyc_list()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_nexora_super_admin() then raise exception 'Acesso restrito ao super admin.'; end if;
  return coalesce((
    select jsonb_agg(to_jsonb(items) order by items.submitted_at desc nulls last)
    from (
      select m.user_id, u.email,
        coalesce(nullif(trim(u.raw_user_meta_data->>'full_name'),''), split_part(u.email,'@',1)) as full_name,
        m.status, m.data, m.reason_code, m.reason_description, m.submitted_at, m.created_at,
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'id',d.id,'document_type',d.document_type,'storage_path',d.storage_path,
            'file_name',d.file_name,'content_type',d.content_type,'size_bytes',d.size_bytes,'uploaded_at',d.uploaded_at
          ) order by d.uploaded_at desc)
          from public.merchant_kyc_documents d where d.user_id = m.user_id
        ),'[]'::jsonb) as documents
        ,coalesce((
          select jsonb_agg(jsonb_build_object(
            'from_status',r.from_status,'to_status',r.to_status,'reason',r.reason,'created_at',r.created_at,
            'reviewer_email',(select reviewer.email from auth.users reviewer where reviewer.id = r.reviewer_id)
          ) order by r.created_at desc)
          from public.merchant_kyc_reviews r where r.user_id = m.user_id
        ),'[]'::jsonb) as review_history
      from public.merchant_onboarding m
      join auth.users u on u.id = m.user_id
      where m.status <> 'DRAFT'
    ) items
  ),'[]'::jsonb);
end;
$$;

create or replace function public.nexora_admin_review_merchant(p_user_id uuid, p_decision text, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_status text; v_reason text := left(trim(coalesce(p_reason,'')),1000);
begin
  if not public.is_nexora_super_admin() then raise exception 'Acesso restrito ao super admin.'; end if;
  if p_decision not in ('APPROVED','PENDING_DOCUMENTS','REJECTED') then raise exception 'Decisão inválida.'; end if;
  if length(v_reason) < 5 then raise exception 'Registre um motivo com pelo menos 5 caracteres.'; end if;
  select status into v_status from public.merchant_onboarding where user_id = p_user_id for update;
  if not found or v_status not in ('SUBMITTED','UNDER_REVIEW','MANUAL_REVIEW','PENDING_DOCUMENTS','REJECTED') then
    raise exception 'Este cadastro não está disponível para análise.';
  end if;
  if p_decision = 'APPROVED' and exists (
    select 1 from unnest(array['representative_id_front','representative_id_back','additional_document']) as required(required_type)
    where not exists (select 1 from public.merchant_kyc_documents d where d.user_id = p_user_id and d.document_type = required.required_type)
  ) then raise exception 'Não é possível aprovar: faltam documentos obrigatórios.'; end if;
  update public.merchant_onboarding
  set status = p_decision, reason_code = case p_decision when 'APPROVED' then null when 'REJECTED' then 'REJECTED_BY_REVIEW' else 'ADDITIONAL_INFORMATION_REQUIRED' end,
      reason_description = case when p_decision = 'APPROVED' then null else v_reason end,
      reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
  where user_id = p_user_id;
  insert into public.merchant_kyc_reviews(user_id, reviewer_id, from_status, to_status, reason)
  values (p_user_id, auth.uid(), v_status, p_decision, v_reason);
end;
$$;

-- Só cadastro aprovado acessa o workspace; o super admin mantém sua rota administrativa.
-- A ativação da conta continua respeitando os controles administrativos já instalados.
create or replace function public.get_my_access()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_is_admin boolean;
  v_status text;
  v_id uuid;
  v_name text;
  v_document text;
begin
  if v_user is null then raise exception 'Sessão expirada. Entre novamente.'; end if;
  v_is_admin := public.is_nexora_super_admin();
  if not public.nexora_account_active(v_user) then
    return jsonb_build_object('user_id',v_user,'can_access',false,'access_status','suspended','onboarding_status','SUSPENDED','is_nexora_admin',v_is_admin);
  end if;
  if not v_is_admin then
    insert into public.merchant_onboarding(user_id,status,data)
    values (v_user,'DRAFT','{}'::jsonb) on conflict(user_id) do nothing;
    select status into v_status from public.merchant_onboarding where user_id = v_user;
    if v_status is distinct from 'APPROVED' then
      return jsonb_build_object('user_id',v_user,'can_access',false,'access_status','pending_kyc','onboarding_status',coalesce(v_status,'DRAFT'),'is_nexora_admin',false);
    end if;
  end if;
  perform 1 from auth.users where id = v_user for update;
  select id,name into v_id,v_name from public.businesses where owner_id = v_user order by id limit 1;
  if v_id is null then
    select coalesce(nullif(trim(data #>> '{company,trade_name}'),''),
                    nullif(trim(u.raw_user_meta_data->>'full_name'),''),
                    split_part(u.email,'@',1)) || ' · Nexora',
                    nullif(regexp_replace(coalesce(data #>> '{company,document_number}',''),'[^0-9]','','g'),'')
    into v_name,v_document
    from auth.users u left join public.merchant_onboarding m on m.user_id = u.id where u.id = v_user;
    insert into public.businesses(owner_id,name,document) values(v_user,v_name,v_document) returning id into v_id;
  elsif not v_is_admin then
    select coalesce(nullif(trim(m.data #>> '{company,trade_name}'),''), b.name) || ' · Nexora',
           nullif(regexp_replace(coalesce(m.data #>> '{company,document_number}',''),'[^0-9]','','g'),'')
    into v_name,v_document
    from public.businesses b
    left join public.merchant_onboarding m on m.user_id = b.owner_id
    where b.id = v_id and b.owner_id = v_user;
    update public.businesses set name = v_name, document = coalesce(v_document,document)
      where id = v_id and owner_id = v_user;
  end if;
  insert into public.workspace_members(business_id,user_id,role)
  values(v_id,v_user,'owner') on conflict(business_id,user_id) do update set role='owner';
  return jsonb_build_object('user_id',v_user,'business_id',v_id,'business_name',v_name,
    'role','owner','can_access',true,'access_status','active','onboarding_status','APPROVED','is_nexora_admin',v_is_admin);
end;
$$;

-- A aprovação também é aplicada no banco, não só escondida pela interface.
create or replace function public.nexora_assert_workspace()
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Sessão expirada. Entre novamente.'; end if;
  if not public.nexora_account_active(auth.uid()) then raise exception 'Conta suspensa. Entre em contato com o suporte.'; end if;
  if not public.is_nexora_super_admin() and not exists (
    select 1 from public.merchant_onboarding m where m.user_id = auth.uid() and m.status = 'APPROVED'
  ) then raise exception 'Cadastro ainda não aprovado. Acesse a etapa de análise cadastral.'; end if;
  select id into v_id from public.businesses where owner_id = auth.uid() order by id limit 1;
  if v_id is null then raise exception 'Workspace não encontrado. Entre novamente.'; end if;
  return v_id;
end;
$$;

drop policy if exists nexora_customer_read on public.nexora_customers;
create policy nexora_customer_read on public.nexora_customers for select to authenticated
using (owner_id = auth.uid() and public.nexora_account_active(auth.uid())
  and (public.is_nexora_super_admin() or exists (
    select 1 from public.merchant_onboarding m where m.user_id = auth.uid() and m.status = 'APPROVED'
  ))
  and exists (select 1 from public.businesses b where b.id = business_id and b.owner_id = auth.uid()));
drop policy if exists nexora_transaction_read on public.nexora_transactions;
create policy nexora_transaction_read on public.nexora_transactions for select to authenticated
using (owner_id = auth.uid() and public.nexora_account_active(auth.uid())
  and (public.is_nexora_super_admin() or exists (
    select 1 from public.merchant_onboarding m where m.user_id = auth.uid() and m.status = 'APPROVED'
  ))
  and exists (select 1 from public.businesses b where b.id = business_id and b.owner_id = auth.uid()));
drop policy if exists nexora_withdrawal_read on public.nexora_withdrawals;
create policy nexora_withdrawal_read on public.nexora_withdrawals for select to authenticated
using (owner_id = auth.uid() and public.nexora_account_active(auth.uid())
  and (public.is_nexora_super_admin() or exists (
    select 1 from public.merchant_onboarding m where m.user_id = auth.uid() and m.status = 'APPROVED'
  ))
  and exists (select 1 from public.businesses b where b.id = business_id and b.owner_id = auth.uid()));

revoke all on function public.nexora_kyc_register_document(text,text,text,text,bigint) from public, anon;
revoke all on function public.nexora_kyc_submit(jsonb) from public, anon;
revoke all on function public.nexora_admin_kyc_list() from public, anon;
revoke all on function public.nexora_admin_review_merchant(uuid,text,text) from public, anon;
revoke all on function public.get_my_access() from public, anon;
revoke all on function public.nexora_assert_workspace() from public, anon, authenticated;
revoke all on function public.nexora_create_merchant_onboarding() from public, anon, authenticated;
grant execute on function public.nexora_kyc_register_document(text,text,text,text,bigint) to authenticated;
grant execute on function public.nexora_kyc_submit(jsonb) to authenticated;
grant execute on function public.nexora_admin_kyc_list() to authenticated;
grant execute on function public.nexora_admin_review_merchant(uuid,text,text) to authenticated;
grant execute on function public.get_my_access() to authenticated;
notify pgrst, 'reload schema';

-- Verificações manuais após executar:
-- select public.is_nexora_super_admin(); -- true somente para a conta autorizada
-- select id,name,public from storage.buckets where id='nexora-kyc'; -- public deve ser false
-- select status,count(*) from public.merchant_onboarding group by status;

-- Operação com adquirentes, regras por merchant e alertas administrativos.
-- As credenciais permanecem criptografadas pela Edge Function; nunca são
-- retornadas por RPC nem gravadas em texto puro nesta tabela.
create table if not exists public.nexora_acquirers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z0-9][a-z0-9_-]{1,49}$'),
  name text not null check (length(trim(name)) between 2 and 120),
  api_base_url text not null check (api_base_url ~ '^https://'),
  webhook_url text,
  environment text not null default 'sandbox' check (environment in ('sandbox','production')),
  payment_methods text[] not null default array['pix']::text[],
  status text not null default 'disabled' check (status in ('enabled','disabled','degraded')),
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.nexora_merchant_provider_connections (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  acquirer_id uuid not null references public.nexora_acquirers(id),
  api_key_ciphertext text not null,
  webhook_secret_ciphertext text,
  webhook_url text,
  status text not null default 'pending' check (status in ('pending','active','disabled','error')),
  last_error text,
  configured_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, acquirer_id)
);

create table if not exists public.nexora_merchant_controls (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  payments_enabled boolean not null default true,
  withdrawals_enabled boolean not null default true,
  withdrawal_mode text not null default 'manual' check (withdrawal_mode in ('manual','instant')),
  max_transfer_amount numeric(14,2) not null default 5000 check (max_transfer_amount > 0),
  daily_transfer_limit numeric(14,2) not null default 20000 check (daily_transfer_limit > 0),
  alert_threshold_amount numeric(14,2) not null default 5000 check (alert_threshold_amount > 0),
  reserve_percentage numeric(5,2) not null default 0 check (reserve_percentage between 0 and 100),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (owner_id, business_id)
);

create table if not exists public.nexora_admin_notifications (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  owner_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  notification_type text not null,
  title text not null,
  message text not null,
  details jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create or replace function public.nexora_audit_provider_configuration()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
  values(coalesce(auth.uid(),new.owner_id),'merchant.provider_configured',new.business_id::text,
    jsonb_build_object('acquirer_id',new.acquirer_id,'status',new.status,
      'api_key_replaced',case when tg_op='INSERT' then true else new.api_key_ciphertext is distinct from old.api_key_ciphertext end,
      'webhook_secret_configured',new.webhook_secret_ciphertext is not null));
  return new;
end;
$$;
drop trigger if exists nexora_audit_provider_configuration on public.nexora_merchant_provider_connections;
create trigger nexora_audit_provider_configuration after insert or update on public.nexora_merchant_provider_connections
for each row execute function public.nexora_audit_provider_configuration();

create or replace function public.nexora_initialize_merchant_controls()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status='APPROVED' then
    insert into public.nexora_merchant_controls(business_id,owner_id)
      select b.id,b.owner_id from public.businesses b where b.owner_id=new.user_id
      on conflict(business_id) do nothing;
  end if;
  return new;
end;
$$;
drop trigger if exists nexora_initialize_controls_after_kyc on public.merchant_onboarding;
create trigger nexora_initialize_controls_after_kyc after insert or update of status on public.merchant_onboarding
for each row execute function public.nexora_initialize_merchant_controls();

create index if not exists nexora_acquirers_status_idx on public.nexora_acquirers(status,name);
create index if not exists nexora_provider_connections_owner_idx on public.nexora_merchant_provider_connections(owner_id,updated_at desc);
create index if not exists nexora_admin_notifications_unread_idx on public.nexora_admin_notifications(read_at,created_at desc);
insert into public.nexora_merchant_controls(business_id,owner_id)
  select b.id,b.owner_id from public.businesses b join public.merchant_onboarding m on m.user_id=b.owner_id and m.status='APPROVED'
  on conflict(business_id) do nothing;
alter table public.nexora_acquirers enable row level security;
alter table public.nexora_merchant_provider_connections enable row level security;
alter table public.nexora_merchant_controls enable row level security;
alter table public.nexora_admin_notifications enable row level security;
revoke all on public.nexora_acquirers,public.nexora_merchant_provider_connections,
  public.nexora_merchant_controls,public.nexora_admin_notifications from anon,authenticated;
grant all on public.nexora_merchant_provider_connections to service_role;

create or replace function public.nexora_get_merchant_setup()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_business uuid := public.nexora_assert_workspace(); v_result jsonb;
begin
  select jsonb_build_object(
    'providers',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'code',a.code,'name',a.name,
      'api_base_url',a.api_base_url,'webhook_url',a.webhook_url,'environment',a.environment,
      'payment_methods',a.payment_methods,'status',a.status,'notes',a.notes)
      order by a.name) from public.nexora_acquirers a where a.status='enabled'),'[]'::jsonb),
    'connection',(select jsonb_build_object('acquirer_id',c.acquirer_id,'acquirer_name',a.name,
      'status',c.status,'webhook_url',c.webhook_url,'api_key_configured',true,
      'webhook_secret_configured',c.webhook_secret_ciphertext is not null,'updated_at',c.updated_at)
      from public.nexora_merchant_provider_connections c join public.nexora_acquirers a on a.id=c.acquirer_id
      where c.business_id=v_business and c.owner_id=auth.uid() order by c.updated_at desc limit 1),
    'controls',(select jsonb_build_object('payments_enabled',m.payments_enabled,'withdrawals_enabled',m.withdrawals_enabled,
      'withdrawal_mode',m.withdrawal_mode,'max_transfer_amount',m.max_transfer_amount,
      'daily_transfer_limit',m.daily_transfer_limit,'alert_threshold_amount',m.alert_threshold_amount,
      'reserve_percentage',m.reserve_percentage)
      from public.nexora_merchant_controls m where m.business_id=v_business and m.owner_id=auth.uid())
  ) into v_result;
  if v_result->'controls' is null then
    insert into public.nexora_merchant_controls(business_id,owner_id) values(v_business,auth.uid()) on conflict(business_id) do nothing;
    v_result := v_result || jsonb_build_object('controls',jsonb_build_object('payments_enabled',true,
      'withdrawals_enabled',true,'withdrawal_mode','manual','max_transfer_amount',5000,
      'daily_transfer_limit',20000,'alert_threshold_amount',5000,'reserve_percentage',0));
  end if;
  return v_result;
end;
$$;

create or replace function public.nexora_set_withdrawal_preference(p_mode text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_business uuid := public.nexora_assert_workspace();
begin
  if p_mode not in ('manual','instant') then raise exception 'Modo de saque inválido.'; end if;
  insert into public.nexora_merchant_controls(business_id,owner_id,withdrawal_mode,updated_by)
  values(v_business,auth.uid(),p_mode,auth.uid())
  on conflict(business_id) do update set withdrawal_mode=excluded.withdrawal_mode,updated_by=auth.uid(),updated_at=now();
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
  values(auth.uid(),'merchant.withdrawal_mode',v_business::text,jsonb_build_object('mode',p_mode));
end;
$$;

-- Substitui a versão de demonstração anterior: valida controles por merchant,
-- idempotência e saldo antes de reservar uma solicitação de saque.
create or replace function public.nexora_request_withdrawal(p_request_id uuid,p_amount numeric,p_destination text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_business uuid := public.nexora_assert_workspace(); v_id uuid; v_control public.nexora_merchant_controls;
begin
  if p_request_id is null or p_amount is null or p_amount<=0 or p_amount<>round(p_amount,2)
    or p_amount>9999999999.99 then raise exception 'Valor de saque inválido.'; end if;
  select id into v_id from public.nexora_transactions where owner_id=auth.uid() and request_id=p_request_id;
  if v_id is not null then return v_id; end if;
  perform 1 from public.businesses where id=v_business for update;
  insert into public.nexora_merchant_controls(business_id,owner_id) values(v_business,auth.uid()) on conflict(business_id) do nothing;
  select * into v_control from public.nexora_merchant_controls where business_id=v_business and owner_id=auth.uid() for update;
  if not v_control.withdrawals_enabled then raise exception 'Saques estão temporariamente bloqueados. Fale com o suporte.'; end if;
  if not (select sandbox from public.nexora_runtime_config where id) then raise exception 'Saque real indisponível até a integração e homologação do adquirente.'; end if;
  if p_amount>public.nexora_balance(v_business) then raise exception 'Saldo de simulação insuficiente.'; end if;
  if nullif(trim(p_destination),'') is null or length(p_destination)>254 then raise exception 'Informe uma chave Pix válida.'; end if;
  insert into public.nexora_transactions(owner_id,business_id,external_id,title,amount,kind,status,source,destination,request_id)
    values(auth.uid(),v_business,'NX-SAQUE-'||upper(substr(replace(p_request_id::text,'-',''),1,12)),
      case when v_control.withdrawal_mode='instant' then 'Solicitação de saque · preferência instantânea (simulação)' else 'Solicitação de saque · aprovação manual' end,
      p_amount,'withdrawal','pending','manual',trim(p_destination),p_request_id) returning id into v_id;
  insert into public.nexora_withdrawals(owner_id,business_id,amount,destination,status,transaction_id)
    values(auth.uid(),v_business,p_amount,trim(p_destination),'pending',v_id);
  return v_id;
end;
$$;

create or replace function public.nexora_admin_acquirers()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_nexora_super_admin() then raise exception 'Acesso restrito ao Painel Nexora Pay.'; end if;
  return coalesce((select jsonb_agg(to_jsonb(a) order by a.name) from public.nexora_acquirers a),'[]'::jsonb);
end;
$$;

create or replace function public.nexora_admin_save_acquirer(
  p_id uuid,p_code text,p_name text,p_api_base_url text,p_webhook_url text,
  p_environment text,p_payment_methods text[],p_status text,p_notes text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not public.is_nexora_super_admin() then raise exception 'Acesso restrito ao Painel Nexora Pay.'; end if;
  if p_code !~ '^[a-z0-9][a-z0-9_-]{1,49}$' or length(trim(coalesce(p_name,''))) not between 2 and 120
    or p_api_base_url !~ '^https://' or p_environment not in ('sandbox','production')
    or p_status not in ('enabled','disabled','degraded') then raise exception 'Dados do adquirente inválidos.'; end if;
  if coalesce(array_length(p_payment_methods,1),0)=0 or exists(select 1 from unnest(p_payment_methods) m where m not in ('pix','card','boleto')) then
    raise exception 'Selecione ao menos um meio de pagamento válido.'; end if;
  if p_webhook_url is not null and p_webhook_url<>'' and p_webhook_url !~ '^https://' then raise exception 'A URL do webhook precisa usar HTTPS.'; end if;
  if p_id is null then
    insert into public.nexora_acquirers(code,name,api_base_url,webhook_url,environment,payment_methods,status,notes)
      values(lower(trim(p_code)),trim(p_name),trim(p_api_base_url),nullif(trim(p_webhook_url),''),p_environment,p_payment_methods,p_status,left(coalesce(p_notes,''),1000))
      returning id into v_id;
  else
    update public.nexora_acquirers set code=lower(trim(p_code)),name=trim(p_name),api_base_url=trim(p_api_base_url),
      webhook_url=nullif(trim(p_webhook_url),''),environment=p_environment,payment_methods=p_payment_methods,
      status=p_status,notes=left(coalesce(p_notes,''),1000),updated_at=now() where id=p_id returning id into v_id;
    if v_id is null then raise exception 'Adquirente não encontrado.'; end if;
  end if;
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(auth.uid(),'acquirer.saved',v_id::text,jsonb_build_object('code',p_code,'name',p_name,'status',p_status));
  return v_id;
end;
$$;

create or replace function public.nexora_admin_provider_connections()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_nexora_super_admin() then raise exception 'Acesso restrito ao Painel Nexora Pay.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('owner_id',c.owner_id,'business_id',c.business_id,
    'business_name',b.name,'email',u.email,'acquirer_id',c.acquirer_id,'acquirer_name',a.name,
    'status',c.status,'webhook_url',c.webhook_url,'api_key_configured',true,
    'webhook_secret_configured',c.webhook_secret_ciphertext is not null,'updated_at',c.updated_at)
    order by c.updated_at desc) from public.nexora_merchant_provider_connections c
    join public.businesses b on b.id=c.business_id and b.owner_id=c.owner_id
    join auth.users u on u.id=c.owner_id join public.nexora_acquirers a on a.id=c.acquirer_id),'[]'::jsonb);
end;
$$;

create or replace function public.nexora_admin_set_provider_status(p_owner_id uuid,p_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_business uuid; v_old text;
begin
  if not public.is_nexora_super_admin() then raise exception 'Acesso restrito ao Painel Nexora Pay.'; end if;
  if p_status not in ('pending','disabled','error') then raise exception 'Status administrativo inválido.'; end if;
  select business_id,status into v_business,v_old from public.nexora_merchant_provider_connections
    where owner_id=p_owner_id order by updated_at desc limit 1 for update;
  if v_business is null then raise exception 'Conexão de adquirente não encontrada.'; end if;
  update public.nexora_merchant_provider_connections set status=p_status,updated_at=now()
    where business_id=v_business and owner_id=p_owner_id;
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(auth.uid(),'merchant.provider_status',p_owner_id::text,jsonb_build_object('from',v_old,'to',p_status));
end;
$$;

create or replace function public.nexora_admin_merchant_controls()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_nexora_super_admin() then raise exception 'Acesso restrito ao Painel Nexora Pay.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('owner_id',b.owner_id,'business_id',b.id,
    'business_name',b.name,'email',u.email,'payments_enabled',coalesce(m.payments_enabled,true),
    'withdrawals_enabled',coalesce(m.withdrawals_enabled,true),'withdrawal_mode',coalesce(m.withdrawal_mode,'manual'),
    'max_transfer_amount',coalesce(m.max_transfer_amount,5000),'daily_transfer_limit',coalesce(m.daily_transfer_limit,20000),
    'alert_threshold_amount',coalesce(m.alert_threshold_amount,5000),'reserve_percentage',coalesce(m.reserve_percentage,0),
    'updated_at',m.updated_at) order by b.name)
    from public.businesses b join public.merchant_onboarding k on k.user_id=b.owner_id and k.status='APPROVED'
    join auth.users u on u.id=b.owner_id left join public.nexora_merchant_controls m on m.business_id=b.id and m.owner_id=b.owner_id),'[]'::jsonb);
end;
$$;

create or replace function public.nexora_admin_set_merchant_controls(
  p_owner_id uuid,p_payments_enabled boolean,p_withdrawals_enabled boolean,p_withdrawal_mode text,
  p_max_transfer_amount numeric,p_daily_transfer_limit numeric,p_alert_threshold_amount numeric,p_reserve_percentage numeric
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_business uuid; v_old jsonb; v_new jsonb;
begin
  if not public.is_nexora_super_admin() then raise exception 'Acesso restrito ao Painel Nexora Pay.'; end if;
  if p_withdrawal_mode not in ('manual','instant') or p_max_transfer_amount<=0 or p_daily_transfer_limit<=0
    or p_alert_threshold_amount<=0 or p_reserve_percentage<0 or p_reserve_percentage>100 then raise exception 'Limites ou modo de saque inválidos.'; end if;
  select id into v_business from public.businesses where owner_id=p_owner_id order by id limit 1;
  if v_business is null then raise exception 'Workspace do merchant não encontrado.'; end if;
  select to_jsonb(m) into v_old from public.nexora_merchant_controls m where business_id=v_business;
  insert into public.nexora_merchant_controls(business_id,owner_id,payments_enabled,withdrawals_enabled,withdrawal_mode,
    max_transfer_amount,daily_transfer_limit,alert_threshold_amount,reserve_percentage,updated_by)
  values(v_business,p_owner_id,p_payments_enabled,p_withdrawals_enabled,p_withdrawal_mode,
    p_max_transfer_amount,p_daily_transfer_limit,p_alert_threshold_amount,p_reserve_percentage,auth.uid())
  on conflict(business_id) do update set payments_enabled=excluded.payments_enabled,withdrawals_enabled=excluded.withdrawals_enabled,
    withdrawal_mode=excluded.withdrawal_mode,max_transfer_amount=excluded.max_transfer_amount,
    daily_transfer_limit=excluded.daily_transfer_limit,alert_threshold_amount=excluded.alert_threshold_amount,
    reserve_percentage=excluded.reserve_percentage,updated_by=auth.uid(),updated_at=now();
  select to_jsonb(m) into v_new from public.nexora_merchant_controls m where business_id=v_business;
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
  values(auth.uid(),'merchant.controls_updated',p_owner_id::text,jsonb_build_object('before',v_old,'after',v_new));
end;
$$;

create or replace function public.nexora_admin_notifications(p_unread_only boolean default true)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_nexora_super_admin() then raise exception 'Acesso restrito ao Painel Nexora Pay.'; end if;
  return coalesce((select jsonb_agg(to_jsonb(n) order by n.created_at desc) from (
    select n.*,u.email,b.name as business_name from public.nexora_admin_notifications n
    join auth.users u on u.id=n.owner_id join public.businesses b on b.id=n.business_id
    where not p_unread_only or n.read_at is null order by n.created_at desc limit 100
  ) n),'[]'::jsonb);
end;
$$;

create or replace function public.nexora_admin_mark_notification_read(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_nexora_super_admin() then raise exception 'Acesso restrito ao Painel Nexora Pay.'; end if;
  update public.nexora_admin_notifications set read_at=coalesce(read_at,now()) where id=p_id;
  if not found then raise exception 'Notificação não encontrada.'; end if;
end;
$$;

create or replace function public.nexora_alert_transfer_threshold()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_control public.nexora_merchant_controls; v_today numeric(14,2); v_key text;
begin
  select * into v_control from public.nexora_merchant_controls where business_id=new.business_id and owner_id=new.owner_id;
  if not found then return new; end if;
  select coalesce(sum(w.amount),0) into v_today from public.nexora_withdrawals w
    where w.business_id=new.business_id and w.owner_id=new.owner_id
      and w.status<>'cancelled' and w.created_at >= ((now() at time zone 'UTC')::date::timestamp at time zone 'UTC');
  if new.amount>=v_control.alert_threshold_amount or new.amount>v_control.max_transfer_amount
     or v_today+new.amount>v_control.daily_transfer_limit then
    v_key := 'transfer-limit:'||new.owner_id::text||':'||(now() at time zone 'UTC')::date::text;
    insert into public.nexora_admin_notifications(event_key,owner_id,business_id,notification_type,title,message,details)
    values(v_key,new.owner_id,new.business_id,'transfer_limit','Limite de transferências atingido',
      'Uma solicitação de saque atingiu o alerta configurado ou ultrapassou o limite diário.',
      jsonb_build_object('requested_amount',new.amount,'daily_total_before',v_today,'daily_limit',v_control.daily_transfer_limit,
        'alert_threshold',v_control.alert_threshold_amount,'withdrawal_id',new.id)) on conflict(event_key) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists nexora_withdrawal_transfer_alert on public.nexora_withdrawals;
create trigger nexora_withdrawal_transfer_alert after insert on public.nexora_withdrawals
for each row execute function public.nexora_alert_transfer_threshold();

create or replace function public.nexora_enforce_merchant_payment_controls()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_control public.nexora_merchant_controls;
begin
  select * into v_control from public.nexora_merchant_controls where business_id=new.business_id and owner_id=new.owner_id;
  if not found then return new; end if;
  if new.kind='withdrawal' and not v_control.withdrawals_enabled then raise exception 'Saques bloqueados pelo Painel Nexora Pay.'; end if;
  if new.kind<>'withdrawal' and not v_control.payments_enabled then raise exception 'Pagamentos bloqueados pelo Painel Nexora Pay.'; end if;
  return new;
end;
$$;
drop trigger if exists nexora_enforce_payment_controls on public.nexora_transactions;
create trigger nexora_enforce_payment_controls before insert on public.nexora_transactions
for each row execute function public.nexora_enforce_merchant_payment_controls();

revoke all on function public.nexora_get_merchant_setup() from public,anon;
revoke all on function public.nexora_set_withdrawal_preference(text) from public,anon;
revoke all on function public.nexora_request_withdrawal(uuid,numeric,text) from public,anon;
revoke all on function public.nexora_admin_acquirers() from public,anon;
revoke all on function public.nexora_admin_save_acquirer(uuid,text,text,text,text,text,text[],text,text) from public,anon;
revoke all on function public.nexora_admin_provider_connections() from public,anon;
revoke all on function public.nexora_admin_set_provider_status(uuid,text) from public,anon;
revoke all on function public.nexora_admin_merchant_controls() from public,anon;
revoke all on function public.nexora_admin_set_merchant_controls(uuid,boolean,boolean,text,numeric,numeric,numeric,numeric) from public,anon;
revoke all on function public.nexora_admin_notifications(boolean) from public,anon;
revoke all on function public.nexora_admin_mark_notification_read(uuid) from public,anon;
revoke all on function public.nexora_alert_transfer_threshold() from public,anon,authenticated;
revoke all on function public.nexora_enforce_merchant_payment_controls() from public,anon,authenticated;
revoke all on function public.nexora_initialize_merchant_controls() from public,anon,authenticated;
revoke all on function public.nexora_audit_provider_configuration() from public,anon,authenticated;
grant execute on function public.nexora_get_merchant_setup() to authenticated;
grant execute on function public.nexora_set_withdrawal_preference(text) to authenticated;
grant execute on function public.nexora_request_withdrawal(uuid,numeric,text) to authenticated;
grant execute on function public.nexora_admin_acquirers() to authenticated;
grant execute on function public.nexora_admin_save_acquirer(uuid,text,text,text,text,text,text[],text,text) to authenticated;
grant execute on function public.nexora_admin_provider_connections() to authenticated;
grant execute on function public.nexora_admin_set_provider_status(uuid,text) to authenticated;
grant execute on function public.nexora_admin_merchant_controls() to authenticated;
grant execute on function public.nexora_admin_set_merchant_controls(uuid,boolean,boolean,text,numeric,numeric,numeric,numeric) to authenticated;
grant execute on function public.nexora_admin_notifications(boolean) to authenticated;
grant execute on function public.nexora_admin_mark_notification_read(uuid) to authenticated;

-- Estado inicial de lançamento: conta oficial, sem dados ou ações financeiras fictícias.
-- A disponibilidade só poderá ser ativada após adapter, webhooks e homologação do adquirente.
update public.nexora_runtime_config
  set sandbox = false, gateway_ready = false
  where id = true;

-- O backoffice só considera valores e saques originados pela integração real.
create or replace function public.nexora_admin_snapshot(p_query text default '',p_page integer default 0,p_limit integer default 25,
  p_customer_query text default '',p_customer_page integer default 0)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_accounts jsonb; v_customers jsonb; v_count integer; v_customer_count integer; v_limit integer := least(greatest(p_limit,1),100);
begin
  if not public.is_nexora_super_admin() then raise exception 'Acesso restrito ao Painel Nexora Pay.'; end if;
  select count(*) into v_count from auth.users u left join public.user_settings s on s.user_id=u.id
    where concat_ws(' ',u.email,s.profile_name,u.raw_user_meta_data->>'full_name') ilike '%'||left(p_query,160)||'%';
  select coalesce(jsonb_agg(to_jsonb(a)),'[]') into v_accounts from (
    select u.id as user_id,u.email,coalesce(nullif(s.profile_name,''),nullif(u.raw_user_meta_data->>'full_name',''),split_part(u.email,'@',1)) as full_name,
      u.created_at,u.last_sign_in_at,coalesce(ac.status,'active') as status,ac.reason,
      (select jsonb_agg(jsonb_build_object('id',b.id,'name',b.name)) from public.businesses b where b.owner_id=u.id) as workspaces,
      (select exists(select 1 from public.nexora_admins na where lower(na.email)=lower(u.email))) as is_admin
    from auth.users u left join public.user_settings s on s.user_id=u.id left join public.nexora_account_controls ac on ac.user_id=u.id
    where concat_ws(' ',u.email,s.profile_name,u.raw_user_meta_data->>'full_name') ilike '%'||left(p_query,160)||'%'
    order by u.created_at desc,u.id limit v_limit offset greatest(p_page,0)*v_limit
  ) a;
  select count(*) into v_customer_count from public.nexora_customers c join public.businesses b on b.id=c.business_id and b.owner_id=c.owner_id
    where concat_ws(' ',c.name,c.email,b.name) ilike '%'||left(p_customer_query,160)||'%';
  select coalesce(jsonb_agg(to_jsonb(c)),'[]') into v_customers from (
    select c.id,c.name,c.email,c.owner_id,c.business_id,b.name as business_name,
      coalesce((select sum(t.amount) from public.nexora_transactions t where t.customer_id=c.id and t.owner_id=c.owner_id
        and t.business_id=c.business_id and t.source='gateway' and t.kind<>'withdrawal' and t.status='paid'),0) as total,
      coalesce((select max(coalesce(t.paid_at,t.created_at)) from public.nexora_transactions t where t.customer_id=c.id
        and t.owner_id=c.owner_id and t.business_id=c.business_id and t.source='gateway'),c.created_at) as last_activity
    from public.nexora_customers c join public.businesses b on b.id=c.business_id and b.owner_id=c.owner_id
    where concat_ws(' ',c.name,c.email,b.name) ilike '%'||left(p_customer_query,160)||'%'
    order by c.created_at desc,c.id limit v_limit offset greatest(p_customer_page,0)*v_limit
  ) c;
  return jsonb_build_object('accounts',v_accounts,'account_count',v_count,'customers',v_customers,'customer_count',v_customer_count,
    'stats',jsonb_build_object('accounts',(select count(*) from auth.users),
      'active_accounts',(select count(*) from auth.users u where public.nexora_account_active(u.id)),
      'suspended_accounts',(select count(*) from public.nexora_account_controls where status='suspended'),
      'workspaces',(select count(*) from public.businesses)),
    'withdrawals',(select coalesce(jsonb_agg(to_jsonb(w)),'[]') from (
      select w.*,b.name as business_name,u.email from public.nexora_withdrawals w
      join public.businesses b on b.id=w.business_id and b.owner_id=w.owner_id
      join auth.users u on u.id=w.owner_id join public.nexora_transactions t on t.id=w.transaction_id
      where t.source='gateway' order by w.created_at desc limit 100) w),
    'audit',(select coalesce(jsonb_agg(to_jsonb(l)),'[]') from (select id,action,target_id,created_at from public.nexora_audit_log order by id desc limit 30) l),
    'site',public.nexora_public_site_settings(),'sandbox',(select sandbox from public.nexora_runtime_config where id),
    'gateway_ready',(select gateway_ready from public.nexora_runtime_config where id));
end;
$$;

create or replace function public.nexora_admin_transactions(p_user_id uuid,p_customer_id uuid default null,p_page integer default 0)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_rows jsonb; v_count integer;
begin
  if not public.is_nexora_super_admin() then raise exception 'Acesso restrito ao Painel Nexora Pay.'; end if;
  select count(*) into v_count from public.nexora_transactions t join public.businesses b on b.id=t.business_id and b.owner_id=t.owner_id
    where t.owner_id=p_user_id and t.source='gateway' and (p_customer_id is null or t.customer_id=p_customer_id);
  select coalesce(jsonb_agg(to_jsonb(t)),'[]') into v_rows from (
    select t.*,b.name as business_name from public.nexora_transactions t join public.businesses b on b.id=t.business_id and b.owner_id=t.owner_id
    where t.owner_id=p_user_id and t.source='gateway' and (p_customer_id is null or t.customer_id=p_customer_id)
    order by t.created_at desc,t.id limit 50 offset greatest(p_page,0)*50
  ) t;
  return jsonb_build_object('rows',v_rows,'count',v_count);
end;
$$;
grant execute on function public.nexora_admin_snapshot(text,integer,integer,text,integer) to authenticated;
grant execute on function public.nexora_admin_transactions(uuid,uuid,integer) to authenticated;
notify pgrst, 'reload schema';
commit;

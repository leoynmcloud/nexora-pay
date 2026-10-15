-- Exige MFA somente no envio de documentos/cadastro KYC; login e navegação de clientes não exigem aal2.
-- Execute no SQL Editor do Supabase depois da migration nexora-onboarding-kyc.sql.
begin;

do $$ begin
  if to_regclass('public.merchant_onboarding') is null
     or to_regclass('public.merchant_kyc_documents') is null then
    raise exception 'Execute primeiro nexora-onboarding-kyc.sql.';
  end if;
  if to_regclass('public.nexora_admins') is null then
    raise exception 'Execute primeiro nexora-super-admin.sql.';
  end if;
end $$;

create or replace function public.is_nexora_super_admin_account()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.nexora_admins a
    where lower(trim(a.email)) = lower(trim(auth.jwt() ->> 'email'))
      and a.role = 'super_admin'
  );
$$;
revoke all on function public.is_nexora_super_admin_account() from public, anon;
grant execute on function public.is_nexora_super_admin_account() to authenticated;

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

revoke all on function public.nexora_kyc_register_document(text,text,text,text,bigint) from public, anon;
revoke all on function public.nexora_kyc_submit(jsonb) from public, anon;
grant execute on function public.nexora_kyc_register_document(text,text,text,text,bigint) to authenticated;
grant execute on function public.nexora_kyc_submit(jsonb) to authenticated;
notify pgrst, 'reload schema';
commit;

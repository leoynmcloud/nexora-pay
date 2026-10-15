-- KYC/KYB profile completion, person-scoped private documents and auditable manual screening.
-- Prerequisites: nexora-onboarding-kyc.sql, nexora-kyc-mfa-submit.sql,
-- nexora-cnpj-alphanumeric.sql. This migration does not connect to screening vendors.
begin;

do $$ begin
  if to_regclass('public.merchant_onboarding') is null
     or to_regclass('public.merchant_kyc_documents') is null
     or to_regclass('public.merchant_kyc_reviews') is null
     or to_regclass('public.nexora_audit_log') is null
     or to_regprocedure('public.is_nexora_super_admin()') is null
     or to_regprocedure('public.nexora_valid_cpf(text)') is null
     or to_regprocedure('public.nexora_valid_cnpj(text)') is null then
    raise exception 'Apply the KYC base, MFA submit and Brazilian document migrations first.';
  end if;
end $$;

alter table public.merchant_kyc_documents
  add column if not exists subject_key text not null default 'company';
alter table public.merchant_kyc_documents
  drop constraint if exists merchant_kyc_documents_user_id_document_type_key;
update public.merchant_kyc_documents set subject_key='representative'
  where document_type in ('representative_id_front','representative_id_back','additional_document') and subject_key='company';
alter table public.merchant_kyc_documents
  drop constraint if exists merchant_kyc_documents_document_type_check;
alter table public.merchant_kyc_documents
  drop constraint if exists merchant_kyc_documents_subject_key_check;
alter table public.merchant_kyc_documents
  add constraint merchant_kyc_documents_document_type_check check (document_type in (
    'cnpj_proof','company_articles','representative_id_front','representative_id_back',
    'company_address_proof','bank_proof','additional_document','power_of_attorney',
    'activity_license','financial_document','owner_id_front','owner_id_back','owner_address_proof'
  ));
alter table public.merchant_kyc_documents
  add constraint merchant_kyc_documents_subject_key_check
  check (subject_key ~ '^(company|representative|owner:[0-9a-fA-F-]{36})$');
create unique index if not exists merchant_kyc_documents_subject_unique
  on public.merchant_kyc_documents(user_id,document_type,subject_key);

create table if not exists public.merchant_kyc_screenings (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  subject_key text not null check (subject_key ~ '^(company|representative|owner:[0-9a-fA-F-]{36})$'),
  pep_result text not null check (pep_result in ('CLEAR','POTENTIAL_MATCH','CONFIRMED_MATCH','UNRESOLVED')),
  sanctions_result text not null check (sanctions_result in ('CLEAR','POTENTIAL_MATCH','CONFIRMED_MATCH','UNRESOLVED')),
  source_name text not null check (length(trim(source_name)) between 2 and 160),
  reference_id text,
  notes text not null check (length(trim(notes)) between 5 and 1000),
  reviewer_id uuid not null references auth.users(id) on delete restrict,
  screened_at timestamptz not null default now(),
  unique(batch_id,subject_key)
);
alter table public.merchant_onboarding add column if not exists current_screening_batch_id uuid;
create index if not exists merchant_kyc_screenings_latest_idx
  on public.merchant_kyc_screenings(user_id,screened_at desc,batch_id);
alter table public.merchant_kyc_screenings enable row level security;
revoke all on public.merchant_kyc_screenings from public,anon,authenticated;
create or replace function public.nexora_kyc_screening_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'KYC screening records cannot be updated.'; end;
$$;
revoke all on function public.nexora_kyc_screening_immutable() from public,anon,authenticated;
drop trigger if exists nexora_kyc_screening_no_mutation on public.merchant_kyc_screenings;
create trigger nexora_kyc_screening_no_mutation before update on public.merchant_kyc_screenings
for each row execute function public.nexora_kyc_screening_immutable();

-- Preserve the previous RPC signature for older clients, but route it through the subject-aware writer.
create or replace function public.nexora_kyc_register_document_v2(
  p_document_type text,p_subject_key text,p_storage_path text,p_file_name text,
  p_content_type text,p_size_bytes bigint
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  if auth.uid() is null then raise exception 'Faça login para enviar documentos.'; end if;
  if coalesce(auth.jwt()->>'aal','aal1') <> 'aal2' then raise exception 'Confirme a verificação em duas etapas.'; end if;
  select status into v_status from public.merchant_onboarding where user_id=auth.uid() for update;
  if not found or v_status not in ('DRAFT','PENDING_SUBMISSION','PENDING_DOCUMENTS','REJECTED') then
    raise exception 'O cadastro não está aberto para alteração.';
  end if;
  if p_document_type not in ('cnpj_proof','company_articles','representative_id_front','representative_id_back',
      'company_address_proof','bank_proof','additional_document','power_of_attorney','activity_license',
      'financial_document','owner_id_front','owner_id_back','owner_address_proof') then
    raise exception 'Tipo de documento inválido.';
  end if;
  if p_subject_key is null or p_subject_key !~ '^(company|representative|owner:[0-9a-fA-F-]{36})$' then
    raise exception 'Pessoa relacionada ao documento inválida.';
  end if;
  if (p_document_type in ('owner_id_front','owner_id_back','owner_address_proof')) <> (p_subject_key like 'owner:%') then
    raise exception 'O documento não corresponde à pessoa selecionada.';
  end if;
  if p_document_type in ('cnpj_proof','company_articles','company_address_proof','bank_proof','activity_license','financial_document')
     and p_subject_key <> 'company' then raise exception 'Documento deve estar vinculado à empresa.'; end if;
  if p_document_type in ('representative_id_front','representative_id_back','additional_document','power_of_attorney')
     and p_subject_key <> 'representative' then raise exception 'Documento deve estar vinculado ao representante.'; end if;
  if p_storage_path is null or left(p_storage_path,length(auth.uid()::text)+1) <> auth.uid()::text||'/'
     or (storage.foldername(p_storage_path))[2] <> p_document_type then raise exception 'Caminho de documento inválido.'; end if;
  if p_content_type not in ('image/jpeg','image/png','image/webp','application/pdf') or p_size_bytes < 1 or p_size_bytes > 10485760 then
    raise exception 'Arquivo não permitido. Use PDF, JPG, PNG ou WebP de até 10 MB.';
  end if;
  if not exists(select 1 from storage.objects o where o.bucket_id='nexora-kyc' and o.name=p_storage_path) then
    raise exception 'O arquivo não foi encontrado no armazenamento privado.';
  end if;
  insert into public.merchant_kyc_documents(user_id,document_type,subject_key,storage_path,file_name,content_type,size_bytes)
  values(auth.uid(),p_document_type,p_subject_key,p_storage_path,left(coalesce(p_file_name,'documento'),255),p_content_type,p_size_bytes)
  on conflict(user_id,document_type,subject_key) do update set
    storage_path=excluded.storage_path,file_name=excluded.file_name,content_type=excluded.content_type,
    size_bytes=excluded.size_bytes,uploaded_at=now();
end;
$$;

create or replace function public.nexora_kyc_register_document(
  p_document_type text,p_storage_path text,p_file_name text,p_content_type text,p_size_bytes bigint
)
returns void language sql security definer set search_path = '' as $$
  select public.nexora_kyc_register_document_v2(p_document_type,
    case when p_document_type in ('representative_id_front','representative_id_back','additional_document','power_of_attorney')
      then 'representative' else 'company' end,
    p_storage_path,p_file_name,p_content_type,p_size_bytes)
$$;

-- Full profile validation remains server-side; the frontend is never the source of truth.
create or replace function public.nexora_kyc_submit(p_data jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_status text; v_missing text[]; v_document text; v_type text; v_owner jsonb;
  v_owner_id text; v_mix numeric; v_equity numeric;
begin
  if auth.uid() is null then raise exception 'Faça login para enviar o cadastro.'; end if;
  if coalesce(auth.jwt()->>'aal','aal1') <> 'aal2' then raise exception 'Confirme a verificação em duas etapas antes de enviar o cadastro.'; end if;
  if jsonb_typeof(p_data) is distinct from 'object' or pg_column_size(p_data)>65536
     or jsonb_typeof(p_data->'company') is distinct from 'object' or jsonb_typeof(p_data->'representative') is distinct from 'object'
     or jsonb_typeof(coalesce(p_data->'owners','[]'::jsonb)) is distinct from 'array' then raise exception 'Dados cadastrais inválidos.'; end if;
  if jsonb_array_length(coalesce(p_data->'owners','[]'::jsonb))>50 then raise exception 'Limite de 50 pessoas relacionadas excedido.'; end if;
  if coalesce(p_data->>'privacy_consent','false')<>'true' or coalesce(p_data->>'privacy_notice_version','')<>'2026-10-12-kyb-v1' then
    raise exception 'Leia e confirme a versão atual do aviso de privacidade.';
  end if;
  v_type:=coalesce(p_data #>> '{company,account_type}','');
  v_document:=public.nexora_normalize_brazilian_document(p_data #>> '{company,document_number}');
  if v_type='company' then
    if coalesce(p_data #>> '{company,document_type}','')<>'cnpj' or not public.nexora_valid_cnpj(v_document) then raise exception 'Informe um CNPJ válido.'; end if;
    p_data:=jsonb_set(jsonb_set(p_data,'{company,document_number}',to_jsonb(v_document),true),'{company,cnpj}',to_jsonb(v_document),true);
  elsif v_type='individual' then
    if coalesce(p_data #>> '{company,document_type}','')<>'cpf' or not public.nexora_valid_cpf(v_document) then raise exception 'Informe um CPF válido.'; end if;
    p_data:=jsonb_set(jsonb_set(p_data,'{company,document_number}',to_jsonb(v_document),true),'{company,cnpj}',to_jsonb(v_document),true);
    p_data:=jsonb_set(p_data,'{representative,cpf}',to_jsonb(v_document),true);
  else raise exception 'Tipo de cadastro inválido.'; end if;
  if coalesce(p_data #>> '{company,legal_name}','')='' or coalesce(p_data #>> '{company,phone}','')=''
     or coalesce(p_data #>> '{company,email}','') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or coalesce(p_data #>> '{representative,full_name}','')='' then
    raise exception 'Preencha nome, e-mail, celular e representante.';
  end if;
  if exists(select 1 from unnest(array['company.postal_code','company.address_street','company.address_extra',
      'company.address_neighborhood','company.address_city','company.address_state','company.address_country']) f(path)
      where coalesce(p_data #>> string_to_array(f.path,'.'),'')='') then raise exception 'Complete o endereço da operação.'; end if;
  if v_type='company' then
    if exists(select 1 from unnest(array['company.trade_name','company.legal_form','company.opened_at','company.primary_cnae',
        'company.activity_description','company.monthly_revenue_estimate','company.expected_tpv_monthly','company.average_ticket',
        'company.expected_transactions','company.operating_regions','company.source_of_funds','settlement.bank_name',
        'settlement.branch','settlement.account_number','settlement.account_type','settlement.holder_document']) f(path)
        where coalesce(p_data #>> string_to_array(f.path,'.'),'')='') then raise exception 'Complete o perfil empresarial, a previsão operacional e a conta de liquidação.'; end if;
    if coalesce(p_data #>> '{company.opened_at}','') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Data de abertura inválida.'; end if;
    if coalesce(p_data #>> '{company.monthly_revenue_estimate}','') !~ '^\d+(\.\d{1,2})?$'
       or coalesce(p_data #>> '{company.expected_tpv_monthly}','') !~ '^\d+(\.\d{1,2})?$'
       or coalesce(p_data #>> '{company.average_ticket}','') !~ '^\d+(\.\d{1,2})?$'
       or coalesce(p_data #>> '{company.expected_transactions}','') !~ '^\d+$' then raise exception 'Valores de faturamento e volume inválidos.'; end if;
    if exists(select 1 from unnest(array['company.payment_mix.pix','company.payment_mix.card','company.payment_mix.boleto']) f(path)
        where coalesce(p_data #>> string_to_array(f.path,'.'),'') !~ '^\d{1,3}(\.\d{1,2})?$') then raise exception 'Cada percentual do mix deve estar entre 0 e 100.'; end if;
    if exists(select 1 from unnest(array['company.payment_mix.pix','company.payment_mix.card','company.payment_mix.boleto']) f(path)
        where (p_data #>> string_to_array(f.path,'.'))::numeric not between 0 and 100) then raise exception 'Cada percentual do mix deve estar entre 0 e 100.'; end if;
    v_mix:=coalesce((p_data #>> '{company,payment_mix,pix}')::numeric,0)+coalesce((p_data #>> '{company,payment_mix,card}')::numeric,0)+coalesce((p_data #>> '{company,payment_mix,boleto}')::numeric,0);
    if v_mix<>100 then raise exception 'O mix de pagamentos deve totalizar 100%%.'; end if;
    if jsonb_array_length(coalesce(p_data->'owners','[]'::jsonb))=0 then raise exception 'Informe os sócios, administradores e beneficiários finais.'; end if;
    if not exists(select 1 from jsonb_array_elements(p_data->'owners') x where coalesce((x->>'legal_representative')::boolean,false))
       or not exists(select 1 from jsonb_array_elements(p_data->'owners') x where coalesce((x->>'beneficial_owner')::boolean,false)) then
      raise exception 'Identifique ao menos um representante legal e um beneficiário final.';
    end if;
    v_equity:=0;
    for v_owner in select value from jsonb_array_elements(p_data->'owners') loop
      v_owner_id:=coalesce(v_owner->>'id','');
      if v_owner_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or coalesce(v_owner->>'full_name','')='' or not public.nexora_valid_cpf(v_owner->>'cpf')
         or coalesce(v_owner->>'birth_date','') !~ '^\d{4}-\d{2}-\d{2}$'
         or coalesce(v_owner->>'nationality','')='' or coalesce(v_owner->>'phone','')=''
         or coalesce(v_owner->>'email','') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
         or coalesce(v_owner->>'role','')='' or coalesce(v_owner->>'address','')=''
         or jsonb_typeof(v_owner->'legal_representative') is distinct from 'boolean'
         or jsonb_typeof(v_owner->'beneficial_owner') is distinct from 'boolean'
         or jsonb_typeof(v_owner->'pep_declared') is distinct from 'boolean' then
        raise exception 'Dados pessoais de sócio/representante incompletos ou inválidos.';
      end if;
      if coalesce(v_owner->>'equity_percentage','') !~ '^\d+(\.\d{1,2})?$' then raise exception 'Participação societária inválida.'; end if;
      v_equity:=v_equity+(v_owner->>'equity_percentage')::numeric;
      if not exists(select 1 from public.merchant_kyc_documents d where d.user_id=auth.uid() and d.subject_key='owner:'||v_owner_id and d.document_type='owner_id_front')
         or not exists(select 1 from public.merchant_kyc_documents d where d.user_id=auth.uid() and d.subject_key='owner:'||v_owner_id and d.document_type='owner_id_back') then
        raise exception 'Envie frente e verso do documento de cada sócio ou beneficiário.';
      end if;
    end loop;
    if v_equity>100.01 then raise exception 'A soma das participações societárias não pode exceder 100%%.'; end if;
  else
    if coalesce(p_data #>> '{representative,birth_date}','') !~ '^\d{4}-\d{2}-\d{2}$'
       or coalesce(p_data #>> '{representative,nationality}','')='' then raise exception 'Informe nascimento e nacionalidade do titular.'; end if;
  end if;
  select status into v_status from public.merchant_onboarding where user_id=auth.uid() for update;
  if not found or v_status not in ('DRAFT','PENDING_SUBMISSION','PENDING_DOCUMENTS','REJECTED') then raise exception 'Cadastro indisponível para alteração.'; end if;
  select array_agg(req.document_type) into v_missing
    from (values ('representative_id_front'),('representative_id_back'),('additional_document')) req(document_type)
    where not exists(select 1 from public.merchant_kyc_documents d where d.user_id=auth.uid() and d.document_type=req.document_type and d.subject_key='representative');
  if coalesce(array_length(v_missing,1),0)>0 then raise exception 'Documentos obrigatórios do representante ausentes: %',array_to_string(v_missing,', '); end if;
  if v_type='company' and exists(select 1 from (values ('cnpj_proof'),('company_articles'),('company_address_proof'),('bank_proof')) req(document_type)
      where not exists(select 1 from public.merchant_kyc_documents d where d.user_id=auth.uid() and d.document_type=req.document_type and d.subject_key='company')) then
    raise exception 'Comprovante CNPJ, contrato social, endereço empresarial e comprovante bancário são obrigatórios.';
  end if;
  update public.merchant_onboarding set data=p_data,status='SUBMITTED',reason_code=null,reason_description=null,current_screening_batch_id=null,
    consented_at=now(),privacy_notice_version='2026-10-12-kyb-v1',submitted_at=now(),reviewed_by=null,reviewed_at=null,updated_at=now()
    where user_id=auth.uid();
  insert into public.merchant_kyc_reviews(user_id,reviewer_id,from_status,to_status,reason)
    values(auth.uid(),auth.uid(),v_status,'SUBMITTED','Cliente enviou o cadastro KYC/KYB para análise.');
  return jsonb_build_object('status','SUBMITTED');
end;
$$;

create or replace function public.nexora_admin_record_kyc_screening(
  p_user_id uuid,p_results jsonb,p_source_name text,p_reference_id text,p_notes text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_batch uuid:=gen_random_uuid(); v_item jsonb; v_expected integer; v_inserted integer:=0;
begin
  if not public.is_nexora_super_admin() then raise exception 'Acesso restrito ao Super Admin.'; end if;
  if coalesce(auth.jwt()->>'aal','aal1')<>'aal2' then raise exception 'Confirme MFA para registrar a diligência.'; end if;
  if jsonb_typeof(p_results) is distinct from 'array' or length(trim(coalesce(p_source_name,'')))<2 or length(trim(coalesce(p_notes,'')))<5 then
    raise exception 'Informe fonte consultada, resultado de cada pessoa e observação da diligência.';
  end if;
  if not exists(select 1 from public.merchant_onboarding where user_id=p_user_id and status in ('SUBMITTED','UNDER_REVIEW','MANUAL_REVIEW','PENDING_DOCUMENTS','REJECTED')) then
    raise exception 'Cadastro não está disponível para diligência.';
  end if;
  perform 1 from public.merchant_onboarding where user_id=p_user_id for update;
  if not found then raise exception 'Cadastro não encontrado.'; end if;
  select 2 + case when coalesce(data #>> '{company,account_type}','')='company' then jsonb_array_length(coalesce(data->'owners','[]'::jsonb)) else 0 end
    into v_expected from public.merchant_onboarding where user_id=p_user_id;
  if jsonb_array_length(p_results)<>v_expected then raise exception 'Registre resultado para a empresa, representante e todas as pessoas relacionadas.'; end if;
  for v_item in select value from jsonb_array_elements(p_results) loop
    if coalesce(v_item->>'subject_key','') not in ('company','representative') and coalesce(v_item->>'subject_key','') !~ '^owner:[0-9a-fA-F-]{36}$' then
      raise exception 'Pessoa da diligência inválida.';
    end if;
    if v_item->>'pep_result' not in ('CLEAR','POTENTIAL_MATCH','CONFIRMED_MATCH','UNRESOLVED')
       or v_item->>'sanctions_result' not in ('CLEAR','POTENTIAL_MATCH','CONFIRMED_MATCH','UNRESOLVED') then raise exception 'Selecione os resultados da diligência.'; end if;
    if v_item->>'subject_key' like 'owner:%' and not exists(select 1 from public.merchant_onboarding m,
       jsonb_array_elements(m.data->'owners') as owners(item)
       where m.user_id=p_user_id and ('owner:'||(owners.item->>'id'))=v_item->>'subject_key') then raise exception 'Pessoa relacionada não pertence ao cadastro.'; end if;
    insert into public.merchant_kyc_screenings(batch_id,user_id,subject_key,pep_result,sanctions_result,source_name,reference_id,notes,reviewer_id)
      values(v_batch,p_user_id,v_item->>'subject_key',v_item->>'pep_result',v_item->>'sanctions_result',left(trim(p_source_name),160),nullif(left(trim(coalesce(p_reference_id,'')),160),''),left(trim(p_notes),1000),auth.uid());
    v_inserted:=v_inserted+1;
  end loop;
  if v_inserted<>v_expected or (select count(distinct subject_key) from public.merchant_kyc_screenings where batch_id=v_batch)<>v_expected then
    raise exception 'A diligência deve conter cada pessoa uma única vez.';
  end if;
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(auth.uid(),'kyc.screening_recorded',p_user_id::text,jsonb_build_object('batch_id',v_batch,'subjects',v_inserted,'source',left(trim(p_source_name),160)));
  update public.merchant_onboarding set current_screening_batch_id=v_batch,updated_at=now() where user_id=p_user_id;
  return v_batch;
end;
$$;

create or replace function public.nexora_admin_kyc_list()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_nexora_super_admin() then raise exception 'Acesso restrito ao Super Admin.'; end if;
  if coalesce(auth.jwt()->>'aal','aal1')<>'aal2' then raise exception 'Confirme MFA para consultar cadastros e documentos.'; end if;
  return coalesce((select jsonb_agg(to_jsonb(items) order by items.submitted_at desc nulls last)
    from (select m.user_id,u.email,coalesce(nullif(trim(u.raw_user_meta_data->>'full_name'),''),split_part(u.email,'@',1)) as full_name,
      m.status,m.data,m.reason_code,m.reason_description,m.submitted_at,m.created_at,
      coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'document_type',d.document_type,'subject_key',d.subject_key,
        'storage_path',d.storage_path,'file_name',d.file_name,'content_type',d.content_type,'size_bytes',d.size_bytes,'uploaded_at',d.uploaded_at)
        order by d.uploaded_at desc) from public.merchant_kyc_documents d where d.user_id=m.user_id),'[]'::jsonb) as documents,
      coalesce((select jsonb_agg(jsonb_build_object('from_status',r.from_status,'to_status',r.to_status,'reason',r.reason,
        'created_at',r.created_at,'reviewer_email',(select reviewer.email from auth.users reviewer where reviewer.id=r.reviewer_id))
        order by r.created_at desc) from public.merchant_kyc_reviews r where r.user_id=m.user_id),'[]'::jsonb) as review_history,
      coalesce((select jsonb_agg(jsonb_build_object('batch_id',s.batch_id,'subject_key',s.subject_key,'pep_result',s.pep_result,
        'sanctions_result',s.sanctions_result,'source_name',s.source_name,'reference_id',s.reference_id,'notes',s.notes,
        'screened_at',s.screened_at,'reviewer_email',(select reviewer.email from auth.users reviewer where reviewer.id=s.reviewer_id))
        order by s.screened_at desc,s.subject_key) from public.merchant_kyc_screenings s where s.user_id=m.user_id),'[]'::jsonb) as screening_history
      from public.merchant_onboarding m join auth.users u on u.id=m.user_id where m.status<>'DRAFT') items),'[]'::jsonb);
end;
$$;

-- Approval is impossible until the latest complete manual screening is clear for every subject.
create or replace function public.nexora_admin_review_merchant(p_user_id uuid,p_decision text,p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_status text; v_reason text:=left(trim(coalesce(p_reason,'')),1000); v_batch uuid; v_expected integer;
begin
  if not public.is_nexora_super_admin() then raise exception 'Acesso restrito ao Super Admin.'; end if;
  if coalesce(auth.jwt()->>'aal','aal1')<>'aal2' then raise exception 'Confirme MFA antes de decidir o cadastro.'; end if;
  if p_decision not in ('APPROVED','PENDING_DOCUMENTS','REJECTED') then raise exception 'Decisão inválida.'; end if;
  if length(v_reason)<5 then raise exception 'Registre um motivo com pelo menos 5 caracteres.'; end if;
  select status into v_status from public.merchant_onboarding where user_id=p_user_id for update;
  if not found or v_status not in ('SUBMITTED','UNDER_REVIEW','MANUAL_REVIEW','PENDING_DOCUMENTS','REJECTED') then raise exception 'Cadastro indisponível para análise.'; end if;
  if p_decision='APPROVED' then
    select 2 + case when coalesce(data #>> '{company,account_type}','')='company' then jsonb_array_length(coalesce(data->'owners','[]'::jsonb)) else 0 end
      into v_expected from public.merchant_onboarding where user_id=p_user_id;
    select current_screening_batch_id into v_batch from public.merchant_onboarding where user_id=p_user_id;
    if v_batch is null or (select count(*) from public.merchant_kyc_screenings where batch_id=v_batch and user_id=p_user_id)<>v_expected
       or exists(select 1 from public.merchant_kyc_screenings where batch_id=v_batch and user_id=p_user_id and (pep_result<>'CLEAR' or sanctions_result<>'CLEAR')) then
      raise exception 'Não é possível aprovar: diligência PEP/sanções precisa estar completa e sem correspondência pendente.';
    end if;
    if exists(select 1 from (values ('representative_id_front','representative'),('representative_id_back','representative'),('additional_document','representative')) req(document_type,subject_key)
       where not exists(select 1 from public.merchant_kyc_documents d where d.user_id=p_user_id and d.document_type=req.document_type and d.subject_key=req.subject_key)) then
      raise exception 'Não é possível aprovar: documentos obrigatórios do representante ausentes.';
    end if;
    if exists(select 1 from public.merchant_onboarding m,(values ('cnpj_proof'),('company_articles'),('company_address_proof'),('bank_proof')) req(document_type)
       where m.user_id=p_user_id and m.data #>> '{company,account_type}'='company'
         and not exists(select 1 from public.merchant_kyc_documents d where d.user_id=p_user_id and d.document_type=req.document_type and d.subject_key='company')) then
      raise exception 'Não é possível aprovar: faltam documentos empresariais ou bancários obrigatórios.';
    end if;
  end if;
  update public.merchant_onboarding set status=p_decision,
    reason_code=case p_decision when 'APPROVED' then null when 'REJECTED' then 'REJECTED_BY_REVIEW' else 'ADDITIONAL_INFORMATION_REQUIRED' end,
    reason_description=case when p_decision='APPROVED' then null else v_reason end,
    reviewed_by=auth.uid(),reviewed_at=now(),updated_at=now() where user_id=p_user_id;
  insert into public.merchant_kyc_reviews(user_id,reviewer_id,from_status,to_status,reason)
    values(p_user_id,auth.uid(),v_status,p_decision,v_reason);
end;
$$;

revoke all on function public.nexora_kyc_register_document_v2(text,text,text,text,text,bigint) from public,anon;
revoke all on function public.nexora_kyc_register_document(text,text,text,text,bigint) from public,anon;
revoke all on function public.nexora_kyc_submit(jsonb) from public,anon;
revoke all on function public.nexora_admin_record_kyc_screening(uuid,jsonb,text,text,text) from public,anon;
revoke all on function public.nexora_admin_kyc_list() from public,anon;
revoke all on function public.nexora_admin_review_merchant(uuid,text,text) from public,anon;
grant execute on function public.nexora_kyc_register_document_v2(text,text,text,text,text,bigint) to authenticated;
grant execute on function public.nexora_kyc_register_document(text,text,text,text,bigint) to authenticated;
grant execute on function public.nexora_kyc_submit(jsonb) to authenticated;
grant execute on function public.nexora_admin_record_kyc_screening(uuid,jsonb,text,text,text) to authenticated;
grant execute on function public.nexora_admin_kyc_list() to authenticated;
grant execute on function public.nexora_admin_review_merchant(uuid,text,text) to authenticated;
notify pgrst,'reload schema';
commit;

-- Support numeric and alphanumeric Brazilian CNPJs in KYC, customer records,
-- and the legacy business document field. Existing numeric identifiers remain valid.
begin;

do $$ begin
  if to_regclass('public.merchant_onboarding') is null
     or to_regclass('public.merchant_kyc_documents') is null
     or to_regclass('public.merchant_kyc_reviews') is null
     or to_regclass('public.businesses') is null
     or to_regclass('public.workspace_members') is null
     or to_regclass('public.nexora_customers') is null
     or to_regprocedure('public.nexora_account_active(uuid)') is null
     or to_regprocedure('public.is_nexora_super_admin()') is null
     or to_regprocedure('public.nexora_assert_workspace()') is null
     or to_regprocedure('public.nexora_kyc_submit(jsonb)') is null
     or to_regprocedure('public.nexora_save_customer(text,text,text,uuid)') is null
     or to_regprocedure('public.get_my_access()') is null then
    raise exception 'Apply onboarding, customer billing, and KYC access-gate migrations first.';
  end if;
end $$;

create or replace function public.nexora_normalize_brazilian_document(p_value text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select upper(regexp_replace(coalesce(p_value,''),'[./[:space:]-]','','g'))
$$;

create or replace function public.nexora_valid_cpf(p_value text)
returns boolean language plpgsql immutable parallel safe set search_path = '' as $$
declare
  v text := public.nexora_normalize_brazilian_document(p_value);
  v_sum integer;
  v_digit integer;
  v_remainder integer;
  i integer;
begin
  if v !~ '^[0-9]{11}$' or v ~ '^(.)\1{10}$' then return false; end if;
  v_sum := 0;
  for i in 1..9 loop v_sum := v_sum + substring(v from i for 1)::integer * (11-i); end loop;
  v_remainder := (v_sum * 10) % 11;
  v_digit := case when v_remainder=10 then 0 else v_remainder end;
  if v_digit <> substring(v from 10 for 1)::integer then return false; end if;
  v_sum := 0;
  for i in 1..10 loop v_sum := v_sum + substring(v from i for 1)::integer * (12-i); end loop;
  v_remainder := (v_sum * 10) % 11;
  v_digit := case when v_remainder=10 then 0 else v_remainder end;
  return v_digit = substring(v from 11 for 1)::integer;
end;
$$;

create or replace function public.nexora_valid_cnpj(p_value text)
returns boolean language plpgsql immutable parallel safe set search_path = '' as $$
declare
  v text := public.nexora_normalize_brazilian_document(p_value);
  v_weights integer[];
  v_sum integer;
  v_remainder integer;
  v_digit integer;
  i integer;
begin
  if v !~ '^[A-Z0-9]{12}[0-9]{2}$' or v ~ '^(.)\1{13}$' then return false; end if;
  v_weights := array[5,4,3,2,9,8,7,6,5,4,3,2];
  v_sum := 0;
  for i in 1..12 loop
    v_sum := v_sum + (ascii(substring(v from i for 1))-48) * v_weights[i];
  end loop;
  v_remainder := v_sum % 11;
  v_digit := case when v_remainder < 2 then 0 else 11-v_remainder end;
  if v_digit <> substring(v from 13 for 1)::integer then return false; end if;
  v_weights := array[6,5,4,3,2,9,8,7,6,5,4,3,2];
  v_sum := 0;
  for i in 1..13 loop
    v_sum := v_sum + (ascii(substring(v from i for 1))-48) * v_weights[i];
  end loop;
  v_remainder := v_sum % 11;
  v_digit := case when v_remainder < 2 then 0 else 11-v_remainder end;
  return v_digit = substring(v from 14 for 1)::integer;
end;
$$;

create or replace function public.nexora_valid_brazilian_document(p_value text)
returns boolean language plpgsql immutable parallel safe set search_path = '' as $$
declare v text := public.nexora_normalize_brazilian_document(p_value);
begin
  if length(v)=11 then return public.nexora_valid_cpf(v); end if;
  if length(v)=14 then return public.nexora_valid_cnpj(v); end if;
  return false;
end;
$$;

revoke all on function public.nexora_normalize_brazilian_document(text) from public,anon;
revoke all on function public.nexora_valid_cpf(text) from public,anon;
revoke all on function public.nexora_valid_cnpj(text) from public,anon;
revoke all on function public.nexora_valid_brazilian_document(text) from public,anon;
grant execute on function public.nexora_normalize_brazilian_document(text) to authenticated,service_role;
grant execute on function public.nexora_valid_cpf(text) to authenticated,service_role;
grant execute on function public.nexora_valid_cnpj(text) to authenticated,service_role;
grant execute on function public.nexora_valid_brazilian_document(text) to authenticated,service_role;

alter table public.nexora_customers drop constraint if exists nexora_customers_document_format;
alter table public.nexora_customers add constraint nexora_customers_document_format
  check (document is null or public.nexora_valid_brazilian_document(document)) not valid;

create or replace function public.nexora_save_customer(
  p_name text,p_email text,p_document text,p_customer_id uuid default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_business uuid := public.nexora_assert_workspace();
  v_customer uuid;
  v_email text := nullif(lower(trim(coalesce(p_email,''))), '');
  v_document text := nullif(public.nexora_normalize_brazilian_document(p_document), '');
begin
  if nullif(trim(coalesce(p_name,'')), '') is null or length(trim(p_name)) > 160 then
    raise exception 'Informe um nome de cliente válido.';
  end if;
  if v_email is not null and (length(v_email)>254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then
    raise exception 'Informe um e-mail válido.';
  end if;
  if v_document is not null and not public.nexora_valid_brazilian_document(v_document) then
    raise exception 'Informe um CPF ou CNPJ válido.';
  end if;
  perform 1 from public.businesses where id=v_business for update;
  if p_customer_id is null then
    select id into v_customer from public.nexora_customers
      where business_id=v_business and owner_id=auth.uid()
        and ((v_email is not null and lower(email)=v_email)
          or (v_email is null and email is null and lower(name)=lower(trim(p_name))))
      order by created_at,id limit 1;
  else
    select id into v_customer from public.nexora_customers
      where id=p_customer_id and business_id=v_business and owner_id=auth.uid();
    if v_customer is null then raise exception 'Cliente não pertence a este workspace.'; end if;
  end if;
  if v_customer is null then
    insert into public.nexora_customers(owner_id,business_id,name,email,document,total)
      values(auth.uid(),v_business,trim(p_name),v_email,v_document,0) returning id into v_customer;
  else
    update public.nexora_customers set name=trim(p_name),email=v_email,
      document=coalesce(v_document,document),last_activity=now()
      where id=v_customer and owner_id=auth.uid() and business_id=v_business;
  end if;
  return v_customer;
end;
$$;
revoke all on function public.nexora_save_customer(text,text,text,uuid) from public,anon;
grant execute on function public.nexora_save_customer(text,text,text,uuid) to authenticated;

create or replace function public.nexora_kyc_submit(p_data jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_status text; v_missing text[]; v_document text; v_type text;
begin
  if auth.uid() is null then raise exception 'Faça login para enviar o cadastro.'; end if;
  if coalesce(auth.jwt()->>'aal','aal1') <> 'aal2' then
    raise exception 'Confirme sua identidade com a verificação em duas etapas antes de enviar o cadastro.';
  end if;
  if jsonb_typeof(p_data) <> 'object' or pg_column_size(p_data)>65536 then raise exception 'Dados cadastrais inválidos.'; end if;
  if jsonb_typeof(p_data->'company') <> 'object' or jsonb_typeof(p_data->'representative') <> 'object'
     or jsonb_typeof(coalesce(p_data->'owners','[]'::jsonb)) <> 'array' then raise exception 'Seções do cadastro inválidas.'; end if;
  if jsonb_array_length(coalesce(p_data->'owners','[]'::jsonb))>50 then raise exception 'Limite de 50 sócios/beneficiários excedido.'; end if;
  if coalesce(p_data->>'privacy_consent','false')<>'true'
     or coalesce(p_data->>'privacy_notice_version','')<>'2026-10-08-beta-v3' then
    raise exception 'Confirme o aviso de privacidade antes de enviar.';
  end if;
  v_type:=coalesce(p_data #>> '{company,account_type}','');
  v_document:=public.nexora_normalize_brazilian_document(p_data #>> '{company,document_number}');
  if v_type='company' then
    if coalesce(p_data #>> '{company,document_type}','')<>'cnpj' or not public.nexora_valid_cnpj(v_document) then
      raise exception 'Informe um CNPJ válido com 14 posições.';
    end if;
    p_data:=jsonb_set(p_data,'{company,document_number}',to_jsonb(v_document),true);
    p_data:=jsonb_set(p_data,'{company,cnpj}',to_jsonb(v_document),true);
  elsif v_type='individual' then
    if coalesce(p_data #>> '{company,document_type}','')<>'cpf' or not public.nexora_valid_cpf(v_document) then
      raise exception 'Informe um CPF válido com 11 dígitos.';
    end if;
    p_data:=jsonb_set(p_data,'{company,document_number}',to_jsonb(v_document),true);
    p_data:=jsonb_set(p_data,'{company,cnpj}',to_jsonb(v_document),true);
    p_data:=jsonb_set(p_data,'{representative,cpf}',to_jsonb(v_document),true);
  else raise exception 'Tipo de cadastro inválido.';
  end if;
  if coalesce(p_data #>> '{company,legal_name}','')=''
     or coalesce(p_data #>> '{company,phone}','')=''
     or coalesce(p_data #>> '{company,email}','')=''
     or coalesce(p_data #>> '{company,postal_code}','')=''
     or coalesce(p_data #>> '{representative,full_name}','')='' then
    raise exception 'Preencha nome, documento, e-mail, celular e CEP.';
  end if;
  if exists(select 1 from unnest(array['company.postal_code','company.address_street','company.address_extra','company.address_neighborhood']) as required(field_path)
      where coalesce(p_data #>> string_to_array(required.field_path,'.'),'')='') then
    raise exception 'Preencha CEP, rua, número e bairro.';
  end if;
  select status into v_status from public.merchant_onboarding where user_id=auth.uid() for update;
  if not found then raise exception 'Ficha cadastral não encontrada. Entre novamente.'; end if;
  if v_status not in ('DRAFT','PENDING_SUBMISSION','PENDING_DOCUMENTS','REJECTED') then
    raise exception 'Este cadastro já está em análise ou foi aprovado; não pode ser alterado agora.';
  end if;
  select array_agg(required_type) into v_missing
    from unnest(array['representative_id_front','representative_id_back','additional_document']) as required(required_type)
    where not exists(select 1 from public.merchant_kyc_documents d where d.user_id=auth.uid() and d.document_type=required_type);
  if coalesce(array_length(v_missing,1),0)>0 then raise exception 'Documentos obrigatórios ausentes: %',array_to_string(v_missing,', '); end if;
  update public.merchant_onboarding set data=p_data,status='SUBMITTED',reason_code=null,reason_description=null,
    consented_at=now(),privacy_notice_version='2026-10-08-beta-v3',submitted_at=now(),reviewed_by=null,reviewed_at=null,updated_at=now()
    where user_id=auth.uid();
  insert into public.merchant_kyc_reviews(user_id,reviewer_id,from_status,to_status,reason)
    values(auth.uid(),auth.uid(),v_status,'SUBMITTED','Cliente enviou o cadastro para análise.');
  return jsonb_build_object('status','SUBMITTED');
end;
$$;
revoke all on function public.nexora_kyc_submit(jsonb) from public,anon;
grant execute on function public.nexora_kyc_submit(jsonb) to authenticated;

create or replace function public.get_my_access()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid:=auth.uid(); v_is_admin boolean; v_status text; v_id uuid; v_name text; v_document text;
begin
  if v_user is null then raise exception 'Sessão expirada. Entre novamente.'; end if;
  v_is_admin:=public.is_nexora_super_admin();
  if not public.nexora_account_active(v_user) then
    return jsonb_build_object('user_id',v_user,'can_access',false,'can_operate',false,'access_status','suspended','onboarding_status','SUSPENDED','is_nexora_admin',v_is_admin);
  end if;
  if not v_is_admin then
    insert into public.merchant_onboarding(user_id,status,data) values(v_user,'DRAFT','{}'::jsonb) on conflict(user_id) do nothing;
    select m.status into v_status from public.merchant_onboarding m where m.user_id=v_user;
    if v_status in ('SUSPENDED','BLOCKED','CLOSED') then
      return jsonb_build_object('user_id',v_user,'can_access',false,'can_operate',false,'access_status',lower(v_status),'onboarding_status',v_status,'is_nexora_admin',false);
    end if;
  else v_status:='APPROVED'; end if;
  perform 1 from auth.users u where u.id=v_user for update;
  select b.id,b.name into v_id,v_name from public.businesses b where b.owner_id=v_user order by b.id limit 1;
  if v_id is null then
    select coalesce(nullif(trim(m.data #>> '{company,trade_name}'),''),nullif(trim(u.raw_user_meta_data->>'full_name'),''),split_part(u.email,'@',1))||' · Nexora',
      nullif(public.nexora_normalize_brazilian_document(m.data #>> '{company,document_number}'),'')
      into v_name,v_document from auth.users u left join public.merchant_onboarding m on m.user_id=u.id where u.id=v_user;
    insert into public.businesses(owner_id,name,document) values(v_user,v_name,v_document) returning id into v_id;
  else
    select coalesce(nullif(trim(m.data #>> '{company,trade_name}'),''),b.name)||' · Nexora',
      nullif(public.nexora_normalize_brazilian_document(m.data #>> '{company,document_number}'),'')
      into v_name,v_document from public.businesses b left join public.merchant_onboarding m on m.user_id=b.owner_id
      where b.id=v_id and b.owner_id=v_user;
    update public.businesses set name=v_name,document=coalesce(v_document,document) where id=v_id and owner_id=v_user;
  end if;
  insert into public.workspace_members(business_id,user_id,role) values(v_id,v_user,'owner')
    on conflict(business_id,user_id) do update set role='owner';
  return jsonb_build_object('user_id',v_user,'business_id',v_id,'business_name',v_name,'role','owner','can_access',true,
    'can_operate',(v_is_admin or v_status='APPROVED'),
    'access_status',case when v_is_admin or v_status='APPROVED' then 'active' else 'pending_kyc' end,
    'onboarding_status',coalesce(v_status,'DRAFT'),'is_nexora_admin',v_is_admin);
end;
$$;
revoke all on function public.get_my_access() from public,anon;
grant execute on function public.get_my_access() to authenticated;
notify pgrst,'reload schema';
commit;

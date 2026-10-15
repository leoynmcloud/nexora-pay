-- Armazena o CPF/CNPJ no cadastro do cliente para que o formulário de cobrança
-- precise apenas selecionar um cliente. O documento nunca é retornado no snapshot.
alter table public.nexora_customers
  add column if not exists document text;

alter table public.nexora_customers
  drop constraint if exists nexora_customers_document_format;
alter table public.nexora_customers
  add constraint nexora_customers_document_format
  check (document is null or document ~ '^[0-9]{11}([0-9]{3})?$');

create or replace function public.nexora_save_customer(
  p_name text,
  p_email text,
  p_document text,
  p_customer_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business uuid := public.nexora_assert_workspace();
  v_customer uuid;
  v_email text := nullif(lower(trim(coalesce(p_email, ''))), '');
  v_document text := nullif(regexp_replace(coalesce(p_document, ''), '\D', '', 'g'), '');
begin
  if nullif(trim(coalesce(p_name, '')), '') is null or length(trim(p_name)) > 160 then
    raise exception 'Informe um nome de cliente válido.';
  end if;
  if v_email is not null and (length(v_email) > 254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then
    raise exception 'Informe um e-mail válido.';
  end if;
  if v_document is not null and v_document !~ '^(\d{11}|\d{14})$' then
    raise exception 'Informe um CPF ou CNPJ válido.';
  end if;

  perform 1 from public.businesses where id = v_business for update;
  if p_customer_id is null then
    select id into v_customer from public.nexora_customers
    where business_id = v_business and owner_id = auth.uid()
      and ((v_email is not null and lower(email) = v_email)
        or (v_email is null and email is null and lower(name) = lower(trim(p_name))))
    order by created_at, id limit 1;
  else
    select id into v_customer from public.nexora_customers
    where id = p_customer_id and business_id = v_business and owner_id = auth.uid();
    if v_customer is null then raise exception 'Cliente não pertence a este workspace.'; end if;
  end if;

  if v_customer is null then
    insert into public.nexora_customers(owner_id, business_id, name, email, document, total)
    values (auth.uid(), v_business, trim(p_name), v_email, v_document, 0)
    returning id into v_customer;
  else
    update public.nexora_customers
    set name = trim(p_name), email = v_email,
        document = coalesce(v_document, document), last_activity = now()
    where id = v_customer and owner_id = auth.uid() and business_id = v_business;
  end if;
  return v_customer;
end;
$$;

revoke all on function public.nexora_save_customer(text, text, text, uuid) from public, anon;
grant execute on function public.nexora_save_customer(text, text, text, uuid) to authenticated;

create or replace function public.nexora_list_charge_customers()
returns table (id uuid, name text, email text, has_document boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.name, c.email, c.document is not null
  from public.nexora_customers c
  where c.owner_id = auth.uid()
    and c.business_id = public.nexora_assert_workspace()
    and c.email is not null
    and public.nexora_account_active(auth.uid())
  order by c.name, c.id;
$$;

revoke all on function public.nexora_list_charge_customers() from public, anon;
grant execute on function public.nexora_list_charge_customers() to authenticated;
notify pgrst, 'reload schema';

-- Align the hosted checkout database gates with the CPF/alphanumeric-CNPJ
-- validation already performed by the public checkout Edge Function.
-- Run after nexora-cnpj-alphanumeric.sql and the hosted checkout migrations.
begin;

do $$
declare
  v_signature text;
  v_parameter text;
  v_function oid;
  v_definition text;
  v_old_predicate text;
  v_structural_predicate text;
  v_validated_predicate text;
begin
  if to_regprocedure('public.nexora_valid_brazilian_document(text)') is null then
    raise exception 'Apply nexora-cnpj-alphanumeric.sql before this migration.';
  end if;

  for v_signature,v_parameter in
    select * from (values
      ('public.nexora_provider_begin_charge(uuid,uuid,uuid,text,text,text,text,numeric,text,uuid,text,timestamptz)', 'p_customer_document'),
      ('public.nexora_checkout_public_begin_charge(text,text,text,text,text)', 'p_payer_document')
    ) as targets(signature,parameter)
  loop
    v_function := to_regprocedure(v_signature);
    if v_function is null then
      raise exception 'Required checkout function is missing: %.',v_signature;
    end if;

    v_definition := pg_get_functiondef(v_function);
    v_old_predicate := format('%s is null or %s !~ %L',v_parameter,v_parameter,'^[0-9]{11}([0-9]{3})?$');
    v_structural_predicate := format('%s is null or %s !~ %L',v_parameter,v_parameter,'^([0-9]{11}|[A-Z0-9]{12}[0-9]{2})$');
    v_validated_predicate := format('%s is null or not public.nexora_valid_brazilian_document(%s)',v_parameter,v_parameter);

    if position(v_validated_predicate in v_definition)>0 then
      continue;
    elsif position(v_structural_predicate in v_definition)>0 then
      v_definition := replace(v_definition,v_structural_predicate,v_validated_predicate);
    elsif position(v_old_predicate in v_definition)>0 then
      v_definition := replace(v_definition,v_old_predicate,v_validated_predicate);
    else
      raise exception 'Could not safely identify the payer-document validation in %; no function was changed.',v_signature;
    end if;
    execute v_definition;
  end loop;
end;
$$;

notify pgrst,'reload schema';
commit;

select p.oid::regprocedure as function_name,
  position('nexora_valid_brazilian_document' in pg_get_functiondef(p.oid))>0 as validates_document_checksum,
  has_function_privilege('anon',p.oid,'EXECUTE') as anon_can_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_can_execute,
  has_function_privilege('service_role',p.oid,'EXECUTE') as service_role_can_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('nexora_provider_begin_charge','nexora_checkout_public_begin_charge')
order by p.proname;

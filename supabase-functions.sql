-- Funções seguras para a demo Nexora Pay.
-- Execute depois das tabelas principais e com RLS habilitado.

create or replace function public.create_my_business(p_name text, p_document text default null)
returns public.businesses
language plpgsql
security invoker
set search_path = public
as $$
declare result public.businesses;
begin
  insert into public.businesses (owner_id, name, document)
  values (auth.uid(), nullif(trim(p_name), ''), p_document)
  returning * into result;
  return result;
end;
$$;

create or replace function public.create_payment_link(
  p_business_id uuid,
  p_title text,
  p_amount numeric,
  p_customer_id uuid default null,
  p_expires_at timestamptz default null
)
returns public.payment_links
language plpgsql
security invoker
set search_path = public
as $$
declare result public.payment_links;
begin
  if not exists (
    select 1 from public.businesses
    where id = p_business_id and owner_id = auth.uid()
  ) then raise exception 'business_not_allowed'; end if;

  insert into public.payment_links (business_id, customer_id, title, amount, expires_at)
  values (p_business_id, p_customer_id, p_title, p_amount, p_expires_at)
  returning * into result;
  return result;
end;
$$;

create or replace function public.get_dashboard_summary(p_business_id uuid)
returns jsonb
language sql
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'balance', coalesce(sum(case when kind = 'payment' and status = 'paid' then amount else 0 end), 0),
    'received', coalesce(sum(case when kind = 'payment' and status = 'paid' and created_at >= date_trunc('month', now()) then amount else 0 end), 0),
    'transactions', count(*)
  )
  from public.transactions t
  where t.business_id = p_business_id
    and exists (select 1 from public.businesses b where b.id = p_business_id and b.owner_id = auth.uid());
$$;

create or replace function public.set_transaction_status(p_transaction_id uuid, p_status public.transaction_status)
returns public.transactions
language plpgsql
security invoker
set search_path = public
as $$
declare result public.transactions;
begin
  update public.transactions t
  set status = p_status,
      paid_at = case when p_status = 'paid' then coalesce(t.paid_at, now()) else t.paid_at end
  where t.id = p_transaction_id
    and exists (select 1 from public.businesses b where b.id = t.business_id and b.owner_id = auth.uid())
  returning t.* into result;
  if result.id is null then raise exception 'transaction_not_allowed'; end if;
  return result;
end;
$$;

create or replace function public.log_audit(p_business_id uuid, p_action text, p_metadata jsonb default '{}'::jsonb)
returns public.audit_logs
language plpgsql
security invoker
set search_path = public
as $$
declare result public.audit_logs;
begin
  insert into public.audit_logs (business_id, user_id, action, metadata)
  select p_business_id, auth.uid(), p_action, p_metadata
  where exists (select 1 from public.businesses where id = p_business_id and owner_id = auth.uid())
  returning * into result;
  return result;
end;
$$;

grant execute on function public.create_my_business(text, text) to authenticated;
grant execute on function public.create_payment_link(uuid, text, numeric, uuid, timestamptz) to authenticated;
grant execute on function public.get_dashboard_summary(uuid) to authenticated;
grant execute on function public.set_transaction_status(uuid, public.transaction_status) to authenticated;
grant execute on function public.log_audit(uuid, text, jsonb) to authenticated;

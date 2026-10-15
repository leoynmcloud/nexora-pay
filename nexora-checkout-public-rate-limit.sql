-- Follow-up migration for installations that already applied nexora-hosted-checkout.sql.
-- Anonymous requests are throttled per existing checkout link; no client IP header is trusted.
begin;

do $$ begin
  if to_regclass('public.nexora_checkout_links') is null then
    raise exception 'Apply nexora-hosted-checkout.sql before this migration.';
  end if;
end $$;

create table if not exists public.nexora_checkout_public_rate_limits (
  checkout_link_id uuid not null references public.nexora_checkout_links(id) on delete cascade,
  action text not null check (action in ('view','pay')),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  primary key (checkout_link_id,action)
);
alter table public.nexora_checkout_public_rate_limits enable row level security;
revoke all on public.nexora_checkout_public_rate_limits from public,anon,authenticated,service_role;

create or replace function public.nexora_checkout_consume_public_rate_limit(
  p_token_hash text,p_action text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_link_id uuid;
  v_now timestamptz := clock_timestamp();
  v_window_seconds integer;
  v_max_requests integer;
  v_window_start timestamptz;
  v_count integer;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
    or p_action is null or p_action not in ('view','pay') then raise exception 'Invalid checkout rate limit request.'; end if;

  select id into v_link_id from public.nexora_checkout_links
    where token_hash=p_token_hash and expires_at>v_now;
  if not found then return jsonb_build_object('allowed',false,'retry_after_seconds',0); end if;

  if p_action='view' then
    v_window_seconds := 60;
    v_max_requests := 30;
  else
    v_window_seconds := 600;
    v_max_requests := 5;
  end if;
  v_window_start := to_timestamp(floor(extract(epoch from v_now)/v_window_seconds)*v_window_seconds);

  insert into public.nexora_checkout_public_rate_limits(
    checkout_link_id,action,window_started_at,request_count
  ) values (v_link_id,p_action,v_window_start,1)
  on conflict (checkout_link_id,action) do update set
    request_count=case
      when public.nexora_checkout_public_rate_limits.window_started_at=v_window_start
        then least(public.nexora_checkout_public_rate_limits.request_count,v_max_requests)+1
      else 1 end,
    window_started_at=v_window_start
  where public.nexora_checkout_public_rate_limits.window_started_at is distinct from v_window_start
    or public.nexora_checkout_public_rate_limits.request_count<=v_max_requests
  returning request_count into v_count;
  if v_count is null then
    select request_count into v_count from public.nexora_checkout_public_rate_limits
      where checkout_link_id=v_link_id and action=p_action;
  end if;

  return jsonb_build_object(
    'allowed',v_count<=v_max_requests,
    'retry_after_seconds',case when v_count<=v_max_requests then 0 else greatest(1,ceil(extract(epoch from (v_window_start+make_interval(secs=>v_window_seconds)-v_now))::numeric)::integer) end
  );
end;
$$;
revoke all on function public.nexora_checkout_consume_public_rate_limit(text,text) from public,anon,authenticated;
grant execute on function public.nexora_checkout_consume_public_rate_limit(text,text) to service_role;

notify pgrst,'reload schema';
commit;

select c.relname as table_name,c.relrowsecurity as rls_enabled,
  has_table_privilege('anon',c.oid,'SELECT') as anon_can_select,
  has_table_privilege('authenticated',c.oid,'SELECT') as authenticated_can_select,
  has_table_privilege('authenticated',c.oid,'INSERT') as authenticated_can_insert,
  has_table_privilege('authenticated',c.oid,'UPDATE') as authenticated_can_update,
  has_table_privilege('authenticated',c.oid,'DELETE') as authenticated_can_delete,
  has_table_privilege('service_role',c.oid,'SELECT') as service_role_can_select,
  has_table_privilege('service_role',c.oid,'INSERT') as service_role_can_insert,
  has_table_privilege('service_role',c.oid,'UPDATE') as service_role_can_update,
  has_table_privilege('service_role',c.oid,'DELETE') as service_role_can_delete
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname='nexora_checkout_public_rate_limits';

select has_function_privilege('anon','public.nexora_checkout_consume_public_rate_limit(text,text)','EXECUTE') as anon_can_consume,
  has_function_privilege('authenticated','public.nexora_checkout_consume_public_rate_limit(text,text)','EXECUTE') as authenticated_can_consume,
  has_function_privilege('service_role','public.nexora_checkout_consume_public_rate_limit(text,text)','EXECUTE') as service_role_can_consume;

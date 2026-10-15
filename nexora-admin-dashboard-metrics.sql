-- Indicadores reais do dashboard do Super Admin.
-- Execute no Supabase SQL Editor após nexora-asaas-sandbox.sql.
-- Sandbox, lançamentos manuais/legados e saques não entram nos gráficos.
begin;

create or replace function public.nexora_admin_dashboard_metrics()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_start_90 timestamptz := ((now() at time zone 'America/Sao_Paulo')::date - 89)::timestamp at time zone 'America/Sao_Paulo';
  v_start_30 timestamptz := ((now() at time zone 'America/Sao_Paulo')::date - 29)::timestamp at time zone 'America/Sao_Paulo';
  v_start_today timestamptz := v_today::timestamp at time zone 'America/Sao_Paulo';
  v_end_today timestamptz := (v_today + 1)::timestamp at time zone 'America/Sao_Paulo';
begin
  if not public.is_nexora_super_admin() then
    raise exception 'Acesso restrito ao Painel Nexora Pay.';
  end if;

  return jsonb_build_object(
    'today', jsonb_build_object(
      'volume', (
        select coalesce(sum(t.amount), 0)
        from public.nexora_transactions t
        where t.source = 'gateway' and not t.test_mode and t.kind <> 'withdrawal'
          and t.status = 'paid'
          and coalesce(t.paid_at, t.created_at) >= v_start_today
          and coalesce(t.paid_at, t.created_at) < v_end_today
      ),
      'transactions', (
        select count(*)
        from public.nexora_transactions t
        where t.source = 'gateway' and not t.test_mode and t.kind <> 'withdrawal'
          and t.status = 'paid'
          and coalesce(t.paid_at, t.created_at) >= v_start_today
          and coalesce(t.paid_at, t.created_at) < v_end_today
      ),
      'average_ticket', (
        select coalesce(round(avg(t.amount), 2), 0)
        from public.nexora_transactions t
        where t.source = 'gateway' and not t.test_mode and t.kind <> 'withdrawal'
          and t.status = 'paid'
          and coalesce(t.paid_at, t.created_at) >= v_start_today
          and coalesce(t.paid_at, t.created_at) < v_end_today
      )
    ),
    'volume_by_day', (
      select coalesce(jsonb_agg(
        jsonb_build_object('date', to_char(d.day, 'YYYY-MM-DD'), 'amount', coalesce(v.amount, 0), 'count', coalesce(v.count, 0))
        order by d.day
      ), '[]'::jsonb)
      from generate_series((v_today - 89)::timestamp, v_today::timestamp, interval '1 day') as d(day)
      left join (
        select (coalesce(t.paid_at, t.created_at) at time zone 'America/Sao_Paulo')::date as day,
          sum(t.amount) as amount, count(*) as count
        from public.nexora_transactions t
        where t.source = 'gateway' and not t.test_mode and t.kind <> 'withdrawal' and t.status = 'paid'
          and coalesce(t.paid_at, t.created_at) >= v_start_90
          and coalesce(t.paid_at, t.created_at) < v_end_today
        group by 1
      ) v on v.day = d.day::date
    ),
    'payment_methods', (
      select coalesce(jsonb_agg(jsonb_build_object('method', method, 'amount', amount, 'count', count) order by amount desc), '[]'::jsonb)
      from (
        select coalesce(nullif(lower(trim(t.payment_method)), ''), 'other') as method,
          sum(t.amount) as amount, count(*) as count
        from public.nexora_transactions t
        where t.source = 'gateway' and not t.test_mode and t.kind <> 'withdrawal' and t.status = 'paid'
          and coalesce(t.paid_at, t.created_at) >= v_start_30
          and coalesce(t.paid_at, t.created_at) < v_end_today
        group by 1
      ) methods
    )
  );
end;
$$;

revoke all on function public.nexora_admin_dashboard_metrics() from public, anon;
grant execute on function public.nexora_admin_dashboard_metrics() to authenticated;

commit;

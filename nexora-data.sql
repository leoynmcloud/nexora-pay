-- Dados compartilhados da demo Nexora Pay.
-- Execute depois de access-control.sql, user-settings.sql e nexora-super-admin.sql.

create table if not exists public.nexora_customers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  email text not null,
  total numeric(14,2) not null default 0,
  last_activity timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (business_id, email)
);

create table if not exists public.nexora_transactions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  external_id text not null,
  title text not null,
  customer_name text,
  customer_email text,
  amount numeric(14,2) not null check (amount > 0),
  kind text not null default 'payment' check (kind in ('payment', 'withdrawal', 'charge')),
  status text not null default 'pending' check (status in ('paid', 'pending', 'cancelled')),
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  unique (owner_id, external_id)
);

create table if not exists public.nexora_withdrawals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  amount numeric(14,2) not null check (amount > 0),
  destination text not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'paid', 'cancelled')),
  created_at timestamptz not null default now()
);

alter table public.nexora_customers enable row level security;
alter table public.nexora_transactions enable row level security;
alter table public.nexora_withdrawals enable row level security;

drop policy if exists "owners manage own nexora customers" on public.nexora_customers;
create policy "owners manage own nexora customers" on public.nexora_customers for all
using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "owners manage own nexora transactions" on public.nexora_transactions;
create policy "owners manage own nexora transactions" on public.nexora_transactions for all
using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "owners manage own nexora withdrawals" on public.nexora_withdrawals;
create policy "owners manage own nexora withdrawals" on public.nexora_withdrawals for all
using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Escritas financeiras passam pelas RPCs SECURITY DEFINER de nexora-repair.sql.
-- Manter somente SELECT evita que a reaplicação deste SQL reabra DML direto.
revoke insert, update, delete, truncate on public.nexora_customers, public.nexora_transactions, public.nexora_withdrawals from public, anon, authenticated;
grant select on public.nexora_customers, public.nexora_transactions, public.nexora_withdrawals to authenticated;

create or replace function public.get_nexora_admin_customers()
returns table (id uuid, owner_id uuid, business_id uuid, name text, email text, total numeric, last_activity timestamptz)
language sql stable security definer set search_path = ''
as $$
  select c.id, c.owner_id, c.business_id, c.name, c.email, c.total, c.last_activity
  from public.nexora_customers c
  where exists (select 1 from public.nexora_admins a where lower(trim(a.email)) = lower(trim(auth.jwt() ->> 'email')) and a.role = 'super_admin')
    and coalesce(auth.jwt() ->> 'aal','aal1') = 'aal2'
  order by c.last_activity desc;
$$;

grant execute on function public.get_nexora_admin_customers() to authenticated;

create or replace function public.get_nexora_client_transactions(p_user_id uuid)
returns table (
  id uuid,
  amount numeric,
  kind text,
  status text,
  created_at timestamptz,
  paid_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, t.amount, t.kind::text, t.status::text, t.created_at, t.paid_at
  from public.nexora_transactions t
  join public.businesses b on b.id = t.business_id
  where b.owner_id = p_user_id
    and coalesce(auth.jwt() ->> 'aal','aal1') = 'aal2'
    and exists (
      select 1
      from public.nexora_admins a
      where lower(trim(a.email)) = lower(trim(auth.jwt() ->> 'email'))
        and a.role = 'super_admin'
    )
  order by t.created_at desc;
$$;

grant execute on function public.get_nexora_client_transactions(uuid) to authenticated;

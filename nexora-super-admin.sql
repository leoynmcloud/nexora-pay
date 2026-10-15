-- Super Admin da Nexora Pay
-- Execute no Supabase SQL Editor depois que o usuário existir em Auth.
-- Esta tabela guarda apenas os e-mails autorizados; nunca armazene senhas aqui.

create table if not exists public.nexora_admins (
  email text primary key,
  role text not null default 'super_admin' check (role = 'super_admin'),
  created_at timestamptz not null default now()
);

alter table public.nexora_admins enable row level security;

create or replace function public.is_nexora_super_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.nexora_admins a
    where lower(trim(a.email)) = lower(trim(auth.jwt() ->> 'email'))
      and a.role = 'super_admin'
      and coalesce(auth.jwt() ->> 'aal','aal1') = 'aal2'
  );
$$;

-- Identifica apenas a própria conta autenticada antes do desafio MFA.
-- As funções administrativas continuam protegidas por is_nexora_super_admin() e AAL2.
create or replace function public.is_nexora_super_admin_account()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.nexora_admins a
    where lower(trim(a.email)) = lower(trim(auth.jwt() ->> 'email'))
      and a.role = 'super_admin'
  );
$$;

revoke all on public.nexora_admins from anon, authenticated;
grant execute on function public.is_nexora_super_admin() to authenticated;
revoke all on function public.is_nexora_super_admin_account() from public, anon;
grant execute on function public.is_nexora_super_admin_account() to authenticated;

-- Lista segura para o painel do dono da plataforma.
-- Usuários comuns não conseguem executar esta função com sucesso.
create or replace function public.get_nexora_admin_clients()
returns table (
  user_id uuid,
  email text,
  full_name text,
  business_id uuid,
  business_name text,
  user_created_at timestamptz,
  role text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    u.id,
    u.email,
    nullif(trim(coalesce(u.raw_user_meta_data ->> 'full_name', '')), ''),
    b.id,
    b.name,
    u.created_at,
    coalesce(p.role, 'owner')
  from auth.users u
  left join public.businesses b on b.owner_id = u.id
  left join public.profiles p on p.id = u.id
  where exists (
    select 1
    from public.nexora_admins a
    where lower(trim(a.email)) = lower(trim(auth.jwt() ->> 'email'))
      and a.role = 'super_admin'
      and coalesce(auth.jwt() ->> 'aal','aal1') = 'aal2'
  )
  order by u.created_at desc;
$$;

grant execute on function public.get_nexora_admin_clients() to authenticated;

insert into public.nexora_admins (email)
values ('leoynm@gmail.com'), ('elmoreirag@gmail.com')
on conflict (email) do update set role = 'super_admin';

-- As funções de clientes e transações dos workspaces são criadas em nexora-data.sql,
-- depois que as tabelas compartilhadas existirem.

-- Teste opcional: deve retornar true quando logado como leoynm@gmail.com.
-- select public.is_nexora_super_admin();

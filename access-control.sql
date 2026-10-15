-- Controle de acesso da Nexora Pay.
-- Base de permissões. O acesso efetivo é definido pelas migrações de KYC e
-- Nexora Repair; este arquivo não deve conceder acesso completo por conta própria.

alter table public.profiles
  add column if not exists role text not null default 'owner';

create table if not exists public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  unique (business_id, user_id)
);

alter table public.workspace_members enable row level security;

create or replace function public.is_business_member(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.businesses b
    where b.id = p_business_id and b.owner_id = auth.uid()
  ) or exists (
    select 1 from public.workspace_members wm
    where wm.business_id = p_business_id and wm.user_id = auth.uid()
  );
$$;

-- Falha fechada durante instalação parcial. A função final é instalada por
-- nexora-repair.sql e nexora-kyc-access-gate.sql.
create or replace function public.get_my_access()
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'Instalação incompleta: aplique nexora-repair.sql e nexora-kyc-access-gate.sql.';
end;
$$;

drop policy if exists "members can view their workspace membership" on public.workspace_members;
create policy "members can view their workspace membership"
on public.workspace_members for select
using (user_id = auth.uid() or public.is_business_member(business_id));

drop policy if exists "owners can manage workspace memberships" on public.workspace_members;
create policy "owners can manage workspace memberships"
on public.workspace_members for all
using (exists (select 1 from public.businesses b where b.id = business_id and b.owner_id = auth.uid()))
with check (exists (select 1 from public.businesses b where b.id = business_id and b.owner_id = auth.uid()));

revoke all on function public.is_business_member(uuid) from public, anon;
grant execute on function public.is_business_member(uuid) to authenticated;
revoke all on function public.get_my_access() from public, anon;
grant execute on function public.get_my_access() to authenticated;

-- Não promova membros existentes ao reaplicar esta migração. O papel de cada
-- membro deve ser preservado; o dono do workspace é definido pelo registro
-- businesses.owner_id e pela migração final de acesso/KYC.

-- A tabela subscriptions, caso já exista de uma versão anterior, fica sem uso.
-- Ela não controla mais o acesso e pode ser removida manualmente depois de validar
-- o painel: drop table public.subscriptions;

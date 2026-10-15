-- Persistência das configurações da conta Nexora Pay
-- Execute este arquivo no Supabase SQL Editor depois do access-control.sql.

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  profile_name text,
  workspace_name text,
  alerts boolean not null default true,
  weekly boolean not null default false,
  chart_range text not null default 'Últimos 6 meses',
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

drop policy if exists "users can read own settings" on public.user_settings;
create policy "users can read own settings"
on public.user_settings for select
using (auth.uid() = user_id);

drop policy if exists "users can insert own settings" on public.user_settings;
create policy "users can insert own settings"
on public.user_settings for insert
with check (auth.uid() = user_id);

drop policy if exists "users can update own settings" on public.user_settings;
create policy "users can update own settings"
on public.user_settings for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

grant select, insert, update on public.user_settings to authenticated;

-- Validação opcional: deve retornar a linha do usuário logado após salvar alguma configuração.
-- select * from public.user_settings where user_id = auth.uid();

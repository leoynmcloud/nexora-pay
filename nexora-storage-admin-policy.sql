-- nexora-storage-admin-policy.sql
-- Garante que administradores possam sempre gerar URLs assinadas e visualizar documentos do bucket nexora-kyc

begin;

drop policy if exists "merchant and admin read private kyc files" on storage.objects;

create policy "merchant and admin read private kyc files" on storage.objects
for select to authenticated
using (
  bucket_id = 'nexora-kyc'
  and (
    (storage.foldername(name))[1] = auth.uid()::text
    or public.is_nexora_super_admin()
    or public.is_nexora_super_admin_account()
  )
);

commit;

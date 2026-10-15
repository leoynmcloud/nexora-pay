-- Simplifica a aprovação de KYC para o Super Admin
-- Remove a exigência obrigatória de lote de screening PEP/sanções,
-- permitindo aprovação ou recusa direta do cadastro com registro de auditoria.

begin;

create or replace function public.nexora_admin_review_merchant(p_user_id uuid,p_decision text,p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
  v_reason text := left(trim(coalesce(p_reason, '')), 1000);
begin
  if not public.is_nexora_super_admin() then
    raise exception 'Acesso restrito ao Super Admin.';
  end if;
  if coalesce(auth.jwt()->>'aal','aal1') <> 'aal2' then
    raise exception 'Confirme MFA antes de decidir o cadastro.';
  end if;
  if p_decision not in ('APPROVED','PENDING_DOCUMENTS','REJECTED') then
    raise exception 'Decisão inválida.';
  end if;
  if length(v_reason) < 3 then
    v_reason := case p_decision
      when 'APPROVED' then 'Cadastro aprovado pelo Super Admin'
      when 'REJECTED' then 'Cadastro recusado pela análise'
      else 'Documentos adicionais solicitados'
    end;
  end if;
  select status into v_status from public.merchant_onboarding where user_id = p_user_id for update;
  if not found or v_status not in ('SUBMITTED','UNDER_REVIEW','MANUAL_REVIEW','PENDING_DOCUMENTS','REJECTED') then
    raise exception 'Cadastro indisponível para análise.';
  end if;

  update public.merchant_onboarding set
    status = p_decision,
    reason_code = case p_decision
      when 'APPROVED' then null
      when 'REJECTED' then 'REJECTED_BY_REVIEW'
      else 'ADDITIONAL_INFORMATION_REQUIRED'
    end,
    reason_description = case when p_decision = 'APPROVED' then null else v_reason end,
    reviewed_by = auth.uid(),
    reviewed_at = now(),
    updated_at = now()
  where user_id = p_user_id;

  insert into public.merchant_kyc_reviews(user_id, reviewer_id, from_status, to_status, reason)
    values(p_user_id, auth.uid(), v_status, p_decision, v_reason);

  insert into public.nexora_audit_log(actor_id, action, target_id, details)
    values(auth.uid(), 'kyc.merchant_reviewed', p_user_id::text,
      jsonb_build_object('from_status', v_status, 'to_status', p_decision, 'reason', v_reason));
end;
$$;

revoke all on function public.nexora_admin_review_merchant(uuid,text,text) from public,anon;
grant execute on function public.nexora_admin_review_merchant(uuid,text,text) to authenticated;
notify pgrst, 'reload schema';

commit;

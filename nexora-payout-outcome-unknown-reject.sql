-- Allow admin rejection of OUTCOME_UNKNOWN payouts to release stuck funds back to merchant_available
begin;

create or replace function public.nexora_payout_admin_review(
  p_actor_id uuid,p_payout_id uuid,p_decision text,p_reason text,p_request_sha256 text
)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_payout public.nexora_payouts;
  v_status text;
  v_action text;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role'
     or p_actor_id is null or not exists(
       select 1 from public.nexora_admins a join auth.users u
         on lower(trim(u.email))=lower(trim(a.email))
       where u.id=p_actor_id and a.role='super_admin'
         and public.nexora_account_active(p_actor_id)
     ) then raise exception 'MFA Super Admin session required.'; end if;
  if p_payout_id is null or p_decision is null or p_decision not in ('approve','reject')
     or p_reason is null or length(trim(p_reason)) not between 10 and 500
     or p_request_sha256 is null or p_request_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid payout review.';
  end if;
  select * into v_payout from public.nexora_payouts p where p.id=p_payout_id for update;
  if not found then raise exception 'Payout request not found.'; end if;
  v_action:=case when p_decision='approve' then 'approved' else 'rejected' end;
  if (p_decision='approve' and v_payout.status='APPROVED')
     or (p_decision='reject' and v_payout.status='REJECTED') then return v_payout.status; end if;
  if (p_decision='approve' and v_payout.status<>'RESERVED')
     or (p_decision='reject' and v_payout.status not in ('RESERVED','APPROVED','OUTCOME_UNKNOWN'))
     or v_payout.provider_transfer_id is not null or v_payout.provider_batch_id is not null then
    raise exception 'Payout is no longer awaiting administrative review.';
  end if;
  v_status:=case when p_decision='approve' then 'APPROVED' else 'REJECTED' end;
  if p_decision='reject' then
    perform public.nexora_ledger_post_journal(
      v_payout.owner_id,v_payout.business_id,null,'payout.rejected',
      'payout.rejected:'||v_payout.id::text,p_request_sha256,
      'Reserved funds released after administrative payout rejection.',
      jsonb_build_array(
        jsonb_build_object('account_code','merchant_reserved','side','debit','amount_cents',v_payout.amount_cents),
        jsonb_build_object('account_code','merchant_available','side','credit','amount_cents',v_payout.amount_cents)
      ),jsonb_build_object('payout_id',v_payout.id,'review_actor_id',p_actor_id)
    );
  end if;
  update public.nexora_payouts set status=v_status,
    failure_code=case when p_decision='reject' then 'admin_rejected' else null end,updated_at=now()
    where id=v_payout.id;
  insert into public.nexora_payout_admin_events(payout_id,actor_id,action,from_status,to_status,reason)
    values(v_payout.id,p_actor_id,v_action,v_payout.status,v_status,trim(p_reason));
  insert into public.nexora_audit_log(actor_id,action,target_id,details)
    values(p_actor_id,'payout.admin_'||v_action,v_payout.id::text,
      jsonb_build_object('business_id',v_payout.business_id,'amount_cents',v_payout.amount_cents,
        'from_status',v_payout.status,'to_status',v_status,'reason',trim(p_reason)));
  return v_status;
end;
$$;

commit;

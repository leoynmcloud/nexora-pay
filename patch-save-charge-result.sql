CREATE OR REPLACE FUNCTION public.nexora_provider_save_charge_result(p_attempt_id uuid, p_provider_transaction_id text, p_raw_status text, p_normalized_status text, p_pix_copy_paste text, p_pix_encoded_image text, p_checkout_url text, p_expires_at timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
declare v_attempt public.nexora_payment_attempts;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Backend service role required.'; end if;
  if p_attempt_id is null or p_provider_transaction_id is null
     or length(trim(p_provider_transaction_id)) not between 1 and 255
     or p_raw_status is null or length(trim(p_raw_status)) not between 1 and 80
     or p_normalized_status is null
     or p_normalized_status not in ('CREATED','PENDING','PROCESSING','AUTHORIZED','SUCCEEDED','SETTLED',
       'FAILED','CANCELED','EXPIRED','REFUND_PENDING','REFUNDED','PARTIALLY_REFUNDED','REVERSED','UNDER_REVIEW')
     or length(coalesce(p_pix_copy_paste,''))>5000 or length(coalesce(p_pix_encoded_image,''))>100000
     or length(coalesce(p_checkout_url,''))>2000 then raise exception 'Resposta de pagamento inválida.'; end if;
  select * into v_attempt from public.nexora_payment_attempts where id=p_attempt_id for update;
  if not found or v_attempt.payment_attempted_at is null then raise exception 'Tentativa não autorizada pelo backend.'; end if;
  if v_attempt.provider_transaction_id is not null and lower(v_attempt.provider_transaction_id)<>lower(p_provider_transaction_id) then
    raise exception 'ID externo diverge da operação registrada.';
  end if;
  update public.nexora_payment_attempts set provider_transaction_id=p_provider_transaction_id,
    status=case when v_attempt.status='succeeded' then 'succeeded'
      when v_attempt.status='failed' then 'failed'
      when p_normalized_status in ('SUCCEEDED','SETTLED') then 'succeeded'
      when p_normalized_status in ('FAILED','CANCELED','EXPIRED') then 'failed' else 'processing' end,
    last_error_code=null,updated_at=now() where id=p_attempt_id;
  update public.nexora_provider_payment_operations set provider_transaction_id=p_provider_transaction_id,
    operation_status=p_normalized_status,updated_at=now()
    where id=v_attempt.provider_operation_id
      and (provider_transaction_id is null or lower(provider_transaction_id)=lower(p_provider_transaction_id));
  if not found then raise exception 'Operação do provedor diverge da tentativa.'; end if;
  update public.nexora_transactions set provider_reference=p_provider_transaction_id
    where id=v_attempt.transaction_id
      and (provider_reference is null or lower(provider_reference)=lower(p_provider_transaction_id));
  if not found then raise exception 'Referência externa diverge da transação interna.'; end if;
  insert into public.nexora_provider_payment_details(
    provider_operation_id,transaction_id,business_id,owner_id,provider_transaction_id,
    raw_provider_status,normalized_status,pix_copy_paste,pix_encoded_image,checkout_url,expires_at,updated_at
  ) values(v_attempt.provider_operation_id,v_attempt.transaction_id,v_attempt.business_id,v_attempt.owner_id,
    p_provider_transaction_id,left(trim(p_raw_status),80),p_normalized_status,nullif(p_pix_copy_paste,''),
    nullif(p_pix_encoded_image,''),nullif(p_checkout_url,''),p_expires_at,now())
  on conflict(provider_operation_id) do update set raw_provider_status=excluded.raw_provider_status,
    normalized_status=excluded.normalized_status,
    pix_copy_paste=coalesce(excluded.pix_copy_paste,public.nexora_provider_payment_details.pix_copy_paste),
    pix_encoded_image=coalesce(excluded.pix_encoded_image,public.nexora_provider_payment_details.pix_encoded_image),
    checkout_url=coalesce(excluded.checkout_url,public.nexora_provider_payment_details.checkout_url),
    expires_at=coalesce(excluded.expires_at,public.nexora_provider_payment_details.expires_at),updated_at=now();
  if p_normalized_status in ('FAILED','CANCELED','EXPIRED') and v_attempt.status not in ('succeeded','failed') then
    update public.nexora_transactions set status='cancelled'
      where id=v_attempt.transaction_id and status in ('pending','processing');
    if found then
      perform public.nexora_webhook_enqueue_payment_terminal(v_attempt.transaction_id,
        case when p_normalized_status='FAILED' then 'payment.failed' else 'payment.canceled' end);
    end if;
    update public.nexora_checkout_links set status='failed',updated_at=now()
      where transaction_id=v_attempt.transaction_id and status='processing';
  end if;
end;
$$;

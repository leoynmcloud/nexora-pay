export type ProviderPaymentStatusEvent = {
  provider_code: string;
  provider_event_id: string;
  provider_event_type: string;
  provider_operation_id: string;
  transaction_id: string;
  provider_transaction_id: string;
  raw_provider_status: string;
  normalized_status: string;
  status_checked_at: string;
};

/** Persist an immutable provider snapshot and make retries idempotent by event ID. */
export async function persistProviderPaymentStatusEvent(admin: any, row: ProviderPaymentStatusEvent) {
  const { data: inserted, error: insertError } = await admin.from('nexora_provider_payment_status_events')
    .insert(row).select('id').maybeSingle();
  if (!insertError && inserted) return { id: inserted.id as string | null, normalizedStatus: row.normalized_status };
  if (insertError?.code !== '23505') throw new Error('provider_status_event_persist_failed');

  const { data: existing, error: readError } = await admin.from('nexora_provider_payment_status_events')
    .select('provider_event_type,provider_operation_id,transaction_id,provider_transaction_id,normalized_status')
    .eq('provider_code', row.provider_code).eq('provider_event_id', row.provider_event_id).maybeSingle();
  if (readError || !existing
    || existing.provider_event_type !== row.provider_event_type
    || existing.provider_operation_id !== row.provider_operation_id
    || existing.transaction_id !== row.transaction_id
    || existing.provider_transaction_id !== row.provider_transaction_id) {
    throw new Error('provider_status_event_conflict');
  }
  // A retry may observe a later provider state for an already-seen event ID.
  // Preserve the first snapshot and use its normalized state for this replay.
  return { id: null, normalizedStatus: existing.normalized_status as string };
}

export type MercadoPagoPayoutNotice = {
  providerBatchId: string;
  providerTransactionId: string;
  externalReference: string;
  eventType: string;
  providerStatus: string;
  eventId: string;
};

const providerIdPattern = /^[A-Za-z0-9-]{8,100}$/;
const referencePattern = /^NX-PAYOUT-[A-Za-z0-9-]{16,80}$/;

/** Parse payout notification identity only; status/amount are always fetched from MP API. */
export async function parseMercadoPagoPayoutNotice(value: unknown): Promise<MercadoPagoPayoutNotice> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('mercadopago_payout_notice_invalid');
  const payload = value as Record<string, unknown>;
  const payout = payload.payout;
  if (!payout || typeof payout !== 'object' || Array.isArray(payout)) throw new Error('mercadopago_payout_notice_invalid');
  const payoutData = payout as Record<string, unknown>;
  const providerBatchId = payoutData.id;
  const providerTransactionId = payload.id;
  const externalReference = payload.external_reference;
  const providerStatus = payload.status;
  const lastUpdated = payload.last_updated_date;
  if (typeof providerBatchId !== 'string' || !providerIdPattern.test(providerBatchId)
    || typeof providerTransactionId !== 'string' || !providerIdPattern.test(providerTransactionId)
    || typeof externalReference !== 'string' || !referencePattern.test(externalReference)
    || typeof providerStatus !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(providerStatus)
    || typeof lastUpdated !== 'string' || lastUpdated.length < 1 || lastUpdated.length > 100
    || (payoutData.external_reference !== undefined && payoutData.external_reference !== externalReference)) {
    throw new Error('mercadopago_payout_notice_invalid');
  }
  const statusDetail = typeof payload.status_detail === 'string' ? payload.status_detail : '';
  const identity = [providerBatchId, providerTransactionId, externalReference, providerStatus, statusDetail, lastUpdated].join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  const eventId = 'mp-payout-' + [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return {
    providerBatchId,
    providerTransactionId,
    externalReference,
    eventType: `payout.${providerStatus.toLowerCase()}`,
    providerStatus,
    eventId,
  };
}


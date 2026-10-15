import type { CoreWithdrawalStatus } from './payment-provider.ts';

export type PixDestinationType = 'CPF' | 'CNPJ' | 'EMAIL' | 'PHONE' | 'EVP';
export type PixDestination = { key: string; keyType: PixDestinationType };

export type PayoutConnectorContext = {
  apiBaseUrl: string;
  credential: string;
  environment?: 'sandbox' | 'production';
  /** Ed25519 PKCS#8 PEM, required for Mercado Pago production payouts. */
  signingPrivateKeyPem?: string;
  notificationUrl?: string;
};

export type PixPayoutIntent = {
  amountCents: number;
  externalReference: string;
  /** Stable per-reservation key; reused only for provider idempotency. */
  idempotencyKey?: string;
  description: string;
  destination: PixDestination;
};

export type PixPayoutLookup = {
  providerTransactionId: string;
  providerBatchId?: string;
  amountCents: number;
  externalReference: string;
};

export type PixPayoutTransfer = {
  providerTransactionId: string;
  providerBatchId?: string;
  amountCents: number;
  externalReference: string;
  status: CoreWithdrawalStatus;
  providerStatus: string;
  failureCode?: string;
};

/**
 * Provider-neutral Pix OUT contract. Implementations must never retry an
 * ambiguous create request; resolve it with a read-only lookup first.
 */
export interface PixPayoutProviderAdapter {
  readonly adapterCode: string;
  readonly methods: readonly ['pix'];
  normalizeDestination(input: PixDestination): PixDestination;
  createTransfer(context: PayoutConnectorContext, intent: PixPayoutIntent): Promise<PixPayoutTransfer>;
  getTransfer(context: PayoutConnectorContext, lookup: PixPayoutLookup): Promise<PixPayoutTransfer>;
  getTransferById(
    context: PayoutConnectorContext,
    providerTransactionId: string,
    providerBatchId?: string,
    expected?: { amountCents: number; externalReference: string },
  ): Promise<PixPayoutTransfer>;
}

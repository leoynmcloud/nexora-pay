import {
  createAsaasPixTransfer,
  getAsaasPixTransfer,
  getAsaasPixTransferById,
  normalizeAsaasPixDestination,
} from './asaas-payouts.ts';
import {
  createMercadoPagoPixTransfer,
  getMercadoPagoPixTransfer,
  normalizeMercadoPagoPixDestination,
} from './mercadopago-payouts.ts';
import type { PixDestination, PixPayoutProviderAdapter } from './payout-provider.ts';

function normalizeDestination(input: PixDestination): PixDestination {
  const destination = normalizeAsaasPixDestination({
    pixAddressKey: input.key,
    pixAddressKeyType: input.keyType,
  });
  return { key: destination.pixAddressKey, keyType: destination.pixAddressKeyType };
}

const asaas: PixPayoutProviderAdapter = Object.freeze({
  adapterCode: 'asaas',
  methods: ['pix'] as const,
  normalizeDestination,
  createTransfer(context, intent) {
    const destination = normalizeDestination(intent.destination);
    return createAsaasPixTransfer({
      baseUrl: context.apiBaseUrl,
      apiKey: context.credential,
      amountCents: intent.amountCents,
      externalReference: intent.externalReference,
      description: intent.description,
      destination: { pixAddressKey: destination.key, pixAddressKeyType: destination.keyType },
    });
  },
  getTransfer(context, lookup) {
    return getAsaasPixTransfer({
      baseUrl: context.apiBaseUrl,
      apiKey: context.credential,
      providerTransactionId: lookup.providerTransactionId,
      amountCents: lookup.amountCents,
      externalReference: lookup.externalReference,
    });
  },
  getTransferById(context, providerTransactionId) {
    return getAsaasPixTransferById({
      baseUrl: context.apiBaseUrl,
      apiKey: context.credential,
      providerTransactionId,
    });
  },
});

const mercadopago: PixPayoutProviderAdapter = Object.freeze({
  adapterCode: 'mercadopago',
  methods: ['pix'] as const,
  normalizeDestination: normalizeMercadoPagoPixDestination,
  createTransfer(context, intent) {
    return createMercadoPagoPixTransfer(context, intent);
  },
  getTransfer(context, lookup) {
    return getMercadoPagoPixTransfer(context, lookup);
  },
  getTransferById(context, providerTransactionId, providerBatchId, expected) {
    if (!expected) throw new Error('mercadopago_payout_identity_required');
    return getMercadoPagoPixTransfer(context, {
      providerTransactionId,
      providerBatchId,
      amountCents: expected.amountCents,
      externalReference: expected.externalReference,
    });
  },
});

const adapters: Readonly<Record<string, PixPayoutProviderAdapter>> = Object.freeze({
  asaas,
  mercadopago,
});

/** Exact lookup only: unknown payout connectors are never treated as Asaas. */
export function payoutAdapterFor(adapterCode: unknown): PixPayoutProviderAdapter | null {
  if (typeof adapterCode !== 'string') return null;
  return adapters[adapterCode] || null;
}

export function payoutAdapterCatalog() {
  return Object.values(adapters).map(adapter => ({
    adapter_code: adapter.adapterCode,
    methods: [...adapter.methods],
  }));
}

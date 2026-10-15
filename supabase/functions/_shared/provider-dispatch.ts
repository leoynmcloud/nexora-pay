import { handleAsaasPaymentRequest } from './asaas-payments.ts';
import { handleMercadoPagoPaymentRequest } from './mercadopago-payments.ts';
import { providerAdapterRoute } from './provider-registry.ts';

type PaymentAdapterHandler = (request: Request, sandboxOnly: boolean) => Promise<Response>;

/** Concrete connectors are registered here; the public router stays provider-neutral. */
const handlers: Readonly<Record<string, PaymentAdapterHandler>> = Object.freeze({
  asaas: handleAsaasPaymentRequest,
  mercadopago: handleMercadoPagoPaymentRequest,
});

export async function dispatchPaymentRequest(providerCode: unknown, request: Request): Promise<Response | null> {
  const route = providerAdapterRoute(providerCode);
  if (!route) return null;
  const handler = handlers[route.adapter];
  if (!handler) return null;
  return handler(request, route.sandboxOnly);
}

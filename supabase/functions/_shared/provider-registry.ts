/**
 * Adapter registry for payment operations. Adding an acquirer here is not enough
 * to enable production: its adapter, credentials, webhook verification and
 * settlement tests must also be implemented and approved.
 */
export type ProviderAdapterRoute = {
  adapter: 'asaas' | 'mercadopago';
  sandboxOnly: boolean;
  methods: readonly ('pix' | 'credit_card' | 'debit_card' | 'apple_pay' | 'boleto')[];
  credentialSetup: 'asaas-admin' | 'central' | 'unsupported';
  payerRequirements: { email: 'required' | 'optional' };
  checkoutDomains: readonly string[];
};

const routes: Readonly<Record<string, ProviderAdapterRoute>> = Object.freeze({
  asaas_sandbox: { adapter: 'asaas', sandboxOnly: true, methods: ['pix'], credentialSetup: 'asaas-admin', payerRequirements: { email: 'optional' }, checkoutDomains: ['asaas.com', 'asaas.com.br'] },
  asaas_production: { adapter: 'asaas', sandboxOnly: false, methods: ['pix'], credentialSetup: 'asaas-admin', payerRequirements: { email: 'optional' }, checkoutDomains: ['asaas.com', 'asaas.com.br'] },
  mercadopago_sandbox: { adapter: 'mercadopago', sandboxOnly: true, methods: ['pix'], credentialSetup: 'central', payerRequirements: { email: 'required' }, checkoutDomains: ['mercadopago.com', 'mercadopago.com.br'] },
  mercadopago_production: { adapter: 'mercadopago', sandboxOnly: false, methods: ['pix', 'credit_card'], credentialSetup: 'central', payerRequirements: { email: 'required' }, checkoutDomains: ['mercadopago.com', 'mercadopago.com.br'] },
  mercadopago_leo_production: { adapter: 'mercadopago', sandboxOnly: false, methods: ['pix', 'credit_card'], credentialSetup: 'central', payerRequirements: { email: 'required' }, checkoutDomains: ['mercadopago.com', 'mercadopago.com.br'] },
});

export function providerAdapterRoute(acquirerCode: unknown): ProviderAdapterRoute | null {
  if (typeof acquirerCode !== 'string') return null;
  return routes[acquirerCode] || null;
}

export function registeredProviderCodes(): string[] {
  return Object.keys(routes);
}

export function providerAdapterCatalog() {
  return Object.entries(routes).map(([code, route]) => ({
    code,
    adapter: route.adapter,
    methods: [...route.methods],
    credential_setup: route.credentialSetup,
    implementation_status: 'implemented' as const,
    operational_status: route.sandboxOnly ? 'sandbox_only' as const : 'not_homologated' as const,
  }));
}

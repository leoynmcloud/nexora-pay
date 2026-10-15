import { providerAdapterRoute, type ProviderAdapterRoute } from './provider-registry.ts';

/**
 * Hosted checkout reuses the central provider registry so a provider cannot
 * appear in one payment surface and silently be omitted from another.
 * Provider-specific request/response details remain inside each adapter.
 */
export type HostedCheckoutAdapter = ProviderAdapterRoute['adapter'];

export function hostedCheckoutAdapter(providerCode: unknown): HostedCheckoutAdapter | null {
  if (typeof providerCode !== 'string') return null;
  const route = providerAdapterRoute(providerCode);
  if (!route || route.sandboxOnly || !route.methods.includes('pix')) return null;
  return route.adapter;
}

export function hostedCheckoutPayerRequirements(providerCode: unknown) {
  if (typeof providerCode !== 'string') return null;
  const route = providerAdapterRoute(providerCode);
  if (!route || route.sandboxOnly || !route.methods.includes('pix')) return null;
  return { email_required: route.payerRequirements.email === 'required' };
}

export function hostedCheckoutMethods(providerCode: unknown): ('pix' | 'credit_card')[] {
  if (typeof providerCode !== 'string') return [];
  const route = providerAdapterRoute(providerCode);
  if (!route || route.sandboxOnly || !route.methods.includes('pix')) return [];
  return route.methods.filter((m): m is 'pix' | 'credit_card' => m === 'pix' || m === 'credit_card');
}

export function hostedCheckoutDomains(providerCode: unknown): string[] {
  if (typeof providerCode !== 'string') return [];
  const route = providerAdapterRoute(providerCode);
  if (!route || route.sandboxOnly || !route.methods.includes('pix')) return [];
  return [...route.checkoutDomains];
}

export function isHostedCheckoutUrlTrusted(providerCode: unknown, value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const domains = hostedCheckoutDomains(providerCode);
  return domains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))
    ? url.toString() : null;
}

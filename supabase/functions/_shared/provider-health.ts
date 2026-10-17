export type ProviderHealthStatus = 'ONLINE' | 'DEGRADED' | 'OFFLINE' | 'UNKNOWN';

export type ProviderHealthResult = {
  status: ProviderHealthStatus;
  latencyMs: number | null;
  httpStatus: number | null;
  errorCode: string | null;
};

/** Returns only fixed official health endpoints; never derives a probe URL from user data. */
export function providerHealthEndpoint(
  adapter: unknown, code: unknown, environment: unknown, apiBaseUrl: unknown,
): string | null {
  if (adapter === 'asaas') {
    const configurations: Record<string, { code: string; base: string }> = {
      production: { code: 'asaas_production', base: 'https://api.asaas.com/v3' },
      sandbox: { code: 'asaas_sandbox', base: 'https://api-sandbox.asaas.com/v3' },
    };
    const config = typeof environment === 'string' ? configurations[environment] : undefined;
    return config && code === config.code && apiBaseUrl === config.base
      ? `${config.base}/myAccount/status/` : null;
  }
  if (adapter === 'mercadopago') {
    const expectedCode = environment === 'production' ? 'mercadopago_production'
      : environment === 'sandbox' ? 'mercadopago_sandbox' : null;
    return expectedCode && code === expectedCode && apiBaseUrl === 'https://api.mercadopago.com'
      ? 'https://api.mercadopago.com/users/me' : null;
  }
  if (adapter === 'pushinpay') {
    return environment === 'production' && code === 'pushinpay_production' && apiBaseUrl === 'https://api.pushinpay.com.br/api'
      ? 'https://api.pushinpay.com.br/api/transactions' : null;
  }
  if (adapter === 'orusprime') {
    return environment === 'production' && code === 'orusprime_production' && apiBaseUrl === 'https://app.orusprime.com.br/api/v1'
      ? 'https://app.orusprime.com.br/api/v1/gateway/transactions?id=health-check' : null;
  }
  return null;
}

/** Reduces a credential-safe probe result to a bounded operational snapshot. */
export function classifyProviderHealth(
  httpStatus: number | null,
  latencyMs: number | null,
  networkError = false,
  adapter?: string,
): ProviderHealthResult {
  const validLatency = Number.isSafeInteger(latencyMs) && Number(latencyMs) >= 0 && Number(latencyMs) <= 60_000
    ? Number(latencyMs) : null;
  if (httpStatus !== null && (!Number.isSafeInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) {
    throw new Error('Invalid provider health HTTP status');
  }
  if (networkError || httpStatus === null) {
    return { status: 'OFFLINE', latencyMs: validLatency, httpStatus: null, errorCode: 'network_unavailable' };
  }
  if ((httpStatus >= 200 && httpStatus < 300) || (adapter === 'orusprime' && httpStatus === 404)) {
    const slow = validLatency === null || validLatency > 2_000;
    const effectiveStatus = (adapter === 'orusprime' && httpStatus === 404) ? 200 : httpStatus;
    return { status: slow ? 'DEGRADED' : 'ONLINE', latencyMs: validLatency, httpStatus: effectiveStatus, errorCode: slow ? 'provider_slow' : null };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return { status: 'DEGRADED', latencyMs: validLatency, httpStatus, errorCode: 'credential_rejected' };
  }
  if (httpStatus === 429) {
    return { status: 'DEGRADED', latencyMs: validLatency, httpStatus, errorCode: 'provider_rate_limited' };
  }
  if (httpStatus >= 500) {
    return { status: 'OFFLINE', latencyMs: validLatency, httpStatus, errorCode: 'provider_server_error' };
  }
  return { status: 'DEGRADED', latencyMs: validLatency, httpStatus, errorCode: 'provider_probe_rejected' };
}


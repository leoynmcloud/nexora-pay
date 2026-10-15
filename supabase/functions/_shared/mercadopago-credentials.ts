const PROFILE_API = 'https://api.mercadolibre.com/users/me';

/** Validates an MP Access Token without retaining or returning account profile data. */
export async function validateMercadoPagoAccessToken(
  accessToken: string,
  expectedEnvironment: 'sandbox' | 'production',
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const environmentPrefix = expectedEnvironment === 'sandbox' ? 'TEST-' : 'APP_USR-';
  if (!accessToken || accessToken.length > 4000 || !accessToken.startsWith(environmentPrefix)
    || !/^(APP_USR-|TEST-)[A-Za-z0-9_-]+$/.test(accessToken)) {
    throw new Error('mercadopago_access_token_invalid');
  }
  let response: Response;
  try {
    response = await fetchImpl(PROFILE_API, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'NexoraPay/1.0 (credential validation)',
      },
    });
  } catch {
    throw new Error('mercadopago_validation_unavailable');
  }
  try {
    if (response.status === 401 || response.status === 403) throw new Error('mercadopago_access_token_rejected');
    if (!response.ok) throw new Error('mercadopago_validation_unavailable');
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

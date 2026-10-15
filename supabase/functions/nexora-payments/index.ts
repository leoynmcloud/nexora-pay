import { providerAdapterCatalog } from '../_shared/provider-registry.ts';
import { dispatchPaymentRequest } from '../_shared/provider-dispatch.ts';
import { readBoundedHttpBody } from '../_shared/bounded-http-body.ts';

function isAllowedOrigin(origin: string): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const host = url.hostname;
    if (host === 'nexorapay.me' || host.endsWith('.nexorapay.me')) return true;
    if (host === 'nexorapay-demo.vercel.app' || host.endsWith('.vercel.app')) return true;
    if (host === 'weblybuilds.com' || host.endsWith('.weblybuilds.com')) return true;
    if (host === 'localhost' || host === '127.0.0.1') return true;
  } catch (_) {}
  return false;
}

Deno.serve(async (request) => {
  const origin = request.headers.get('origin') || '';
  const cors = {
    'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? (origin || 'https://www.nexorapay.me') : 'https://www.nexorapay.me',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (origin && !isAllowedOrigin(origin)) return Response.json({ error: 'Origem não autorizada.' }, { status: 403, headers: cors });
  if (request.method !== 'POST') return Response.json({ error: 'Método não permitido.' }, { status: 405, headers: cors });
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > 12000) return Response.json({ error: 'Solicitação muito grande.' }, { status: 413, headers: cors });

  let input: Record<string, unknown>;
  try {
    const raw = await readBoundedHttpBody(request.clone(), 12_000);
    if (raw === null) return Response.json({ error: 'Solicitação muito grande.' }, { status: 413, headers: cors });
    input = JSON.parse(raw);
  } catch {
    return Response.json({ error: 'Solicitação inválida.' }, { status: 400, headers: cors });
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return Response.json({ error: 'Solicitação inválida.' }, { status: 400, headers: cors });

  if (input.action === 'catalog') return Response.json({ providers: providerAdapterCatalog() }, { headers: cors });

  const response = await dispatchPaymentRequest(input.provider_code, request);
  return response || Response.json({
    error: 'Este adquirente ainda não possui um adaptador de pagamento homologado. Nenhuma operação foi enviada.',
    code: 'PROVIDER_ADAPTER_UNAVAILABLE',
  }, { status: 501, headers: cors });
});

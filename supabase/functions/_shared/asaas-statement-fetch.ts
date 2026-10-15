import { collectAsaasStatementPages, type AsaasStatementPage } from './asaas-statement.ts';

export function assertClosedStatementDate(value: unknown, todayInSaoPaulo: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
    || value >= todayInSaoPaulo) throw new Error('statement_date_not_closed');
  return value;
}

export async function fetchAsaasProductionStatement(
  apiKey: string,
  statementDate: string,
  fetcher: typeof fetch = fetch,
) {
  if (!apiKey.startsWith('$aact_prod_')) throw new Error('statement_credential_invalid');
  const pages: AsaasStatementPage[] = [];
  for (let pageNumber = 0; pageNumber < 50; pageNumber++) {
    const offset = pageNumber * 100;
    const query = new URLSearchParams({ startDate: statementDate, finishDate: statementDate,
      limit: '100', offset: String(offset), order: 'asc' });
    const response = await fetcher(`https://api.asaas.com/v3/financialTransactions?${query}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(12_000),
      headers: { Accept: 'application/json', access_token: apiKey, 'User-Agent': 'NexoraPay/1.0 (reconciliation)' },
    });
    if (!response.ok) throw new Error('statement_provider_unavailable');
    const body = await response.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || body.offset !== offset || body.limit !== 100
      || typeof body.hasMore !== 'boolean' || !Number.isSafeInteger(body.totalCount)
      || !Array.isArray(body.data)) throw new Error('statement_page_invalid');
    pages.push(body as AsaasStatementPage);
    if (!body.hasMore) break;
  }
  if (pages.length === 50 && pages[49].hasMore) throw new Error('statement_page_limit');
  const result = collectAsaasStatementPages(pages);
  if (!result.complete || result.lines.some(line => line.providerDate !== statementDate)) {
    throw new Error('statement_incomplete');
  }
  return result.lines;
}

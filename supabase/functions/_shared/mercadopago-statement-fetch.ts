import { normalizeMercadoPagoSettlementReport } from './mercadopago-statement.ts';
import { zonedDayWindowUtc } from './zoned-day-window.ts';

const API_BASE = 'https://api.mercadopago.com';
const MAX_JSON_BYTES = 512 * 1024;
const MAX_CSV_BYTES = 8 * 1024 * 1024;
const PAGE_SIZE = 500;
const MAX_REPORTS = 5_000;

async function boundedText(response: Response, maximum: number): Promise<string> {
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > maximum) throw new Error('statement_response_too_large');
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maximum) throw new Error('statement_response_too_large');
  return text;
}

async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await boundedText(response, MAX_JSON_BYTES);
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new Error('statement_report_response_invalid'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('statement_report_response_invalid');
  return body as Record<string, unknown>;
}

function exactReportWindow(report: Record<string, unknown>, begin: string, endInclusive: string): boolean {
  const reportBegin = typeof report.begin_date === 'string' ? Date.parse(report.begin_date) : NaN;
  const reportEnd = typeof report.end_date === 'string' ? Date.parse(report.end_date) : NaN;
  return Number.isFinite(reportBegin) && Number.isFinite(reportEnd)
    && reportBegin === Date.parse(begin) && reportEnd === Date.parse(endInclusive);
}

/** Fetches an already-generated, exact-window account-money report; never creates/reconfigures provider reports. */
export async function fetchMercadoPagoProductionStatement(
  accessToken: string,
  statementDate: string,
  fetcher: typeof fetch = fetch,
): Promise<ReturnType<typeof normalizeMercadoPagoSettlementReport>> {
  if (!/^APP_USR-[A-Za-z0-9_-]{8,}$/.test(accessToken) || accessToken.length > 4000) {
    throw new Error('statement_credential_invalid');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(statementDate)
    || new Date(`${statementDate}T00:00:00Z`).toISOString().slice(0, 10) !== statementDate) {
    throw new Error('statement_date_invalid');
  }
  const { start, end } = zonedDayWindowUtc(statementDate, 'America/Sao_Paulo');
  const beginDate = new Date(Date.parse(start)).toISOString();
  // The reporting API examples use second-precision inclusive end timestamps.
  const endDateInclusive = new Date(Date.parse(end) - 1_000).toISOString();
  const headers = { Accept: 'application/json', Authorization: `Bearer ${accessToken}`, 'User-Agent': 'NexoraPay/1.0 (reconciliation)' };
  const reports: Record<string, unknown>[] = [];
  let expectedTotal: number | null = null;

  for (let offset = 0; expectedTotal === null || offset < expectedTotal; offset += PAGE_SIZE) {
    if (offset >= MAX_REPORTS) throw new Error('statement_report_list_limit');
    const url = new URL(`${API_BASE}/v1/account/settlement_report/search`);
    url.searchParams.set('begin_date', beginDate);
    url.searchParams.set('end_date', endDateInclusive);
    url.searchParams.set('format', 'CSV');
    url.searchParams.set('limit', String(PAGE_SIZE));
    url.searchParams.set('offset', String(offset));
    let response: Response;
    try {
      response = await fetcher(url.toString(), {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(12_000), headers,
      });
    } catch { throw new Error('statement_report_list_unavailable'); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('statement_report_list_unavailable');
    }
    const body = await jsonResponse(response);
    const paging = body.paging && typeof body.paging === 'object' && !Array.isArray(body.paging)
      ? body.paging as Record<string, unknown> : null;
    const page = Array.isArray(body.results) ? body.results : null;
    const total = Number(paging?.total);
    if (!page || !Number.isSafeInteger(total) || total < 0 || total > MAX_REPORTS
      || Number(paging?.offset) !== offset || Number(paging?.limit) !== PAGE_SIZE
      || page.length > PAGE_SIZE || (expectedTotal !== null && expectedTotal !== total)
      || (page.length === 0 && offset < total)) throw new Error('statement_report_list_incomplete');
    expectedTotal = total;
    for (const item of page) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('statement_report_response_invalid');
      reports.push(item as Record<string, unknown>);
    }
    if (expectedTotal === 0) break;
  }

  const candidates = reports.filter(report => exactReportWindow(report, beginDate, endDateInclusive)
    && typeof report.file_name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.csv$/i.test(report.file_name));
  const distinctFiles = [...new Set(candidates.map(report => report.file_name as string))];
  if (distinctFiles.length === 0) throw new Error('statement_report_not_ready');
  if (distinctFiles.length !== 1) throw new Error('statement_report_ambiguous');

  const fileUrl = `${API_BASE}/v1/account/settlement_report/${encodeURIComponent(distinctFiles[0])}`;
  let fileResponse: Response;
  try {
    fileResponse = await fetcher(fileUrl, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'text/csv' },
    });
  } catch { throw new Error('statement_report_download_unavailable'); }
  if (!fileResponse.ok) {
    await fileResponse.body?.cancel().catch(() => undefined);
    throw new Error('statement_report_download_unavailable');
  }
  const csv = await boundedText(fileResponse, MAX_CSV_BYTES);
  return normalizeMercadoPagoSettlementReport(csv, statementDate);
}

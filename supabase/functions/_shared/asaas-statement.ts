import type { ProviderStatementLine } from './reconciliation-core.ts';

/** Parse only documented financial statement facts. Unknown types remain `other`.
 * Do not infer a merchant, settlement, or payment ID from amount/date proximity.
 */
export function normalizeAsaasStatementLine(input: unknown): ProviderStatementLine {
  if (!input || typeof input !== 'object') throw new Error('statement_entry_invalid');
  const row = input as Record<string, unknown>;
  const externalEntryId = typeof row.id === 'string' ? row.id.trim() : '';
  const providerEntryType = typeof row.type === 'string' ? row.type.trim() : '';
  const providerTransactionId = typeof row.paymentId === 'string' ? row.paymentId.trim() : '';
  const providerDate = typeof row.date === 'string' ? row.date : '';
  if (!externalEntryId || !providerEntryType || externalEntryId.length > 200
    || providerTransactionId.length > 200
    || !/^\d{4}-\d{2}-\d{2}$/.test(providerDate)
    || Number.isNaN(Date.parse(`${providerDate}T00:00:00Z`))
    || new Date(`${providerDate}T00:00:00Z`).toISOString().slice(0, 10) !== providerDate) {
    throw new Error('statement_entry_invalid');
  }

  // API values are decimal BRL amounts. Reject non-cent fractions rather than
  // rounding a financial fact into a different amount.
  const value = row.value;
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) {
    throw new Error('statement_amount_invalid');
  }
  const scaled = value * 100;
  const rounded = Math.round(Math.abs(scaled));
  if (!Number.isSafeInteger(rounded) || Math.abs(Math.abs(scaled) - rounded) > 1e-7) {
    throw new Error('statement_amount_invalid');
  }

  let kind: ProviderStatementLine['kind'] = 'other';
  if (providerEntryType === 'PAYMENT_RECEIVED') {
    if (value <= 0) throw new Error('statement_credit_sign_invalid');
    kind = 'payment_credit';
  } else if (providerEntryType === 'PAYMENT_FEE') {
    if (value >= 0) throw new Error('statement_fee_sign_invalid');
    kind = 'payment_fee';
  }
  return { externalEntryId, providerTransactionId, providerEntryType, providerDate, kind,
    direction: value > 0 ? 'credit' : 'debit', amountCents: rounded };
}

export type AsaasStatementPage = {
  offset: number;
  limit: number;
  totalCount: number;
  hasMore: boolean;
  data: unknown[];
};

/** An incomplete or inconsistent page sequence must never be reconciled. */
export function collectAsaasStatementPages(pages: readonly AsaasStatementPage[]): {
  complete: boolean;
  lines: ProviderStatementLine[];
} {
  const lines: ProviderStatementLine[] = [];
  let nextOffset = 0;
  let expectedTotal: number | null = null;
  const ids = new Set<string>();
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    if (!Number.isSafeInteger(page.offset) || page.offset !== nextOffset
      || !Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100
      || !Number.isSafeInteger(page.totalCount) || page.totalCount < 0
      || typeof page.hasMore !== 'boolean'
      || !Array.isArray(page.data) || page.data.length > page.limit
      || (expectedTotal !== null && page.totalCount !== expectedTotal)
      || (page.hasMore && page.data.length !== page.limit)
      || (index < pages.length - 1 && !page.hasMore)) {
      throw new Error('statement_pagination_invalid');
    }
    expectedTotal = page.totalCount;
    for (const raw of page.data) {
      const line = normalizeAsaasStatementLine(raw);
      if (ids.has(line.externalEntryId)) throw new Error('statement_entry_duplicate');
      ids.add(line.externalEntryId);
      lines.push(line);
    }
    nextOffset += page.data.length;
  }
  const complete = pages.length > 0 && pages[pages.length - 1].hasMore === false
    && lines.length === expectedTotal;
  return { complete, lines };
}

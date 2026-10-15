import type { ProviderStatementLine } from './reconciliation-core.ts';

const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const MAX_REPORT_ROWS = 50_000;

function parseCsv(text: string): string[][] {
  if (new TextEncoder().encode(text).byteLength > MAX_REPORT_BYTES) throw new Error('statement_too_large');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field.length === 0) quoted = true;
    else if (char === ';') { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++;
      row.push(field); field = '';
      if (row.some(value => value.length > 0)) rows.push(row);
      row = [];
      if (rows.length > MAX_REPORT_ROWS + 1) throw new Error('statement_row_limit');
    } else field += char;
  }
  if (quoted) throw new Error('statement_csv_invalid');
  row.push(field);
  if (row.some(value => value.length > 0)) rows.push(row);
  if (rows.length > MAX_REPORT_ROWS + 1) throw new Error('statement_row_limit');
  return rows;
}

function decimalToCents(value: string, required = true): number | null {
  const normalized = value.trim();
  if (!normalized && !required) return null;
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(normalized)) throw new Error('statement_amount_invalid');
  const negative = normalized.startsWith('-');
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [whole, fraction = ''] = unsigned.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new Error('statement_amount_invalid');
  return negative ? -cents : cents;
}

function localDate(value: string): string {
  const time = Date.parse(value);
  if (!value || !Number.isFinite(time)) throw new Error('statement_date_invalid');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(time));
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const date = `${fields.year}-${fields.month}-${fields.day}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('statement_date_invalid');
  return date;
}

const REQUIRED_COLUMNS = [
  'SOURCE_ID', 'PAYMENT_METHOD_TYPE', 'PAYMENT_METHOD', 'TRANSACTION_TYPE',
  'TRANSACTION_AMOUNT', 'TRANSACTION_CURRENCY', 'TRANSACTION_DATE', 'FEE_AMOUNT',
  'SETTLEMENT_NET_AMOUNT', 'SETTLEMENT_CURRENCY', 'SETTLEMENT_DATE',
] as const;

/**
 * Normalize the Mercado Pago account-money CSV into the provider-neutral
 * reconciliation contract. Unknown operations remain adverse `other` lines.
 * Only BRL Pix SETTLEMENT rows with verified gross/fee/net arithmetic can be
 * treated as a payment credit.
 */
export function normalizeMercadoPagoSettlementReport(csv: string, expectedDate: string): ProviderStatementLine[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expectedDate)
    || new Date(`${expectedDate}T00:00:00Z`).toISOString().slice(0, 10) !== expectedDate) {
    throw new Error('statement_date_invalid');
  }
  const records = parseCsv(csv.replace(/^\uFEFF/, ''));
  if (!records.length) throw new Error('statement_csv_empty');
  const header = records[0].map(value => value.trim());
  const indexByName = new Map(header.map((name, index) => [name, index]));
  if (new Set(header).size !== header.length || REQUIRED_COLUMNS.some(name => !indexByName.has(name))) {
    throw new Error('statement_columns_invalid');
  }
  const rows: ProviderStatementLine[] = [];
  const ids = new Set<string>();
  const value = (record: string[], name: string) => record[indexByName.get(name)!]?.trim() ?? '';
  const add = (line: ProviderStatementLine) => {
    if (ids.has(line.externalEntryId)) throw new Error('statement_entry_duplicate');
    ids.add(line.externalEntryId);
    rows.push(line);
  };

  for (let rowIndex = 1; rowIndex < records.length; rowIndex++) {
    const record = records[rowIndex];
    if (record.length !== header.length) throw new Error('statement_csv_invalid');
    const sourceId = value(record, 'SOURCE_ID');
    const type = value(record, 'TRANSACTION_TYPE').toUpperCase();
    const transactionDate = localDate(value(record, 'TRANSACTION_DATE'));
    const settlementRaw = value(record, 'SETTLEMENT_DATE');
    const occurredOn = settlementRaw ? localDate(settlementRaw) : transactionDate;
    const methodType = value(record, 'PAYMENT_METHOD_TYPE').toLowerCase();
    const method = value(record, 'PAYMENT_METHOD').toLowerCase();
    const isPix = method === 'pix' || (methodType === 'bank_transfer' && method.includes('pix'));
    const transactionCents = decimalToCents(value(record, 'TRANSACTION_AMOUNT'))!;
    const settlementNetCents = decimalToCents(value(record, 'SETTLEMENT_NET_AMOUNT'))!;
    const currency = value(record, 'TRANSACTION_CURRENCY').toUpperCase();
    const settlementCurrency = value(record, 'SETTLEMENT_CURRENCY').toUpperCase();
    const base = {
      providerTransactionId: sourceId,
      providerEntryType: type || 'UNKNOWN',
      providerDate: occurredOn,
    };

    if (type === 'SETTLEMENT' && isPix && sourceId && (currency !== 'BRL' || settlementCurrency !== 'BRL')) {
      throw new Error('statement_currency_unsupported');
    }
    if (type === 'SETTLEMENT' && isPix && sourceId && currency === 'BRL' && settlementCurrency === 'BRL') {
      const feeCents = decimalToCents(value(record, 'FEE_AMOUNT'))!;
      if (occurredOn !== expectedDate) throw new Error('statement_date_mismatch');
      if (transactionCents <= 0 || feeCents > 0 || settlementNetCents < 0
        || transactionCents + feeCents !== settlementNetCents) {
        throw new Error('statement_financial_identity_mismatch');
      }
      add({ ...base, externalEntryId: `mp:${sourceId}:settlement:credit`, kind: 'payment_credit',
        direction: 'credit', amountCents: transactionCents });
      if (feeCents < 0) add({ ...base, externalEntryId: `mp:${sourceId}:settlement:fee`, kind: 'payment_fee',
        direction: 'debit', amountCents: Math.abs(feeCents) });
    } else {
      if (occurredOn !== expectedDate) throw new Error('statement_date_mismatch');
      if (!sourceId) {
        // Preserve unlinked provider activity as adverse evidence, with a deterministic row identity.
        add({ ...base, externalEntryId: `mp:unlinked:${rowIndex}`, kind: 'other', direction: 'debit',
          amountCents: Math.abs(settlementNetCents) });
      } else {
        add({ ...base, externalEntryId: `mp:${sourceId}:${type || 'unknown'}:${rowIndex}`, kind: 'other',
          direction: settlementNetCents < 0 ? 'debit' : 'credit', amountCents: Math.abs(settlementNetCents) });
      }
    }
  }
  return rows;
}

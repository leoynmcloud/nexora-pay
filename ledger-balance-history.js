(function (root, factory) {
  'use strict';
  const model = factory();
  if (typeof module === 'object' && module.exports) module.exports = model;
  else root.NexoraLedgerBalanceHistory = model;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';

  const buckets = ['available', 'pending', 'reserved', 'blocked'];

  function daysForRange(range, now = new Date()) {
    const fixed = { 'Últimos 7 dias': 7, 'Último mês': 30, 'Últimos 6 meses': 180 };
    if (fixed[range]) return fixed[range];
    if (range !== 'Este ano' || Number.isNaN(now.getTime())) return 180;
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now).reduce((result, part) => {
      if (part.type !== 'literal') result[part.type] = Number(part.value);
      return result;
    }, {});
    const today = Date.UTC(parts.year, parts.month - 1, parts.day);
    const start = Date.UTC(parts.year, 0, 1);
    return Math.max(1, Math.floor((today - start) / 86400000) + 1);
  }

  function normalize(rows) {
    if (!Array.isArray(rows)) return null;
    const normalized = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object' || !/^\d{4}-\d{2}-\d{2}$/.test(String(row.day || ''))) return null;
      const date = new Date(`${row.day}T12:00:00Z`);
      if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== row.day) return null;
      const cents = {};
      for (const bucket of buckets) {
        const raw = row[bucket];
        if ((typeof raw !== 'number' && typeof raw !== 'string') || (typeof raw === 'string' && !raw.trim())) return null;
        const value = Number(raw);
        const amount = Math.round(value * 100);
        if (!Number.isFinite(value) || !Number.isSafeInteger(amount)) return null;
        cents[bucket] = amount;
      }
      const total = buckets.reduce((sum, bucket) => sum + cents[bucket], 0);
      if (!Number.isSafeInteger(total)) return null;
      normalized.push({ day: row.day, ...cents, total });
    }
    normalized.sort((left, right) => left.day.localeCompare(right.day));
    if (normalized.some((row, index) => index > 0 && normalized[index - 1].day === row.day)) return null;
    return normalized;
  }

  return { normalize, daysForRange, buckets: [...buckets] };
});

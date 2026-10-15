const utcDate = (value: string): number => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('invalid_calendar_date');
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error('invalid_calendar_date');
  }
  return timestamp;
};

function localDateAt(timestamp: number, timeZone: string): string {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

/**
 * Find the exact UTC half-open interval for a calendar day in an IANA zone.
 * Searching the localized date boundary handles historical DST transitions,
 * including days whose local midnight was skipped or repeated.
 */
function firstInstantOfLocalDate(date: string, timeZone: string): number {
  const anchor = utcDate(date);
  let low = anchor - 48 * 60 * 60 * 1000;
  let high = anchor + 48 * 60 * 60 * 1000;
  if (localDateAt(low, timeZone) >= date || localDateAt(high, timeZone) < date) {
    throw new Error('timezone_day_boundary_unavailable');
  }
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (localDateAt(middle, timeZone) < date) low = middle;
    else high = middle;
  }
  if (localDateAt(high, timeZone) !== date) throw new Error('timezone_day_boundary_unavailable');
  return high;
}

export function zonedDayWindowUtc(date: string, timeZone: string): { start: string; end: string } {
  const nextDay = new Date(utcDate(date) + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const start = firstInstantOfLocalDate(date, timeZone);
  const end = firstInstantOfLocalDate(nextDay, timeZone);
  if (end <= start) throw new Error('timezone_day_window_invalid');
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

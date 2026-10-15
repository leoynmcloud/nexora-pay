import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { zonedDayWindowUtc } from './zoned-day-window.ts';

describe('IANA-zone calendar day windows', () => {
  it('uses the current São Paulo offset and a half-open 24-hour interval', () => {
    assert.deepEqual(zonedDayWindowUtc('2026-10-10', 'America/Sao_Paulo'), {
      start: '2026-10-10T03:00:00.000Z', end: '2026-10-11T03:00:00.000Z',
    });
  });

  it('handles the 23-hour São Paulo day when daylight saving began at midnight', () => {
    assert.deepEqual(zonedDayWindowUtc('2018-11-04', 'America/Sao_Paulo'), {
      start: '2018-11-04T03:00:00.000Z', end: '2018-11-05T02:00:00.000Z',
    });
  });

  it('rejects impossible calendar dates', () => {
    assert.throws(() => zonedDayWindowUtc('2026-02-30', 'America/Sao_Paulo'), /invalid_calendar_date/);
  });
});

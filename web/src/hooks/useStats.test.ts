import { describe, it, expect } from 'vitest';
import { creditsInPeriod, periodStart, type WhCredit } from './useStats';

// The server built the response at this instant; every window counts back from it.
const at = '2026-09-15T12:00:00.000Z';

const credit = (id: string, hoursAgo: number): WhCredit => ({
  connectionId: id,
  creditedAt:   new Date(Date.parse(at) - hoursAgo * 3600e3).toISOString(),
  whType: 'N944', fromSystem: 'J123456', toSystem: 'Jita', fromClass: 'C3', toClass: null,
  mapName: 'Home', role: 'both', partnerName: null,
});

describe('periodStart', () => {
  it('counts back from when the server built the response, not from now', () => {
    expect(periodStart('day',  at)).toBe(Date.parse(at) - 24 * 3600e3);
    expect(periodStart('week', at)).toBe(Date.parse(at) - 7 * 24 * 3600e3);
    expect(periodStart('forever', at)).toBe(-Infinity);
  });
});

describe('creditsInPeriod', () => {
  // Newest first, as the server lists them: 1 h, 30 h and 10 days ago.
  const credits = [credit('a', 1), credit('b', 30), credit('c', 24 * 10)];
  const ids = (period: 'day' | 'week' | 'month' | 'year' | 'forever', truncated = false) =>
    creditsInPeriod({ credits, creditsTruncated: truncated, generatedAt: at }, period).rows.map((c) => c.connectionId);

  it('keeps the credits inside the window', () => {
    expect(ids('day')).toEqual(['a']);
    expect(ids('week')).toEqual(['a', 'b']);
    expect(ids('month')).toEqual(['a', 'b', 'c']);
    expect(ids('forever')).toEqual(['a', 'b', 'c']);
  });

  it('includes a credit sitting exactly on the boundary, like the server card does', () => {
    const edge = { credits: [credit('edge', 24)], creditsTruncated: false, generatedAt: at };
    expect(creditsInPeriod(edge, 'day').rows).toHaveLength(1);
  });

  it('flags a period as incomplete only when the cut-off list still reaches into it', () => {
    const cut = { credits, creditsTruncated: true, generatedAt: at };
    // Oldest listed row is 10 days old: nothing behind the cut can be within 24 h.
    expect(creditsInPeriod(cut, 'day').incomplete).toBe(false);
    // ...but it is inside 30 days, so older rows for that window may be missing.
    expect(creditsInPeriod(cut, 'month').incomplete).toBe(true);
    expect(creditsInPeriod(cut, 'forever').incomplete).toBe(true);
    expect(creditsInPeriod({ ...cut, creditsTruncated: false }, 'forever').incomplete).toBe(false);
    expect(creditsInPeriod(cut, 'month').listed).toBe(3);
  });

  it('handles an empty list', () => {
    const none = { credits: [], creditsTruncated: false, generatedAt: at };
    expect(creditsInPeriod(none, 'forever')).toEqual({ rows: [], incomplete: false, listed: 0 });
  });
});

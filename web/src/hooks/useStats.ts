import { useEffect, useState } from 'react';
import { api } from '../api/client';

export type StatPeriod = 'forever' | 'year' | 'month' | 'week' | 'day';

export interface SigBreakdown {
  total:    number;
  data:     number;
  relic:    number;
  gas:      number;
  ore:      number;
  combat:   number;
  wormhole: number;
  /** Ghost sites. Only counted since they became their own type — before
   *  that they were scanned as data sites and stay counted as such. */
  ghost:    number;
  unknown:  number;
}

export interface PeriodStats {
  jumps:      number;
  signatures: SigBreakdown;
  /** Wormhole credits with halves: 1 per hole you both jumped and typed, 0.5 per role otherwise. */
  wormholes:  number;
}

/** Chart bucket granularity for a period's activity series. */
export type BucketUnit = 'hour' | 'day' | 'month';

export interface ActivitySeries {
  /** Bucket size: hourly (24h), daily (week/month), monthly (year/all-time). */
  unit:   BucketUnit;
  /** Sig counts per bucket, oldest first, current bucket last. */
  values: number[];
}

export type CreditRole = 'both' | 'jumper' | 'typer';

/** One credited wormhole, as GET /api/stats lists them: newest first, capped. */
export interface WhCredit {
  connectionId: string;
  creditedAt:   string;
  whType:       string;
  fromSystem:   string | null;
  toSystem:     string | null;
  fromClass:    string | null;
  toClass:      string | null;
  mapName:      string | null;
  /** 'both' = you jumped it and named it (one credit); otherwise the half that was yours. */
  role:         CreditRole;
  /** The pilot who did the other half of a split credit. Null when both halves are yours or their account is gone. */
  partnerName:  string | null;
}

export type StatsResponse = Record<StatPeriod, PeriodStats> & {
  /** One activity series per period, at that period's own granularity. */
  series: Record<StatPeriod, ActivitySeries>;
  /** Your credited wormholes, newest first. Filter per period with creditsInPeriod. */
  credits: WhCredit[];
  /** True when older credits exist beyond the ones listed. */
  creditsTruncated: boolean;
  /** When the server computed the figures; every period window counts back from here. */
  generatedAt: string;
};

const PERIOD_MS: Record<StatPeriod, number | null> = {
  day:     24 * 3600e3,
  week:    7   * 24 * 3600e3,
  month:   30  * 24 * 3600e3,
  year:    365 * 24 * 3600e3,
  forever: null,
};

/** Start of a period's window in ms since epoch, counted back from when the
 *  server built the response so the list agrees with the cards. -Infinity for all time. */
export function periodStart(period: StatPeriod, generatedAt: string): number {
  const ms = PERIOD_MS[period];
  return ms === null ? -Infinity : new Date(generatedAt).getTime() - ms;
}

/** The credits that fall in a period, and whether older ones for that period
 *  may be missing because the server capped the list. */
export function creditsInPeriod(
  stats: Pick<StatsResponse, 'credits' | 'creditsTruncated' | 'generatedAt'>,
  period: StatPeriod,
): { rows: WhCredit[]; incomplete: boolean; listed: number } {
  const since = periodStart(period, stats.generatedAt);
  const rows = stats.credits.filter((c) => new Date(c.creditedAt).getTime() >= since);
  // The list was cut off and its oldest row is still inside the window: the
  // rows behind the cut could belong to this period too.
  const oldest = stats.credits[stats.credits.length - 1];
  const incomplete = stats.creditsTruncated && oldest !== undefined && new Date(oldest.creditedAt).getTime() >= since;
  return { rows, incomplete, listed: stats.credits.length };
}

export function useStats(open: boolean) {
  const [stats, setStats]     = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    // Deliberate: clears this pane's own state when the record it shows changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    api<StatsResponse>('/api/stats')
      .then(setStats)
      .catch(() => setError('Could not load stats'))
      .finally(() => setLoading(false));
  }, [open]);

  return { stats, loading, error };
}

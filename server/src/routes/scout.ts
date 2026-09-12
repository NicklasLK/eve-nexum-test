import { Router } from 'express';
import { optionalAuth } from '../middleware/optionalAuth.js';
import { createLogger } from '../utils/logger.js';
import { TtlValue, cachedJsonHandler } from '../utils/cache.js';

const router = Router();
router.use(optionalAuth);
const log = createLogger('scout');

export interface ScoutConnection {
  id:             string;
  whType:         string;
  maxShipSize:    string;
  expiresAt:      string;
  remainingHours: number;
  outSystemId:    number;
  outSystemName:  string;
  outSignature:   string;
  inSystemId:     number;
  inSystemName:   string;
  inSystemClass:  string | null;
  inRegionId:     number;
  inRegionName:   string;
  inSignature:    string;
  whExitsOutward: boolean;
}

interface RawScoutEntry {
  id:                 string;
  wh_type:            string;
  max_ship_size:      string;
  expires_at:         string;
  remaining_hours:    number;
  signature_type:     string;
  out_system_id:      number;
  out_system_name:    string;
  out_signature:      string;
  in_system_id:       number;
  in_system_name:     string;
  in_system_class:    string | null;
  in_region_id:       number;
  in_region_name:     string;
  in_signature:       string;
  wh_exits_outward:   boolean;
  completed:          boolean;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — eve-scout updates frequently
const cache = new TtlValue<ScoutConnection[]>(CACHE_TTL_MS);

const SCOUT_URL        = 'https://api.eve-scout.com/v2/public/signatures';
const SCOUT_TIMEOUT_MS = 15_000;
// eve-scout asks API consumers to identify themselves; a blank UA is also the
// first thing a CDN front door drops.
const SCOUT_USER_AGENT = 'Eve-Nexum (self-hosted; +https://github.com/GQuantrill/eve-nexum)';

async function fetchAndBuild(): Promise<ScoutConnection[]> {
  let res: Response;
  try {
    res = await fetch(SCOUT_URL, {
      signal:  AbortSignal.timeout(SCOUT_TIMEOUT_MS),
      headers: { 'User-Agent': SCOUT_USER_AGENT, Accept: 'application/json' },
    });
  } catch (err) {
    // undici reports every transport failure as "TypeError: fetch failed" and
    // buries the reason (ENOTFOUND, ECONNRESET, a TLS error, the connect
    // timeout…) in `cause`, which the logger's Error → "Name: message"
    // reduction drops. Rethrow with the reason in the message so the log line
    // says what actually went wrong.
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const why   = cause?.code ?? cause?.message ?? (err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    throw new Error(`eve-scout unreachable (${why})`);
  }
  if (!res.ok) throw new Error(`eve-scout ${res.status}`);
  const list = await res.json() as RawScoutEntry[];
  const out = list
    .filter(r => r.signature_type === 'wormhole')
    .map(r => ({
      id:             r.id,
      whType:         r.wh_type,
      maxShipSize:    r.max_ship_size,
      expiresAt:      r.expires_at,
      remainingHours: r.remaining_hours,
      outSystemId:    r.out_system_id,
      outSystemName:  r.out_system_name,
      outSignature:   r.out_signature,
      inSystemId:     r.in_system_id,
      inSystemName:   r.in_system_name,
      inSystemClass:  r.in_system_class,
      inRegionId:     r.in_region_id,
      inRegionName:   r.in_region_name,
      inSignature:    r.in_signature,
      whExitsOutward: r.wh_exits_outward,
    }));
  // Once per cache refresh (5 min) — a positive signal that the Thera/Turnur
  // feed is flowing, so an operator can tell "working" from "silently empty".
  log.info(`loaded ${out.length} Thera/Turnur connections from eve-scout`);
  return out;
}

router.get('/', cachedJsonHandler(cache, fetchAndBuild, {
  log, logMsg: 'Scout fetch failed:', errorMsg: 'Failed to fetch scout signatures',
}));

// Programmatic accessor sharing the same TTL cache as the route above — so the
// route planner can splice Thera/Turnur edges into the graph without a second
// eve-scout fetch. Falls back to stale data (or []) on a fetch error.
export async function getScoutConnections(): Promise<ScoutConnection[]> {
  const fresh = cache.get();
  if (fresh) return fresh;
  try {
    const data = await fetchAndBuild();
    cache.set(data);
    return data;
  } catch (err) {
    log.error('Scout fetch failed:', err);
    return cache.getStale() ?? [];
  }
}

export default router;

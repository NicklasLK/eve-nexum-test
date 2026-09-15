import { Router } from 'express';
import type { Request } from 'express';
import { optionalAuth } from '../middleware/optionalAuth.js';
import { createLogger } from '../utils/logger.js';
import { TtlValue } from '../utils/cache.js';
import { db } from '../db.js';
import { config } from '../config.js';

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
  /** Flagged collapsed by this requester's scope. Absent on the shared feed. */
  expired?:       boolean;
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

// EVE_SCOUT_URL lets a deployment point at a relay of the public feed (same JSON
// shape) when its host cannot reach api.eve-scout.com directly.
const SCOUT_URL        = (process.env.EVE_SCOUT_URL ?? '').trim() || 'https://api.eve-scout.com/v2/public/signatures';
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

// The listing carries each connection's flag for this requester, so the panes
// can mark it without a second call. The feed itself stays in one shared cache —
// the flags are the only per-requester part.
router.get('/', async (req, res) => {
  try {
    const conns  = await getScoutConnections();
    const flags  = await expiredScoutIds(req);
    res.json(conns.map(c => (flags.has(c.id) ? { ...c, expired: true } : c)));
  } catch (err) {
    log.error('Scout fetch failed:', err);
    res.status(502).json({ error: 'Failed to fetch scout signatures' });
  }
});

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

// ── Expired flags ────────────────────────────────────────────────────────────
// eve-scout keeps listing a hole until someone reports it gone, so a collapsed
// one still routes and sends people on a wasted trip. Flagging it drops it from
// the graph.

/** Player corps start here; an NPC rookie corp is not an organisation. */
const MIN_PLAYER_CORP_ID = 2_000_000;

export type FlagScope = { kind: 'user' | 'corp' | 'alliance'; id: number };

/**
 * Who a flag applies to: the alliance or corp on an org install, otherwise the
 * user alone. Never the whole deployment — on a public instance that would let
 * any user degrade everyone else's routing. Any member may flag, not just an
 * admin: spotting a dead hole is the whole point, and it's reversible.
 */
export function resolveScoutScope(req: Request): FlagScope | null {
  const userId = req.session.userId;
  if (!userId) return null;
  const allianceId = req.session.userAllianceId ?? null;
  const corpId     = req.session.userCorpId ?? null;
  if (config.allianceMode && allianceId != null) return { kind: 'alliance', id: allianceId };
  if (config.corpMode && corpId != null && corpId >= MIN_PLAYER_CORP_ID) return { kind: 'corp', id: corpId };
  return { kind: 'user', id: userId };
}

/** The scout connection ids this requester treats as dead. */
export async function expiredScoutIds(req: Request): Promise<Set<string>> {
  const scope = resolveScoutScope(req);
  if (!scope) return new Set();
  const { rows } = await db.query<{ connection_id: string }>(
    `SELECT connection_id FROM scout_expired WHERE scope_kind = $1 AND scope_id = $2`,
    [scope.kind, scope.id],
  );
  return new Set(rows.map(r => r.connection_id));
}

// A flag outlives the hole it describes and nothing reads it once the hole has
// left the feed. Swept opportunistically rather than on a timer: the longest a
// wormhole lives is well under this.
const FLAG_TTL_HOURS = 48;
function pruneExpiredFlags(): void {
  db.query(`DELETE FROM scout_expired WHERE created_at < NOW() - INTERVAL '${FLAG_TTL_HOURS} hours'`)
    .catch(err => log.warn(`scout flag prune failed: ${(err as Error).message}`));
}

router.put('/:id/expired', async (req, res) => {
  const scope = resolveScoutScope(req);
  if (!scope) { res.status(401).json({ error: 'Not authenticated' }); return; }
  const id = String(req.params.id);
  // Only flag a hole the feed actually knows about, so a bad id can't
  // accumulate rows.
  const known = (await getScoutConnections()).some(c => c.id === id);
  if (!known) { res.status(404).json({ error: 'Unknown connection' }); return; }
  await db.query(
    `INSERT INTO scout_expired (connection_id, scope_kind, scope_id, flagged_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (connection_id, scope_kind, scope_id) DO NOTHING`,
    [id, scope.kind, scope.id, req.session.userId ?? null],
  );
  pruneExpiredFlags();
  res.json({ ok: true, expired: true, scope: scope.kind });
});

router.delete('/:id/expired', async (req, res) => {
  const scope = resolveScoutScope(req);
  if (!scope) { res.status(401).json({ error: 'Not authenticated' }); return; }
  await db.query(
    `DELETE FROM scout_expired WHERE connection_id = $1 AND scope_kind = $2 AND scope_id = $3`,
    [String(req.params.id), scope.kind, scope.id],
  );
  res.json({ ok: true, expired: false, scope: scope.kind });
});

export default router;

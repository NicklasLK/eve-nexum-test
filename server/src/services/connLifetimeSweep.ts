import { db } from '../db.js';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { publishToMap } from './mapEvents.js';
import { effectiveExpiryMs, lifeBucket, type TimeBucket } from '../data/whLifetimes.js';
import { applyCollapseAction, parseCollapseAction, publishCollapse } from './deadConnections.js';

const log = createLogger('connLifetimeSweep');

interface Row {
  id:                string;
  mapId:             string;
  timeStatus:        string | null;
  whType:            string | null;
  eolAt:             Date | null;
  lifetimeExpiresAt: Date | null;
  createdAt:         Date;
  broken:            boolean;
  sourceId:          string;
  targetId:          string;
  sourceSignatureId: string | null;
  targetSignatureId: string | null;
  lazyRemove:        boolean;
  graceHours:        number;
  collapseAction:    string;
}

export type LifetimeAction =
  | { kind: 'none' }
  | { kind: 'rebucket'; bucket: TimeBucket }
  | { kind: 'collapse' };

/**
 * Decide what the sweep should do with one connection (pure, so it's unit
 * tested without a DB):
 *   - unknown lifetime → nothing;
 *   - expired for longer than the grace period on a lazy-removal map → collapse
 *     (drop its backing sigs, then the map's collapse action — a dead hole has
 *     no sig on the scanner);
 *   - already broken → nothing else; its label is moot. It is only a candidate
 *     at all so a map that removes dead holes can still take it once its own
 *     life has run out (the sig sweep or orphan quarantine got there first);
 *   - otherwise re-bucket if the stored status has drifted from the live one.
 * Collapse takes priority over re-bucketing so an over-grace hole doesn't first
 * get stamped 'expired' only to be severed the same tick.
 */
export function connLifetimeAction(
  row: Pick<Row, 'timeStatus' | 'whType' | 'eolAt' | 'lifetimeExpiresAt' | 'createdAt' | 'lazyRemove'> & { broken?: boolean },
  now: number,
  graceMs: number,
): LifetimeAction {
  const expiry = effectiveExpiryMs(row);
  if (expiry === null) return { kind: 'none' };
  if (row.lazyRemove && now - expiry > graceMs) return { kind: 'collapse' };
  if (row.broken) return { kind: 'none' };
  const bucket = lifeBucket(expiry - now);
  return bucket === row.timeStatus ? { kind: 'none' } : { kind: 'rebucket', bucket };
}

/**
 * Collapse one map's over-grace connections in a transaction: delete the
 * wormhole sigs backing them, apply the map's collapse action (mark broken /
 * delete / delete + prune the cut-off branch), then broadcast so open clients
 * drop the sigs and render the result live.
 */
async function collapseMap(mapId: string, conns: Row[]): Promise<void> {
  const connIds = conns.map((c) => c.id);
  const sigIds = conns.flatMap((c) => [c.sourceSignatureId, c.targetSignatureId]).filter((x): x is string => !!x);
  // One map, one setting: every row carries the same value.
  const action = parseCollapseAction(conns[0]?.collapseAction);
  const client = await db.connect();
  let result;
  try {
    await client.query('BEGIN');
    if (sigIds.length) await client.query(`DELETE FROM map_signatures WHERE id = ANY($1::uuid[])`, [sigIds]);
    result = await applyCollapseAction(client, mapId, connIds, action);
    await client.query(`UPDATE maps SET updated_at = NOW() WHERE id = $1`, [mapId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    log.warn(`collapse failed for map ${mapId}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  } finally {
    client.release();
  }

  // A pruned system is gone — announcing its sigs changed would only make
  // clients re-fetch something that no longer exists.
  const removedSystems = new Set(result.removedSystemIds);
  const affectedSystems = new Set(conns.flatMap((c) => [c.sourceId, c.targetId]).filter((id) => !removedSystems.has(id)));
  for (const systemId of affectedSystems) publishToMap(mapId, { type: 'sig.changed', actor: null, systemId });
  publishCollapse(mapId, result);
  log.info(`map ${mapId}: collapsed ${connIds.length} expired connection(s) [${action}], removed ${sigIds.length} sig(s)`
    + (action === 'break' ? '' : `, deleted ${result.removedConnIds.length} connection(s), ${result.removedSystemIds.length} system(s)`));
}

/**
 * One sweep pass: for every standard wormhole connection with a determinable
 * lifetime, either re-bucket its stored time_status (all maps) or — once it has
 * been expired past the grace period on a lazy-removal map — collapse it. Purely
 * display/state work: re-bucketing never deletes; collapse mirrors a real hole
 * dying (sig gone, connection severed) and only fires where the map opted in.
 *
 * The prefilter keeps the candidate set to holes with a determinable lifetime
 * (a manual/legacy timestamp, or any typed hole — K162 decays against the 48h
 * ceiling). Untyped connections have no computable expiry and are skipped in JS.
 * Broken holes are only fetched on maps whose collapse action deletes, so an
 * already-quarantined hole is still removed once its own life runs out.
 */
export async function sweepConnLifetimes(): Promise<void> {
  let rows: Row[];
  try {
    const res = await db.query<Row>(
      `SELECT c.id, c.map_id AS "mapId", c.time_status AS "timeStatus", c.wh_type AS "whType",
              c.eol_at AS "eolAt", c.lifetime_expires_at AS "lifetimeExpiresAt", c.created_at AS "createdAt",
              c.broken, c.source_id AS "sourceId", c.target_id AS "targetId",
              c.source_signature_id AS "sourceSignatureId", c.target_signature_id AS "targetSignatureId",
              m.lazy_remove_wormholes AS "lazyRemove", m.collapse_grace_hours AS "graceHours",
              m.collapse_action AS "collapseAction"
         FROM map_connections c
         JOIN maps m ON m.id = c.map_id
        WHERE c.connection_type = 'standard'
          AND (c.broken = FALSE OR (m.lazy_remove_wormholes = TRUE AND m.collapse_action <> 'break'))
          AND (c.lifetime_expires_at IS NOT NULL
            OR c.eol_at IS NOT NULL
            OR (c.wh_type IS NOT NULL AND c.wh_type <> ''))`,
    );
    rows = res.rows;
  } catch (err) {
    log.warn(`candidate query failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const now = Date.now();
  // Re-bucket updates grouped by their new bucket (one UPDATE per bucket value);
  // collapses grouped by map (one transaction per map).
  const changedByBucket = new Map<TimeBucket, string[]>();
  const rebucketed: { id: string; mapId: string; bucket: TimeBucket }[] = [];
  const collapseByMap = new Map<string, Row[]>();

  for (const r of rows) {
    // Grace is per-map (map settings). Each connection carries its map's value.
    const action = connLifetimeAction(r, now, r.graceHours * 3_600_000);
    if (action.kind === 'collapse') {
      const list = collapseByMap.get(r.mapId);
      if (list) list.push(r); else collapseByMap.set(r.mapId, [r]);
    } else if (action.kind === 'rebucket') {
      const list = changedByBucket.get(action.bucket);
      if (list) list.push(r.id); else changedByBucket.set(action.bucket, [r.id]);
      rebucketed.push({ id: r.id, mapId: r.mapId, bucket: action.bucket });
    }
  }

  if (rebucketed.length > 0) {
    try {
      for (const [bucket, ids] of changedByBucket) {
        await db.query(`UPDATE map_connections SET time_status = $1 WHERE id = ANY($2::uuid[])`, [bucket, ids]);
      }
      const rebucketMaps = new Set(rebucketed.map((c) => c.mapId));
      for (const mapId of rebucketMaps) {
        await db.query(`UPDATE maps SET updated_at = NOW() WHERE id = $1`, [mapId]).catch(() => {});
      }
      for (const c of rebucketed) {
        publishToMap(c.mapId, { type: 'connection.update', actor: null, id: c.id, updates: { timeStatus: c.bucket } });
      }
      log.info(`re-bucketed ${rebucketed.length} connection(s) across ${rebucketMaps.size} map(s)`);
    } catch (err) {
      log.warn(`bucket update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const [mapId, conns] of collapseByMap) {
    await collapseMap(mapId, conns);
  }
}

/**
 * Start the periodic connection-lifetime sweep. Cadence is
 * config.connLifetimeSweepMinutes (env CONN_LIFETIME_SWEEP_MINUTES, default 60);
 * 0 disables it. First pass runs shortly after boot.
 */
export function startConnLifetimeSweeper(): void {
  const mins = config.connLifetimeSweepMinutes;
  if (mins <= 0) { log.info('connection-lifetime sweep disabled (CONN_LIFETIME_SWEEP_MINUTES=0)'); return; }
  log.info(`connection-lifetime sweep enabled (every ${mins} min)`);
  setTimeout(() => { void sweepConnLifetimes(); }, 90_000);
  setInterval(() => { void sweepConnLifetimes(); }, mins * 60_000);
}

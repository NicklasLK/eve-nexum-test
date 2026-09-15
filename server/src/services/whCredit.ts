// Wormhole credits (plans/wh-scan-bounties.md): one row per hole, written the
// moment its connection is known to be jump-made AND to carry a real wormhole
// code. Jumper = the pilot whose tracked crossing drew the link; typer = the
// pilot who first named the code (on the origin sig, or on the connection
// itself). The row outlives the hole, so the monthly report can count it long
// after the connection is gone. Nothing about ISK lives here.
import { db } from '../db.js';
import { getWormholeSpecs } from '../routes/wormholes.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('whCredit');

export interface CreditConn {
  id: string; mapId: string; connectionType: string; createdVia: string;
  createdByUserId: number | null; whType: string | null; whTypeSetByUserId: number | null;
  sourceSystemId: string; targetSystemId: string;
  sourceEveId: number | null; targetEveId: number | null;
  sourceRegionId: number | null; targetRegionId: number | null;
  sourceSignatureId: string | null; targetSignatureId: string | null;
}

export interface CreditSig {
  id: string; systemId: string; sigType: string; whType: string; whTypeSetByUserId: number | null; fromMerge: boolean;
}

export interface Credit { jumperUserId: number; typerUserId: number; whType: string }

const code = (v: string | null | undefined) => (v ?? '').trim().toUpperCase();

/**
 * The sig that names this connection's code: a linked sig carrying it first,
 * else the one wormhole sig in either end system that carries it. Two or more
 * candidates is "don't know" — the caller falls back to the connection's own
 * typer rather than guess.
 */
export function originSig(conn: CreditConn, sigs: CreditSig[]): CreditSig | null {
  const want = code(conn.whType);
  const carries = (s: CreditSig) => s.sigType === 'wormhole' && code(s.whType) === want;
  const linked = sigs.find((s) => (s.id === conn.sourceSignatureId || s.id === conn.targetSignatureId) && carries(s));
  if (linked) return linked;
  const cands = sigs.filter((s) => !s.fromMerge && carries(s)
    && (s.systemId === conn.sourceSystemId || s.systemId === conn.targetSystemId));
  return cands.length === 1 ? cands[0] : null;
}

/** null = not (yet) creditable. Pure; see whCredit.test.ts. */
export function evaluate(
  conn: CreditConn, sigs: CreditSig[], knownCodes: Set<string>, excludedRegions: Set<number> = new Set(),
): Credit | null {
  if (conn.connectionType !== 'standard') return null;          // gates, bridges, cynos never count
  // Either end in an excluded region (Admin › Wormhole credits): never credited.
  if ((conn.sourceRegionId != null && excludedRegions.has(conn.sourceRegionId))
   || (conn.targetRegionId != null && excludedRegions.has(conn.targetRegionId))) return null;
  if (conn.createdVia !== 'jump' || conn.createdByUserId == null) return null;
  const c = code(conn.whType);
  if (!c || c === 'K162' || !knownCodes.has(c)) return null;    // K162 only says "far side"
  const typer = originSig(conn, sigs)?.whTypeSetByUserId ?? conn.whTypeSetByUserId ?? null;
  if (typer == null) return null;
  return { jumperUserId: conn.createdByUserId, typerUserId: typer, whType: c };
}

async function loadConn(mapId: string, connectionId: string): Promise<CreditConn | null> {
  const { rows } = await db.query<CreditConn>(
    `SELECT c.id, c.map_id AS "mapId", c.connection_type AS "connectionType", c.created_via AS "createdVia",
            c.created_by_user_id AS "createdByUserId", c.wh_type AS "whType", c.wh_type_set_by_user_id AS "whTypeSetByUserId",
            c.source_id AS "sourceSystemId", c.target_id AS "targetSystemId",
            s.eve_system_id AS "sourceEveId", t.eve_system_id AS "targetEveId",
            ss.region_id AS "sourceRegionId", ts.region_id AS "targetRegionId",
            c.source_signature_id AS "sourceSignatureId", c.target_signature_id AS "targetSignatureId"
       FROM map_connections c
       JOIN map_systems s ON s.id = c.source_id
       JOIN map_systems t ON t.id = c.target_id
       LEFT JOIN solar_systems ss ON ss.id = s.eve_system_id
       LEFT JOIN solar_systems ts ON ts.id = t.eve_system_id
      WHERE c.id = $1 AND c.map_id = $2`,
    [connectionId, mapId],
  );
  return rows[0] ?? null;
}

async function loadWormholeSigs(systemIds: string[]): Promise<CreditSig[]> {
  const { rows } = await db.query<CreditSig>(
    `SELECT id, system_id AS "systemId", sig_type AS "sigType", wh_type AS "whType",
            wh_type_set_by_user_id AS "whTypeSetByUserId", from_merge AS "fromMerge"
       FROM map_signatures WHERE system_id = ANY($1::uuid[]) AND sig_type = 'wormhole'`,
    [systemIds],
  );
  return rows;
}

async function loadExcludedRegions(): Promise<Set<number>> {
  const { rows } = await db.query<{ id: number }>(`SELECT region_id AS id FROM wh_credit_excluded_regions`);
  return new Set(rows.map((r) => r.id));
}

let knownCodes: Set<string> | null = null;
async function loadKnownCodes(): Promise<Set<string>> {
  if (knownCodes) return knownCodes;
  knownCodes = new Set(Object.keys(await getWormholeSpecs()).map((k) => k.toUpperCase()));
  return knownCodes;
}

/**
 * Credit one connection if it qualifies. Idempotent: the connection id is the
 * primary key, and the same system pair on the same map within 24 h is
 * refused, so delete-and-redraw earns nothing. Returns whether a row was written.
 */
export async function creditConnection(mapId: string, connectionId: string): Promise<boolean> {
  const conn = await loadConn(mapId, connectionId);
  if (!conn || conn.createdVia !== 'jump' || conn.connectionType !== 'standard' || !code(conn.whType)) return false;
  const sigs = await loadWormholeSigs([conn.sourceSystemId, conn.targetSystemId]);
  const credit = evaluate(conn, sigs, await loadKnownCodes(), await loadExcludedRegions());
  if (!credit) return false;
  const { rowCount } = await db.query(
    `INSERT INTO wh_credits (connection_id, map_id, jumper_user_id, typer_user_id, wh_type, from_eve_system_id, to_eve_system_id)
     SELECT $1, $2, $3, $4, $5, $6::int, $7::int
      WHERE NOT EXISTS (
        SELECT 1 FROM wh_credits w
         WHERE w.map_id = $2 AND w.connection_id <> $1
           AND LEAST(w.from_eve_system_id, w.to_eve_system_id)    = LEAST($6::int, $7::int)
           AND GREATEST(w.from_eve_system_id, w.to_eve_system_id) = GREATEST($6::int, $7::int)
           AND w.credited_at > NOW() - INTERVAL '24 hours')
     ON CONFLICT (connection_id) DO NOTHING`,
    [conn.id, conn.mapId, credit.jumperUserId, credit.typerUserId, credit.whType, conn.sourceEveId, conn.targetEveId],
  );
  if (rowCount) {
    log.info(`credited ${credit.whType} on map ${conn.mapId}: jumper ${credit.jumperUserId}, typer ${credit.typerUserId}`);
  }
  return (rowCount ?? 0) > 0;
}

/** Fire-and-forget for the write paths. */
export function creditSoon(mapId: string, connectionId: string): void {
  void creditConnection(mapId, connectionId).catch((err) => log.error('credit failed:', err));
}

/** Catch anything a trigger missed: recent jump-made, typed, uncredited connections. */
export async function sweepCredits(): Promise<number> {
  const { rows } = await db.query<{ id: string; mapId: string }>(
    `SELECT c.id, c.map_id AS "mapId"
       FROM map_connections c
       LEFT JOIN wh_credits w ON w.connection_id = c.id
      WHERE w.connection_id IS NULL
        AND c.created_via = 'jump' AND c.connection_type = 'standard'
        AND COALESCE(c.wh_type, '') <> '' AND UPPER(c.wh_type) <> 'K162'
        AND c.created_at > NOW() - INTERVAL '48 hours'`,
  );
  let n = 0;
  for (const r of rows) {
    try { if (await creditConnection(r.mapId, r.id)) n++; }
    catch (err) { log.error(`sweep: connection ${r.id} failed:`, err); }
  }
  if (n) log.info(`sweep credited ${n} connection(s)`);
  return n;
}

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;
export function startWhCreditSweeper(): void {
  if (timer) return;
  const tick = () => { void sweepCredits().catch((err) => log.error('sweep failed:', err)); };
  setTimeout(tick, 60 * 1000).unref();
  timer = setInterval(tick, SWEEP_INTERVAL_MS);
  timer.unref();
}

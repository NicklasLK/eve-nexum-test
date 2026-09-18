import type { PoolClient } from 'pg';
import { publishToMap } from './mapEvents.js';
import { presenceSnapshot } from './presence.js';

/**
 * What a lazy-removal map does with a wormhole connection once its lifetime has
 * run out past the collapse grace (maps.collapse_action):
 *   - 'break'      — mark it broken (quarantined) and keep it on the map, until whSweep's
 *                    stale-broken pass removes it (BROKEN_CONN_REMOVE_HOURS);
 *   - 'disconnect' — delete the connection, keep every system;
 *   - 'prune'      — delete the connection, then every system left without a
 *                    route back to home.
 * Only the max-life expiry paths honour this (connLifetimeSweep's collapse and
 * whSweep's aged-sig quarantine): a hole cannot outlive its type's maximum and
 * both clocks start after the hole actually spawned, so those are certain. The
 * orphan quarantine is a heuristic and always just breaks.
 */
export type CollapseAction = 'break' | 'disconnect' | 'prune';

export const COLLAPSE_ACTIONS: readonly CollapseAction[] = ['break', 'disconnect', 'prune'];

export function isCollapseAction(v: unknown): v is CollapseAction {
  return typeof v === 'string' && (COLLAPSE_ACTIONS as readonly string[]).includes(v);
}

/** The stored value, or 'break' for anything unrecognised — never escalate by accident. */
export function parseCollapseAction(v: unknown): CollapseAction {
  return isCollapseAction(v) ? v : 'break';
}

export interface PruneSystem { id: string; isHome: boolean; locked: boolean; eveSystemId: number | null }
export interface PruneLink   { sourceId: string; targetId: string }

/**
 * Systems left without a route back to home (pure). Mirrors the client's
 * "Remove Systems Cut Off From Home": every remaining connection counts as a
 * link — broken ones included, since "broken" means re-scout, not gone — and
 * home, locked systems and any system a map viewer is currently sitting in are
 * always kept. No home system → nothing is ever cut off.
 */
export function cutOffSystems(
  systems: PruneSystem[],
  links: PruneLink[],
  occupiedEveSystemIds: ReadonlySet<number>,
): string[] {
  const home = systems.find((s) => s.isHome);
  if (!home) return [];

  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const list = adj.get(a);
    if (list) list.push(b); else adj.set(a, [b]);
  };
  for (const l of links) { link(l.sourceId, l.targetId); link(l.targetId, l.sourceId); }

  const reached = new Set<string>([home.id]);
  const queue = [home.id];
  for (let i = 0; i < queue.length; i++) {
    for (const next of adj.get(queue[i]) ?? []) {
      if (reached.has(next)) continue;
      reached.add(next);
      queue.push(next);
    }
  }

  return systems
    .filter((s) => !reached.has(s.id) && !s.locked
      && !(s.eveSystemId != null && occupiedEveSystemIds.has(s.eveSystemId)))
    .map((s) => s.id);
}

export interface CollapseResult {
  brokenIds:        string[];
  removedConnIds:   string[];
  removedSystemIds: string[];
}

/**
 * Apply `action` to dead connections inside the caller's open transaction and
 * return what changed, so the caller can broadcast after COMMIT. Deleting a
 * system cascades its remaining connections and sigs in the DB, and the
 * client's system.remove handler drops them too, so only the system itself
 * needs announcing.
 */
export async function applyCollapseAction(
  client: PoolClient,
  mapId: string,
  connIds: string[],
  action: CollapseAction,
): Promise<CollapseResult> {
  const result: CollapseResult = { brokenIds: [], removedConnIds: [], removedSystemIds: [] };
  if (connIds.length === 0) return result;

  if (action === 'break') {
    await client.query(
      `UPDATE map_connections SET broken = TRUE, broken_at = NOW() WHERE map_id = $1 AND id = ANY($2::uuid[])`, [mapId, connIds]);
    result.brokenIds = connIds;
    return result;
  }

  const del = await client.query<{ id: string }>(
    `DELETE FROM map_connections WHERE map_id = $1 AND id = ANY($2::uuid[]) RETURNING id`, [mapId, connIds]);
  result.removedConnIds = del.rows.map((r) => r.id);
  if (action !== 'prune') return result;

  const sysRes = await client.query<PruneSystem>(
    `SELECT id, is_home AS "isHome", locked, eve_system_id AS "eveSystemId"
       FROM map_systems WHERE map_id = $1`, [mapId]);
  const linkRes = await client.query<PruneLink>(
    `SELECT source_id AS "sourceId", target_id AS "targetId" FROM map_connections WHERE map_id = $1`, [mapId]);
  const occupied = new Set<number>();
  for (const p of presenceSnapshot(mapId)) if (p.eveSystemId != null) occupied.add(p.eveSystemId);

  const cut = cutOffSystems(sysRes.rows, linkRes.rows, occupied);
  if (cut.length > 0) {
    await client.query(`DELETE FROM map_systems WHERE map_id = $1 AND id = ANY($2::uuid[])`, [mapId, cut]);
    result.removedSystemIds = cut;
  }
  return result;
}

/** Broadcast a collapse result to the map room. Server-originated → actor null. */
export function publishCollapse(mapId: string, result: CollapseResult): void {
  for (const id of result.brokenIds) {
    publishToMap(mapId, { type: 'connection.update', actor: null, id, updates: { broken: true } });
  }
  for (const id of result.removedConnIds)   publishToMap(mapId, { type: 'connection.remove', actor: null, id });
  for (const id of result.removedSystemIds) publishToMap(mapId, { type: 'system.remove',     actor: null, id });
}

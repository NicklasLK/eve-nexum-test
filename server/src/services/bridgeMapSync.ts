// Projects the shared Ansiblex table onto every alliance map as 'jumpgate'
// connections, so the gate network is on the map without anyone drawing it and
// stays true as gates are reinforced, run dry, move or die. Runs at the end of
// every structure-reader sync (hourly, or Sync now), after an admin edits a
// shared bridge, and after a bulk system add that may complete a pair.
//
// The rules live in planBridgeLinks (pure; see the test):
//   • Alliance maps only (maps.alliance_id set). Personal and corp maps are
//     never written to.
//   • A link is drawn for a bridge whose two systems are both on the map.
//     Systems are never added — seed the region first.
//   • Links the projection created carry jump_bridge_id, and only tagged links
//     are ever edited or removed. A hand-drawn 'jumpgate' between the same
//     pair is adopted (tagged) so it shows state; any other hand-drawn link on
//     the pair blocks the bridge and is left alone.
//   • `broken` follows bridgeLinkState: reinforced, service offline, or missing
//     from one sync → severed; switched off, missing twice, or deleted → gone.
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { publishToMap } from './mapEvents.js';
import { connectionTypeError } from './connectionRules.js';
import { bridgeLinkState, type BridgeStateRow } from './bridgeState.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('bridgeMapSync');

export interface ProjBridge extends BridgeStateRow { id: number; fromSystemId: number; toSystemId: number }
export interface ProjSystem { id: string; eveId: number }
export interface ProjLink {
  id: string; sourceId: string; targetId: string; connectionType: string; broken: boolean; jumpBridgeId: number | null;
}

export interface ProjPlan {
  insert:    { sourceId: string; targetId: string; sourceEveId: number; targetEveId: number; bridgeId: number; broken: boolean }[];
  adopt:     { linkId: string; bridgeId: number; broken: boolean }[];
  setBroken: { linkId: string; broken: boolean }[];
  remove:    string[];
  /** Bridges with an end that is not on this map. */
  offMap:    number;
  /** Bridges whose pair is already taken by a link that is not theirs. */
  blocked:   number;
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function planBridgeLinks(bridges: ProjBridge[], systems: ProjSystem[], links: ProjLink[]): ProjPlan {
  const plan: ProjPlan = { insert: [], adopt: [], setBroken: [], remove: [], offMap: 0, blocked: 0 };
  const sysByEve = new Map(systems.map((s) => [s.eveId, s.id]));

  // One link per pair: the projection's own first, then a hand-drawn jumpgate.
  const rank = (l: ProjLink) => (l.jumpBridgeId != null ? 2 : l.connectionType === 'jumpgate' ? 1 : 0);
  const linkByPair = new Map<string, ProjLink>();
  for (const l of links) {
    const k = pairKey(l.sourceId, l.targetId);
    const cur = linkByPair.get(k);
    if (!cur || rank(l) > rank(cur)) linkByPair.set(k, l);
  }
  const linkByBridge = new Map<number, ProjLink>();
  for (const l of links) if (l.jumpBridgeId != null && !linkByBridge.has(l.jumpBridgeId)) linkByBridge.set(l.jumpBridgeId, l);

  const wanted = new Set<number>();
  const remove = new Set<string>();
  for (const b of bridges) {
    const state = bridgeLinkState(b);
    if (state === 'absent') continue;
    const src = sysByEve.get(b.fromSystemId), tgt = sysByEve.get(b.toSystemId);
    if (!src || !tgt) { plan.offMap++; continue; }
    if (src === tgt) continue;
    const broken = state === 'broken';
    const key = pairKey(src, tgt);

    let link = linkByBridge.get(b.id);
    // A tagged link whose ends no longer match its bridge is stale: redraw it.
    if (link && pairKey(link.sourceId, link.targetId) !== key) { remove.add(link.id); link = undefined; }
    if (!link) {
      const onPair = linkByPair.get(key);
      if (onPair && onPair.jumpBridgeId == null && onPair.connectionType === 'jumpgate') {
        plan.adopt.push({ linkId: onPair.id, bridgeId: b.id, broken });
        wanted.add(b.id);
        continue;
      }
      if (onPair) { plan.blocked++; continue; }
      plan.insert.push({ sourceId: src, targetId: tgt, sourceEveId: b.fromSystemId, targetEveId: b.toSystemId, bridgeId: b.id, broken });
      wanted.add(b.id);
      continue;
    }
    wanted.add(b.id);
    if (link.broken !== broken) plan.setBroken.push({ linkId: link.id, broken });
  }
  // Tagged links whose bridge is gone, switched off, missing twice, or drawn
  // twice — never an untagged one.
  for (const l of links) {
    if (l.jumpBridgeId == null) continue;
    if (!wanted.has(l.jumpBridgeId) || linkByBridge.get(l.jumpBridgeId) !== l) remove.add(l.id);
  }
  plan.remove = [...remove];
  return plan;
}

interface MapRow { id: string; name: string }

/** Apply a plan to one map. Returns whether anything changed. */
async function applyPlan(map: MapRow, plan: ProjPlan): Promise<boolean> {
  // The same rule a hand-drawn jumpgate passes: both ends k-space. A rejected
  // pair (a mis-pasted manual bridge) is logged and skipped, never drawn.
  const inserts: ProjPlan['insert'] = [];
  for (const i of plan.insert) {
    const err = await connectionTypeError('jumpgate', { sourceEveId: i.sourceEveId, targetEveId: i.targetEveId });
    if (err) { log.warn(`map "${map.name}": bridge ${i.bridgeId} not drawn — ${err}`); continue; }
    inserts.push(i);
  }
  if (!inserts.length && !plan.adopt.length && !plan.setBroken.length && !plan.remove.length) return false;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (inserts.length) {
      const ph: string[] = []; const vals: unknown[] = [];
      for (const i of inserts) {
        const n = vals.length;
        ph.push(`($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}, 'jumpgate', 'large', $${n + 5}, $${n + 6})`);
        vals.push(randomUUID(), map.id, i.sourceId, i.targetId, i.broken, i.bridgeId);
      }
      await client.query(
        `INSERT INTO map_connections (id, map_id, source_id, target_id, connection_type, size, broken, jump_bridge_id)
         VALUES ${ph.join(', ')}`, vals,
      );
    }
    for (const a of plan.adopt) {
      await client.query(`UPDATE map_connections SET jump_bridge_id = $1, broken = $2 WHERE id = $3 AND map_id = $4`,
        [a.bridgeId, a.broken, a.linkId, map.id]);
    }
    for (const s of plan.setBroken) {
      await client.query(`UPDATE map_connections SET broken = $1 WHERE id = $2 AND map_id = $3 AND jump_bridge_id IS NOT NULL`,
        [s.broken, s.linkId, map.id]);
    }
    if (plan.remove.length) {
      await client.query(`DELETE FROM map_connections WHERE map_id = $1 AND id = ANY($2::uuid[]) AND jump_bridge_id IS NOT NULL`,
        [map.id, plan.remove]);
    }
    await client.query(`UPDATE maps SET updated_at = NOW() WHERE id = $1`, [map.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  // Bulk change: viewers re-fetch the map. No actor — nobody's echo to suppress.
  publishToMap(map.id, { type: 'map.resync', actor: null });
  log.info(
    `map "${map.name}": ${inserts.length} drawn, ${plan.adopt.length} adopted, ${plan.setBroken.length} state change(s), ${plan.remove.length} removed`
    + (plan.offMap ? `, ${plan.offMap} off-map` : '') + (plan.blocked ? `, ${plan.blocked} blocked` : ''),
  );
  return true;
}

async function runOnce(): Promise<void> {
  const { rows: maps } = await db.query<MapRow>(`SELECT id, name FROM maps WHERE alliance_id IS NOT NULL`);
  if (!maps.length) return;
  const { rows: bridges } = await db.query<ProjBridge>(
    `SELECT id, from_system_id AS "fromSystemId", to_system_id AS "toSystemId", active,
            missed_syncs AS "missedSyncs", esi_state AS "esiState", service_online AS "serviceOnline"
       FROM jump_bridges WHERE owner_id IS NULL`,
  );
  for (const map of maps) {
    try {
      const [{ rows: systems }, { rows: links }] = await Promise.all([
        db.query<ProjSystem>(
          `SELECT id, eve_system_id AS "eveId" FROM map_systems WHERE map_id = $1 AND eve_system_id IS NOT NULL`, [map.id]),
        db.query<ProjLink>(
          `SELECT id, source_id AS "sourceId", target_id AS "targetId", connection_type AS "connectionType",
                  broken, jump_bridge_id AS "jumpBridgeId"
             FROM map_connections WHERE map_id = $1`, [map.id]),
      ]);
      await applyPlan(map, planBridgeLinks(bridges, systems, links));
    } catch (err) {
      log.error(`map "${map.name}" projection failed:`, err);
    }
  }
}

let running: Promise<void> | null = null;
let rerun = false;

/** Project the shared bridges onto every alliance map. Calls made during a run coalesce into one more run. */
export function syncBridgesToAllianceMaps(): Promise<void> {
  if (running) { rerun = true; return running; }
  running = (async () => {
    do { rerun = false; await runOnce(); } while (rerun);
  })().finally(() => { running = null; });
  return running;
}

/** Fire-and-forget for mutation routes. */
export function projectBridgesSoon(): void {
  void syncBridgesToAllianceMaps().catch((err) => log.error('projection failed:', err));
}

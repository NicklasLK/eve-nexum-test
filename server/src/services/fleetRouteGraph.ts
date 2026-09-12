// Assembles the per-request graph for the fleet route planner: the static
// stargate graph (shared, read-only) plus every shortcut the caller enabled —
// Thera/Turnur scout holes, mapped wormholes, Ansiblex bridges (the
// jump_bridges table and hand-drawn 'jumpgate' map connections), and capital
// bridge edges fanned out from each standby bridge service.
import { db } from '../db.js';
import { getBaseGraph } from './routeGraph.js';
import { getScoutConnections } from '../routes/scout.js';
import { getJumpSystems } from './jumpGraph.js';
import { getWormholeSpecs } from '../routes/wormholes.js';
import { effectiveExpiryMs } from '../data/whLifetimes.js';
import {
  CAPITAL_RANGE_LY, LY_METRES, SIZE_MASS, addSpecial, isWspaceId,
  type FleetEdge, type FleetGraph, type FleetMethod, type MassStatus,
} from './fleetRoutes.js';

export interface FleetGraphSources {
  thera:       boolean;
  turnur:      boolean;
  wormholes:   boolean;
  jumpBridges: boolean;
  titan:       boolean;
  blops:       boolean;
  conduit:     boolean;
  /** Maps whose wormhole chains / drawn gates may be used. Caller authorises. */
  mapIds:      string[];
  /** Account whose personal bridges/services and exclusions apply (null = shared only). */
  ownerId:     number | null;
}

export interface FleetGraphSummary {
  scoutHoles:  number;
  wormholes:   number;
  bridges:     number;
  services:    number;
  capitalEdges: number;
}

export const SERVICE_METHOD: Record<'titan' | 'blops' | 'conduit', FleetMethod> = {
  titan: 'titan_bridge', blops: 'blops_bridge', conduit: 'carrier_conduit',
};
export const SERVICE_DEFAULT_RANGE: Record<'titan' | 'blops' | 'conduit', number> = {
  titan: CAPITAL_RANGE_LY.titan_bridge, blops: CAPITAL_RANGE_LY.blops_bridge, conduit: CAPITAL_RANGE_LY.carrier_conduit,
};

// Thera/Turnur ids by name, cached for the process (both are ordinary
// solar_systems rows). Falls back to the well-known ids if the lookup fails.
let hubIds: { thera: number; turnur: number } | null = null;
export async function getHubIds(): Promise<{ thera: number; turnur: number }> {
  if (hubIds) return hubIds;
  const { rows } = await db.query<{ id: number; name: string }>(
    `SELECT id, name FROM solar_systems WHERE name IN ('Thera', 'Turnur')`,
  );
  hubIds = {
    thera:  rows.find((r) => r.name === 'Thera')?.id  ?? 31000005,
    turnur: rows.find((r) => r.name === 'Turnur')?.id ?? 30002086,
  };
  return hubIds;
}

// Mass limits for a hole: the SDE spec for a known code, else the size label.
function massFor(specs: Record<string, { totalMass: number; maxJumpMass: number }>, whType: string | null | undefined, size: string | null | undefined) {
  const spec = whType ? specs[whType.toUpperCase()] : undefined;
  if (spec && spec.maxJumpMass > 0) return { jump: spec.maxJumpMass, stable: spec.totalMass };
  const s = size ? SIZE_MASS[size.toLowerCase()] : undefined;
  return s ? { jump: s.jump, stable: s.stable } : { jump: null, stable: null };
}

async function addScoutHoles(g: FleetGraph, src: FleetGraphSources, specs: Record<string, { totalMass: number; maxJumpMass: number }>): Promise<number> {
  const { thera, turnur } = await getHubIds();
  let n = 0;
  for (const c of await getScoutConnections()) {
    const isThera  = c.outSystemId === thera  || c.inSystemId === thera;
    const isTurnur = c.outSystemId === turnur || c.inSystemId === turnur;
    if (!isThera && !isTurnur) continue;
    if (isThera && !src.thera) continue;
    if (isTurnur && !src.turnur) continue;
    const m = massFor(specs, c.whType, c.maxShipSize);
    addSpecial(g, c.outSystemId, c.inSystemId, {
      method: 'wormhole', weight: 1, scout: true,
      whType: c.whType || null, maxShipSize: c.maxShipSize || null,
      massStatus: 'stable', timeStatus: c.remainingHours <= 4 ? 'eol' : 'stable',
      remainingHours: c.remainingHours, maxJumpMass: m.jump, maxStableMass: m.stable,
    });
    n++;
  }
  return n;
}

async function addMapWormholes(g: FleetGraph, mapIds: string[], specs: Record<string, { totalMass: number; maxJumpMass: number }>): Promise<number> {
  if (!mapIds.length) return 0;
  const { rows } = await db.query<{
    a: number; b: number; whType: string | null; massStatus: string | null; timeStatus: string | null;
    size: string | null; eolAt: string | null; lifetimeExpiresAt: string | null; createdAt: string;
  }>(
    `SELECT s.eve_system_id AS a, t.eve_system_id AS b, c.wh_type AS "whType",
            c.mass_status AS "massStatus", c.time_status AS "timeStatus", c.size,
            c.eol_at AS "eolAt", c.lifetime_expires_at AS "lifetimeExpiresAt", c.created_at AS "createdAt"
       FROM map_connections c
       JOIN map_systems s ON s.id = c.source_id
       JOIN map_systems t ON t.id = c.target_id
      WHERE c.map_id = ANY($1::uuid[])
        AND c.broken = FALSE
        AND c.connection_type = 'standard'
        AND s.eve_system_id IS NOT NULL
        AND t.eve_system_id IS NOT NULL`,
    [mapIds],
  );
  const seen = new Set<string>();
  let n = 0;
  for (const r of rows) {
    const key = r.a < r.b ? `${r.a}|${r.b}` : `${r.b}|${r.a}`;
    if (seen.has(key)) continue;   // the same hole drawn on two maps
    seen.add(key);
    const expiry = effectiveExpiryMs({ lifetimeExpiresAt: r.lifetimeExpiresAt, eolAt: r.eolAt, whType: r.whType, createdAt: r.createdAt });
    const remainingHours = expiry != null ? Math.max(0, (expiry - Date.now()) / 3_600_000) : null;
    const eol = r.timeStatus === 'eol' || (r.eolAt != null && new Date(r.eolAt).getTime() <= Date.now()) || (remainingHours != null && remainingHours <= 4);
    const massStatus: MassStatus = r.massStatus === 'critical' ? 'critical' : r.massStatus === 'destabilized' ? 'reduced' : 'stable';
    const m = massFor(specs, r.whType, r.size);
    addSpecial(g, r.a, r.b, {
      method: 'wormhole', weight: 1, whType: r.whType || null, maxShipSize: r.size,
      massStatus, timeStatus: eol ? 'eol' : 'stable', remainingHours,
      maxJumpMass: m.jump, maxStableMass: m.stable,
    });
    n++;
  }
  return n;
}

async function addJumpBridges(g: FleetGraph, mapIds: string[], ownerId: number | null): Promise<number> {
  const seen = new Set<string>();
  const pairKey = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  let n = 0;
  const { rows } = await db.query<{ id: number; a: number; b: number; name: string }>(
    `SELECT id, from_system_id AS a, to_system_id AS b, name
       FROM jump_bridges
      WHERE active AND missed_syncs < 2
        AND ((owner_id IS NULL AND NOT EXISTS (
                SELECT 1 FROM bridge_exclusions e
                 WHERE e.owner_id = $1 AND e.kind = 'bridge' AND e.target_id = jump_bridges.id))
             OR owner_id = $1)`,
    [ownerId],
  );
  for (const r of rows) {
    if (seen.has(pairKey(r.a, r.b))) continue;
    seen.add(pairKey(r.a, r.b));
    addSpecial(g, r.a, r.b, { method: 'jump_bridge', weight: 1, name: r.name || undefined, sourceId: r.id });
    n++;
  }
  // Hand-drawn Ansiblex connections on the maps the caller can see.
  if (mapIds.length) {
    const { rows: drawn } = await db.query<{ a: number; b: number }>(
      `SELECT s.eve_system_id AS a, t.eve_system_id AS b
         FROM map_connections c
         JOIN map_systems s ON s.id = c.source_id
         JOIN map_systems t ON t.id = c.target_id
        WHERE c.map_id = ANY($1::uuid[])
          AND c.broken = FALSE
          AND c.connection_type = 'jumpgate'
          AND s.eve_system_id IS NOT NULL
          AND t.eve_system_id IS NOT NULL`,
      [mapIds],
    );
    for (const r of drawn) {
      if (seen.has(pairKey(r.a, r.b))) continue;
      seen.add(pairKey(r.a, r.b));
      addSpecial(g, r.a, r.b, { method: 'jump_bridge', weight: 1 });
      n++;
    }
  }
  return n;
}

async function addCapitalServices(g: FleetGraph, src: FleetGraphSources): Promise<{ services: number; edges: number }> {
  const kinds: ('titan' | 'blops' | 'conduit')[] = [];
  if (src.titan)   kinds.push('titan');
  if (src.blops)   kinds.push('blops');
  if (src.conduit) kinds.push('conduit');
  if (!kinds.length) return { services: 0, edges: 0 };
  const { rows } = await db.query<{ id: number; systemId: number; kind: 'titan' | 'blops' | 'conduit'; rangeLy: string | null; name: string }>(
    `SELECT id, system_id AS "systemId", kind, range_ly AS "rangeLy", name
       FROM bridge_services
      WHERE active AND kind = ANY($2::text[])
        AND ((owner_id IS NULL AND NOT EXISTS (
                SELECT 1 FROM bridge_exclusions e
                 WHERE e.owner_id = $1 AND e.kind = 'service' AND e.target_id = bridge_services.id))
             OR owner_id = $1)`,
    [src.ownerId, kinds],
  );
  if (!rows.length) return { services: 0, edges: 0 };

  // A cyno cannot be lit in high-sec, so both ends must be low/null; the jump
  // graph is exactly that set (and already excludes Pochven).
  const jump = await getJumpSystems();
  const byId = new Map(jump.map((s) => [s.id, s]));
  let edges = 0;
  for (const svc of rows) {
    const from = byId.get(svc.systemId);
    if (!from) continue;
    const rangeLy = svc.rangeLy != null ? Number(svc.rangeLy) : SERVICE_DEFAULT_RANGE[svc.kind];
    const rangeM = rangeLy * LY_METRES;
    const method = SERVICE_METHOD[svc.kind];
    for (const to of jump) {
      if (to.id === from.id) continue;
      const d = Math.sqrt((from.x - to.x) ** 2 + (from.y - to.y) ** 2 + (from.z - to.z) ** 2);
      if (d > rangeM) continue;
      addSpecial(g, from.id, to.id, { method, weight: 1, distanceLy: d / LY_METRES, name: svc.name || undefined, sourceId: svc.id }, true);
      edges++;
    }
  }
  return { services: rows.length, edges };
}

// Name/security for every node the specials introduced that the stargate
// graph doesn't know (J-space, Thera).
async function fillMissingSystems(g: FleetGraph): Promise<void> {
  const missing = new Set<number>();
  for (const [from, edges] of g.special) {
    if (!g.systems.has(from)) missing.add(from);
    for (const e of edges) if (!g.systems.has(e.to)) missing.add(e.to);
  }
  if (!missing.size) return;
  const { rows } = await db.query<{ id: number; name: string; security: string }>(
    `SELECT id, name, security::text AS security FROM solar_systems WHERE id = ANY($1::int[])`,
    [[...missing]],
  );
  for (const r of rows) g.systems.set(r.id, { id: r.id, name: r.name, security: Number(r.security), wspace: isWspaceId(r.id) });
}

/** The graph for one planning request. Never mutates the shared stargate graph. */
export async function buildFleetGraph(src: FleetGraphSources): Promise<{ graph: FleetGraph; summary: FleetGraphSummary }> {
  const base = getBaseGraph();
  const systems = new Map<number, { id: number; name: string; security: number; wspace: boolean }>();
  for (const [id, info] of base.systemInfo) systems.set(id, { id, name: info.name, security: info.security, wspace: isWspaceId(id) });
  const g: FleetGraph = { gates: base.adjacency, special: new Map(), systems };
  const summary: FleetGraphSummary = { scoutHoles: 0, wormholes: 0, bridges: 0, services: 0, capitalEdges: 0 };

  const specs = (src.thera || src.turnur || src.wormholes) ? await getWormholeSpecs().catch(() => ({})) : {};
  if (src.thera || src.turnur) summary.scoutHoles = await addScoutHoles(g, src, specs);
  if (src.wormholes)           summary.wormholes  = await addMapWormholes(g, src.mapIds, specs);
  if (src.jumpBridges)         summary.bridges    = await addJumpBridges(g, src.mapIds, src.ownerId);
  const cap = await addCapitalServices(g, src);
  summary.services = cap.services; summary.capitalEdges = cap.edges;
  await fillMissingSystems(g);
  return { graph: g, summary };
}

/** Resolve a system by id or (case-insensitive) name. */
export async function resolveSystem(ref: unknown): Promise<{ id: number; name: string } | null> {
  if (typeof ref === 'number' && Number.isInteger(ref) && ref > 0) {
    const { rows } = await db.query<{ id: number; name: string }>(`SELECT id, name FROM solar_systems WHERE id = $1`, [ref]);
    return rows[0] ?? null;
  }
  if (typeof ref === 'string' && ref.trim()) {
    const s = ref.trim();
    if (/^\d+$/.test(s)) return resolveSystem(Number(s));
    const { rows } = await db.query<{ id: number; name: string }>(`SELECT id, name FROM solar_systems WHERE LOWER(name) = LOWER($1) LIMIT 1`, [s]);
    return rows[0] ?? null;
  }
  return null;
}

/** Bulk name → id map (lower-cased keys), for paste imports. */
export async function resolveSystemNames(names: string[]): Promise<Map<string, { id: number; name: string }>> {
  const out = new Map<string, { id: number; name: string }>();
  const wanted = [...new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))];
  if (!wanted.length) return out;
  const { rows } = await db.query<{ id: number; name: string }>(
    `SELECT id, name FROM solar_systems WHERE LOWER(name) = ANY($1::text[])`, [wanted],
  );
  for (const r of rows) out.set(r.name.toLowerCase(), r);
  return out;
}

export type { FleetEdge };

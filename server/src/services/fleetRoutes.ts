// Fleet route planner — a forbid-last-special-edge diversity search over the
// stargate graph plus every shortcut a fleet can take: Ansiblex jump bridges,
// mapped wormholes, Thera/Turnur scout holes, and capital bridges (titan /
// black ops / carrier conduit) from a standby system.
//
// Ported from the standalone route finder (app/services/pathfinder.py). This
// module is PURE — no DB, no ESI — so it can be unit-tested on hand-built
// graphs; fleetRouteGraph.ts assembles the real graph per request.
//
// Search outline (calculateRoutes):
//   1. Dijkstra with every enabled edge → shortest route.
//   2. Forbid the LAST special (non-stargate) edge of each route found so far
//      and search again → a naturally different alternative each round.
//   3. Always add a gates-only route, and — when capital bridges are on — run
//      the same search once more with capitals disabled so wormhole / bridge
//      routes are still explored instead of being drowned by titan variants.
//   4. Drop routes that use more capital hops than allowed, or a capital hop
//      for a leg that is fewer than minBridgeRange gates anyway.

export type FleetMethod =
  | 'stargate' | 'jump_bridge' | 'wormhole'
  | 'titan_bridge' | 'blops_bridge' | 'carrier_conduit';
export type MassStatus = 'stable' | 'reduced' | 'critical';
export type TimeStatus = 'stable' | 'eol';
export type SecurityLevel = 0 | 1 | 2;   // 0 = permit, 1 = avoid (penalise), 2 = exclude
export type ShipClass = 'frigate' | 'destroyer' | 'cruiser' | 'battlecruiser' | 'battleship' | 'capital';

// Typical hull masses (kg) used for wormhole capacity estimates.
export const SHIP_CLASS_MASS: Record<ShipClass, number> = {
  frigate:       1_200_000,
  destroyer:     1_800_000,
  cruiser:       12_000_000,
  battlecruiser: 15_000_000,
  battleship:    100_000_000,
  capital:       1_200_000_000,
};
const SHIP_CLASSES_DESC: ShipClass[] = ['capital', 'battleship', 'battlecruiser', 'cruiser', 'destroyer', 'frigate'];

// Fallback (maxJumpMass, maxStableMass) per wormhole size label, for holes
// whose type code is unknown (bare K162, scout feed). eve-scout's labels are
// small/medium/large/xlarge/capital; Nexum's map sizes are small/medium/large/xl.
export const SIZE_MASS: Record<string, { jump: number; stable: number }> = {
  small:   { jump: 5_000_000,     stable: 20_000_000 },
  medium:  { jump: 62_000_000,    stable: 500_000_000 },
  large:   { jump: 300_000_000,   stable: 2_000_000_000 },
  xl:      { jump: 1_350_000_000, stable: 3_000_000_000 },
  xlarge:  { jump: 1_350_000_000, stable: 3_000_000_000 },
  capital: { jump: 1_800_000_000, stable: 3_300_000_000 },
};

// Every hop costs one; "avoid" adds a flat penalty so avoided space is used
// only when nothing else reaches the destination.
export const AVOID_PENALTY = 100;
export const LY_METRES = 9.4607304725808e15;

export const CAPITAL_METHODS = new Set<FleetMethod>(['titan_bridge', 'blops_bridge', 'carrier_conduit']);
export const CAPITAL_RANGE_LY: Record<'titan_bridge' | 'blops_bridge' | 'carrier_conduit', number> = {
  titan_bridge:    6,
  blops_bridge:    8,
  carrier_conduit: 7,
};
// Jump fatigue: black ops bridges apply half the fatigue of a titan/conduit.
const FATIGUE_MULTIPLIER: Partial<Record<FleetMethod, number>> = {
  titan_bridge: 1.0, carrier_conduit: 1.0, blops_bridge: 0.5,
};
// Tie-break when several edges join the same pair: never silently upgrade a
// gate hop into a bridge during segment reconstruction.
const METHOD_PRIORITY: Record<FleetMethod, number> = {
  stargate: 0, jump_bridge: 1, wormhole: 2, carrier_conduit: 3, blops_bridge: 4, titan_bridge: 5,
};

export const THERA_ID  = 31000005;
export const TURNUR_ID = 30002086;

export interface FleetEdge {
  to:              number;
  method:          FleetMethod;
  weight:          number;
  whType?:         string | null;
  massStatus?:     MassStatus | null;
  timeStatus?:     TimeStatus | null;
  maxJumpMass?:    number | null;
  maxStableMass?:  number | null;
  remainingHours?: number | null;
  maxShipSize?:    string | null;
  distanceLy?:     number;      // capital hops only
  name?:           string;      // bridge / service label
  sourceId?:       number;      // jump_bridges.id / bridge_services.id when known
  scout?:          boolean;     // came from the eve-scout feed
}

export interface FleetSystem {
  id:       number;
  name:     string;
  security: number;
  wspace:   boolean;   // J-space / Thera: no autopilot, "wh" security bucket
}

export interface FleetGraph {
  gates:   Map<number, number[]>;       // stargate adjacency, both directions present
  special: Map<number, FleetEdge[]>;    // every other edge, directed
  systems: Map<number, FleetSystem>;
}

export interface FleetRouteOptions {
  useStargates:      boolean;
  useJumpBridges:    boolean;
  useWormholes:      boolean;
  includeThera:      boolean;
  includeTurnur:     boolean;
  useTitanBridge:    boolean;
  useBlopsBridge:    boolean;
  useCarrierConduit: boolean;
  avoidHighsec:      SecurityLevel;
  avoidLowsec:       SecurityLevel;
  avoidNullsec:      SecurityLevel;
  avoidWhSpace:      SecurityLevel;
  minBridgeRange:    number;   // capital hop must save at least this many gates
  maxBridges:        number;   // capital hops per route
  theraId:           number;
  turnurId:          number;
}

export function defaultFleetOptions(): FleetRouteOptions {
  return {
    useStargates: true, useJumpBridges: true, useWormholes: false,
    includeThera: true, includeTurnur: true,
    useTitanBridge: false, useBlopsBridge: false, useCarrierConduit: false,
    avoidHighsec: 0, avoidLowsec: 0, avoidNullsec: 0, avoidWhSpace: 0,
    minBridgeRange: 3, maxBridges: 2,
    theraId: THERA_ID, turnurId: TURNUR_ID,
  };
}

export interface FleetSegment {
  from:   number;
  to:     number;
  method: FleetMethod;
  edge:   FleetEdge;
}

export interface FleetRoute {
  id:             number;
  categories:     string[];
  totalJumps:     number;
  totalCost:      number;
  segments:       FleetSegment[];
  systems:        number[];
  fatigueMinutes: number;
}

// ── Graph helpers ────────────────────────────────────────────────────────────

export function emptyFleetGraph(): FleetGraph {
  return { gates: new Map(), special: new Map(), systems: new Map() };
}

export function addSystem(g: FleetGraph, s: FleetSystem): void { g.systems.set(s.id, s); }

export function isWspaceId(id: number): boolean { return id >= 31_000_000 && id < 32_000_000; }

/** A stargate between a and b (both directions). */
export function addGate(g: FleetGraph, a: number, b: number): void {
  for (const [x, y] of [[a, b], [b, a]] as const) {
    const list = g.gates.get(x);
    if (list) { if (!list.includes(y)) list.push(y); } else g.gates.set(x, [y]);
  }
}

/** A non-stargate edge a→b (and b→a unless oneWay). */
export function addSpecial(g: FleetGraph, a: number, b: number, edge: Omit<FleetEdge, 'to'>, oneWay = false): void {
  const pairs = oneWay ? [[a, b]] as const : [[a, b], [b, a]] as const;
  for (const [x, y] of pairs) {
    const list = g.special.get(x);
    const e: FleetEdge = { ...edge, to: y };
    if (list) list.push(e); else g.special.set(x, [e]);
  }
}

type SecBucket = 'hs' | 'ls' | 'ns' | 'wh';
// Same thresholds as the rest of Nexum (routeGraph, setup-db): true security
// ≥ 0.45 rounds to the 0.5 shown in-game and is high-sec.
export function secBucket(sys: FleetSystem): SecBucket {
  if (sys.wspace) return 'wh';
  if (sys.security >= 0.45) return 'hs';
  if (sys.security > 0) return 'ls';
  return 'ns';
}

const GATE_EDGE: Omit<FleetEdge, 'to'> = { method: 'stargate', weight: 1 };

function methodEnabled(method: FleetMethod, o: FleetRouteOptions): boolean {
  switch (method) {
    case 'stargate':        return o.useStargates;
    case 'jump_bridge':     return o.useJumpBridges;
    case 'wormhole':        return o.useWormholes;
    case 'titan_bridge':    return o.useTitanBridge;
    case 'blops_bridge':    return o.useBlopsBridge;
    case 'carrier_conduit': return o.useCarrierConduit;
  }
}

function edgeAllowed(g: FleetGraph, from: number, edge: FleetEdge, o: FleetRouteOptions): boolean {
  if (!methodEnabled(edge.method, o)) return false;
  // Thera / Turnur sub-toggles apply to wormhole hops only — Turnur is an
  // ordinary low-sec system, gate travel through it is always fine.
  if (edge.method === 'wormhole') {
    if (!o.includeThera  && (from === o.theraId  || edge.to === o.theraId))  return false;
    if (!o.includeTurnur && (from === o.turnurId || edge.to === o.turnurId)) return false;
  }
  const dest = g.systems.get(edge.to);
  if (dest) {
    const b = secBucket(dest);
    if (o.avoidHighsec === 2 && b === 'hs') return false;
    if (o.avoidLowsec  === 2 && b === 'ls') return false;
    if (o.avoidNullsec === 2 && b === 'ns') return false;
    if (o.avoidWhSpace === 2 && b === 'wh') return false;
  }
  return true;
}

function edgeCost(g: FleetGraph, edge: FleetEdge, o: FleetRouteOptions): number {
  let cost = edge.weight;
  const dest = g.systems.get(edge.to);
  if (dest) {
    const b = secBucket(dest);
    if      (o.avoidHighsec === 1 && b === 'hs') cost += AVOID_PENALTY;
    else if (o.avoidLowsec  === 1 && b === 'ls') cost += AVOID_PENALTY;
    else if (o.avoidNullsec === 1 && b === 'ns') cost += AVOID_PENALTY;
    else if (o.avoidWhSpace === 1 && b === 'wh') cost += AVOID_PENALTY;
  }
  return cost;
}

/** Every edge leaving `node`: synthesized stargate edges first, then specials. */
function* edgesFrom(g: FleetGraph, node: number): Generator<FleetEdge> {
  const gates = g.gates.get(node);
  if (gates) for (const to of gates) yield { ...GATE_EDGE, to };
  const specials = g.special.get(node);
  if (specials) yield* specials;
}

const forbidKey = (from: number, to: number, method: FleetMethod): string => `${from}|${to}|${method}`;

// ── Dijkstra ─────────────────────────────────────────────────────────────────

class MinHeap {
  private a: { cost: number; node: number }[] = [];
  get size(): number { return this.a.length; }
  push(cost: number, node: number): void {
    const a = this.a; a.push({ cost, node });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].cost <= a[i].cost) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop(): { cost: number; node: number } | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0]; const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l].cost < a[m].cost) m = l;
        if (r < a.length && a[r].cost < a[m].cost) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

/** Single shortest path (system ids) and its penalised cost, or null. */
export function dijkstra(
  g: FleetGraph, origin: number, destination: number, o: FleetRouteOptions,
  forbidden?: Set<string>,
): { path: number[]; cost: number } | null {
  if (!g.gates.has(origin) && !g.special.has(origin) && !g.systems.has(origin)) return null;
  const dist = new Map<number, number>([[origin, 0]]);
  const prev = new Map<number, number>();
  const visited = new Set<number>();
  const heap = new MinHeap();
  heap.push(0, origin);

  while (heap.size) {
    const { cost, node } = heap.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    if (node === destination) {
      const path: number[] = [];
      for (let cur: number | undefined = destination; cur !== undefined; cur = prev.get(cur)) path.push(cur);
      return { path: path.reverse(), cost };
    }
    for (const edge of edgesFrom(g, node)) {
      if (!edgeAllowed(g, node, edge, o)) continue;
      if (forbidden && forbidden.has(forbidKey(node, edge.to, edge.method))) continue;
      if (visited.has(edge.to)) continue;
      const next = cost + edgeCost(g, edge, o);
      if (next < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, next);
        prev.set(edge.to, node);
        heap.push(next, edge.to);
      }
    }
  }
  return null;
}

// ── Diversity search ─────────────────────────────────────────────────────────

/** The best allowed edge from→to; ties go to the least "special" method. */
function bestEdge(g: FleetGraph, from: number, to: number, o: FleetRouteOptions | null): FleetEdge | null {
  let best: FleetEdge | null = null;
  for (const edge of edgesFrom(g, from)) {
    if (edge.to !== to) continue;
    if (o && !edgeAllowed(g, from, edge, o)) continue;
    if (!best || edge.weight < best.weight
        || (edge.weight === best.weight && METHOD_PRIORITY[edge.method] < METHOD_PRIORITY[best.method])) {
      best = edge;
    }
  }
  return best;
}

function specialEdgesInPath(g: FleetGraph, path: number[], o: FleetRouteOptions): string[] {
  const out: string[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const e = bestEdge(g, path[i], path[i + 1], o);
    if (e && e.method !== 'stargate') out.push(forbidKey(path[i], path[i + 1], e.method));
  }
  return out;
}

function withoutCapitals(o: FleetRouteOptions): FleetRouteOptions {
  return { ...o, useTitanBridge: false, useBlopsBridge: false, useCarrierConduit: false };
}
function gatesOnly(o: FleetRouteOptions): FleetRouteOptions {
  return { ...withoutCapitals(o), useJumpBridges: false, useWormholes: false };
}

function findDiversePaths(
  g: FleetGraph, origin: number, destination: number, o: FleetRouteOptions, maxPaths: number,
): { path: number[]; cost: number }[] {
  const results: { path: number[]; cost: number }[] = [];
  const seen = new Set<string>();
  const solved: string[][] = [];   // special edges of each path found, in order
  const forbidden = new Set<string>();

  for (let iter = 0; iter < maxPaths * 3 && results.length < maxPaths; iter++) {
    forbidden.clear();
    for (const combo of solved) if (combo.length) forbidden.add(combo[combo.length - 1]);

    let found = dijkstra(g, origin, destination, o, forbidden.size ? forbidden : undefined);
    if (!found) break;
    let key = found.path.join(',');
    let specials = specialEdgesInPath(g, found.path, o);

    if (seen.has(key)) {
      // Same path again: forbid EVERY special edge of the last solution too.
      if (solved.length) {
        for (const k of solved[solved.length - 1]) forbidden.add(k);
        found = dijkstra(g, origin, destination, o, forbidden);
        if (!found) break;
        key = found.path.join(',');
        specials = specialEdgesInPath(g, found.path, o);
        if (seen.has(key)) break;
      }
    }
    if (!seen.has(key)) {
      seen.add(key);
      solved.push(specials);
      results.push(found);
      if (specials.length === 0) break;   // reached the pure-gate route
    }
  }

  // Always offer the pure stargate route.
  const hasStatic = results.some((r) => specialEdgesInPath(g, r.path, o).length === 0);
  if (!hasStatic && o.useStargates) {
    const s = dijkstra(g, origin, destination, gatesOnly(o));
    if (s && !seen.has(s.path.join(','))) { seen.add(s.path.join(',')); results.push(s); }
  }

  // With capital bridges on, the forbid-last-edge loop mostly yields capital
  // variants; explore the subcap world separately so WH / bridge routes show.
  if (o.useTitanBridge || o.useBlopsBridge || o.useCarrierConduit) {
    for (const r of findDiversePaths(g, origin, destination, withoutCapitals(o), maxPaths)) {
      const k = r.path.join(',');
      if (!seen.has(k)) { seen.add(k); results.push(r); }
    }
  }
  return results;
}

/** Stargate-only BFS depth from origin to destination, or null beyond maxDepth. */
export function gateDistance(g: FleetGraph, origin: number, destination: number, maxDepth: number): number | null {
  if (origin === destination) return 0;
  const visited = new Set<number>([origin]);
  let frontier = [origin];
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next: number[] = [];
    for (const node of frontier) {
      for (const to of g.gates.get(node) ?? []) {
        if (visited.has(to)) continue;
        if (to === destination) return depth;
        visited.add(to);
        next.push(to);
      }
    }
    frontier = next;
  }
  return null;
}

// ── Route assembly ───────────────────────────────────────────────────────────

function buildSegments(g: FleetGraph, path: number[], o: FleetRouteOptions | null): FleetSegment[] {
  const segs: FleetSegment[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const e = bestEdge(g, path[i], path[i + 1], o);
    if (e) segs.push({ from: path[i], to: path[i + 1], method: e.method, edge: e });
  }
  return segs;
}

export function categorise(segments: FleetSegment[], o: FleetRouteOptions): string[] {
  const cats: string[] = [];
  const methods = new Set(segments.map((s) => s.method));
  const whSystems = new Set<number>();
  for (const s of segments) if (s.method === 'wormhole') { whSystems.add(s.from); whSystems.add(s.to); }
  const viaThera  = whSystems.has(o.theraId);
  const viaTurnur = whSystems.has(o.turnurId);
  const hasWh = methods.has('wormhole'), hasJb = methods.has('jump_bridge');
  const hasCapital = [...methods].some((m) => CAPITAL_METHODS.has(m));
  if (viaThera)  cats.push('via_thera');
  if (viaTurnur) cats.push('via_turnur');
  if (hasJb)     cats.push('via_jb');
  if (hasWh && !viaThera && !viaTurnur) cats.push('via_wh');
  if (methods.has('titan_bridge'))    cats.push('titan_bridge');
  if (methods.has('blops_bridge'))    cats.push('blops_bridge');
  if (methods.has('carrier_conduit')) cats.push('carrier_conduit');
  if (!hasJb && !hasWh && !hasCapital) cats.push('gates_only');
  return cats;
}

/**
 * Jump fatigue (minutes) at the end of the route, using EVE's formula
 * new = (1 + ly × multiplier) × max(current, 1) for each bridge hop; gate,
 * wormhole and Ansiblex hops decay it by ~30 s of travel each (1 min / 10 min).
 */
export function estimateFatigue(segments: FleetSegment[]): number {
  let fatigue = 0;
  for (const s of segments) {
    const mult = FATIGUE_MULTIPLIER[s.method];
    if (mult !== undefined) fatigue = (1 + (s.edge.distanceLy ?? 0) * mult) * Math.max(fatigue, 1);
    else fatigue = Math.max(0, fatigue - 0.05);
  }
  return Math.round(fatigue * 10) / 10;
}

/** Diverse route options between two systems, best first. */
export function calculateRoutes(
  g: FleetGraph, origin: number, destination: number, o: FleetRouteOptions, maxRoutes = 8,
): FleetRoute[] {
  const raw = findDiversePaths(g, origin, destination, o, maxRoutes * 3);
  const routes: FleetRoute[] = [];
  const seen = new Set<string>();
  const rangeCache = new Map<string, number | null>();

  for (const { path, cost } of raw) {
    const key = path.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    const segments = buildSegments(g, path, o);

    const bridgeCount = segments.filter((s) => CAPITAL_METHODS.has(s.method)).length;
    if (bridgeCount > o.maxBridges) continue;

    // A capital hop that saves fewer than minBridgeRange gates is not worth a
    // titan's fatigue; exactly minBridgeRange gates is allowed.
    if (o.minBridgeRange > 1) {
      let skip = false;
      for (const s of segments) {
        if (!CAPITAL_METHODS.has(s.method)) continue;
        const ck = `${s.from}|${s.to}`;
        if (!rangeCache.has(ck)) rangeCache.set(ck, gateDistance(g, s.from, s.to, o.minBridgeRange - 1));
        if (rangeCache.get(ck) !== null) { skip = true; break; }
      }
      if (skip) continue;
    }

    routes.push({
      id: routes.length + 1,
      categories: categorise(segments, o),
      totalJumps: segments.length,
      totalCost: cost,
      segments,
      systems: path,
      fatigueMinutes: estimateFatigue(segments),
    });
  }

  const byJumps = (a: FleetRoute, b: FleetRoute) => a.totalJumps - b.totalJumps || a.totalCost - b.totalCost;
  routes.sort(byJumps);

  // A gates-only route is always present when gates are on: segment
  // reconstruction may have promoted a gate hop where a bridge shares the pair.
  let gatesRoute = routes.find((r) => r.categories.includes('gates_only')) ?? null;
  if (!gatesRoute && o.useStargates) {
    const go = gatesOnly(o);
    const s = dijkstra(g, origin, destination, go);
    if (s) {
      const segments = buildSegments(g, s.path, go);
      gatesRoute = {
        id: 0, categories: categorise(segments, go), totalJumps: segments.length, totalCost: s.cost,
        segments, systems: s.path, fatigueMinutes: 0,
      };
      routes.push(gatesRoute);
      routes.sort(byJumps);
    }
  }

  let out = routes.slice(0, maxRoutes);
  if (gatesRoute && !out.includes(gatesRoute)) out[out.length - 1] = gatesRoute;
  out = out.map((r, i) => ({ ...r, id: i + 1 }));
  return out;
}

// ── Serialisation ────────────────────────────────────────────────────────────

export interface FleetCapacity { perJump: boolean; totalPasses: number }

/** Fleet capacity through one wormhole hop per hull class, or null for non-WH. */
export function computeCapacity(edge: FleetEdge): Record<ShipClass, FleetCapacity> | null {
  if (edge.method !== 'wormhole' || edge.maxJumpMass == null || edge.maxStableMass == null) return null;
  let remaining = edge.maxStableMass;
  if (edge.massStatus === 'reduced')  remaining = Math.floor(edge.maxStableMass * 0.5);
  if (edge.massStatus === 'critical') remaining = Math.floor(edge.maxStableMass * 0.1);
  const out = {} as Record<ShipClass, FleetCapacity>;
  for (const [cls, mass] of Object.entries(SHIP_CLASS_MASS) as [ShipClass, number][]) {
    const perJump = mass <= edge.maxJumpMass;
    out[cls] = { perJump, totalPasses: perJump ? Math.floor(remaining / mass) : 0 };
  }
  return out;
}

export interface FleetRouteJson {
  id:              number;
  categories:      string[];
  totalJumps:      number;
  securitySummary: { highsec: number; lowsec: number; nullsec: number; wh: number };
  bottleneck:      { description: string; maxShipClass: ShipClass | null } | null;
  segments:        FleetSegmentJson[];
  systems:         { id: number; name: string; security: number; wspace: boolean }[];
  warnings:        string[];
  fatigueMinutes?: number;
}

export interface FleetSegmentJson {
  from:            { id: number; name: string; security: number };
  to:              { id: number; name: string; security: number };
  method:          FleetMethod;
  distanceLy?:     number;
  name?:           string;
  whType?:         string | null;
  massStatus?:     MassStatus | null;
  timeStatus?:     TimeStatus | null;
  maxShipSize?:    string | null;
  maxJumpMassKg?:  number;
  maxStableMassKg?: number;
  remainingHours?: number;
  capacity?:       Record<ShipClass, FleetCapacity>;
  scout?:          boolean;
}

const unknownSystem = (id: number): FleetSystem => ({ id, name: '?', security: 0, wspace: isWspaceId(id) });
const sysJson = (s: FleetSystem) => ({ id: s.id, name: s.name, security: Math.round(s.security * 10) / 10 });

export function routeToJson(route: FleetRoute, g: FleetGraph): FleetRouteJson {
  const sys = (id: number) => g.systems.get(id) ?? unknownSystem(id);
  const securitySummary = { highsec: 0, lowsec: 0, nullsec: 0, wh: 0 };
  for (const id of route.systems) {
    const b = secBucket(sys(id));
    if (b === 'wh') securitySummary.wh++;
    else if (b === 'hs') securitySummary.highsec++;
    else if (b === 'ls') securitySummary.lowsec++;
    else securitySummary.nullsec++;
  }

  const whSegs = route.segments.filter((s) => s.method === 'wormhole' && s.edge.maxJumpMass != null);
  let bottleneck: FleetRouteJson['bottleneck'] = null;
  if (whSegs.length) {
    const tightest = whSegs.reduce((a, b) => ((b.edge.maxJumpMass ?? 0) < (a.edge.maxJumpMass ?? 0) ? b : a));
    const cap = tightest.edge.maxJumpMass ?? 0;
    const maxShipClass = SHIP_CLASSES_DESC.find((c) => SHIP_CLASS_MASS[c] <= cap) ?? null;
    bottleneck = {
      description: `WH ${sys(tightest.from).name} → ${sys(tightest.to).name} (${tightest.edge.whType ?? '?'})`,
      maxShipClass,
    };
  }

  const warnings: string[] = [];
  const segments: FleetSegmentJson[] = route.segments.map((s) => {
    const from = sys(s.from), to = sys(s.to), e = s.edge;
    const out: FleetSegmentJson = { from: sysJson(from), to: sysJson(to), method: s.method };
    if (e.name) out.name = e.name;
    if (CAPITAL_METHODS.has(s.method) && (e.distanceLy ?? 0) > 0) out.distanceLy = Math.round(e.distanceLy! * 100) / 100;
    if (s.method === 'wormhole') {
      out.whType = e.whType ?? null;
      out.massStatus = e.massStatus ?? null;
      out.timeStatus = e.timeStatus ?? null;
      out.maxShipSize = e.maxShipSize ?? null;
      if (e.scout) out.scout = true;
      if (e.maxJumpMass)   out.maxJumpMassKg   = e.maxJumpMass;
      if (e.maxStableMass) out.maxStableMassKg = e.maxStableMass;
      if (e.remainingHours != null) out.remainingHours = Math.round(e.remainingHours * 10) / 10;
      const capacity = computeCapacity(e);
      if (capacity) out.capacity = capacity;
      const label = `WH ${from.name} → ${to.name}`;
      if (e.timeStatus === 'eol')        warnings.push(`${label} is end-of-life`);
      if (e.massStatus === 'reduced')    warnings.push(`${label} mass is reduced — limited capacity`);
      if (e.massStatus === 'critical')   warnings.push(`${label} mass is critical — very limited capacity`);
      if (e.remainingHours != null && e.remainingHours < 8) warnings.push(`${label} expires in ~${Math.round(e.remainingHours)} h`);
    }
    return out;
  });

  const json: FleetRouteJson = {
    id: route.id,
    categories: route.categories,
    totalJumps: route.totalJumps,
    securitySummary,
    bottleneck,
    segments,
    systems: route.systems.map((id) => { const s = sys(id); return { ...sysJson(s), wspace: s.wspace }; }),
    warnings,
  };
  if (route.fatigueMinutes > 0) json.fatigueMinutes = route.fatigueMinutes;
  return json;
}

/**
 * The autopilot waypoints a route needs: the autopilot handles gate legs on
 * its own, so only the systems on either side of a non-gate hop matter, plus
 * the destination. J-space systems are skipped (no autopilot there).
 */
export function extractWaypoints(segments: { from: { id: number }; to: { id: number }; method: string }[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const add = (id: number) => { if (!seen.has(id) && !isWspaceId(id)) { seen.add(id); out.push(id); } };
  for (const s of segments) {
    if (s.method !== 'stargate') { add(s.from.id); add(s.to.id); }
  }
  if (segments.length) add(segments[segments.length - 1].to.id);
  return out;
}

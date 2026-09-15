// Ports of the standalone route finder's pathfinder test suite, run against
// hand-built graphs so the engine is exercised without a database.
import { describe, it, expect } from 'vitest';
import {
  AVOID_PENALTY, CAPITAL_RANGE_LY, LY_METRES, THERA_ID, TURNUR_ID,
  addGate, addSpecial, addSystem, calculateRoutes, categorise, defaultFleetOptions,
  dijkstra, emptyFleetGraph, estimateFatigue, extractWaypoints, gateDistance, routeToJson,
  type FleetEdge, type FleetGraph, type FleetRouteOptions, type FleetSegment,
} from './fleetRoutes.js';

const sys = (id: number, name = `S${id}`, security = 0, wspace = false) => ({ id, name, security, wspace });
const opts = (over: Partial<FleetRouteOptions> = {}): FleetRouteOptions => ({ ...defaultFleetOptions(), ...over });

function linearGates(): FleetGraph {
  const g = emptyFleetGraph();
  for (let i = 1; i <= 5; i++) addSystem(g, sys(i));
  for (const [a, b] of [[1, 2], [2, 3], [3, 4], [4, 5]]) addGate(g, a, b);
  return g;
}
function mixedSecChain(): FleetGraph {
  const g = emptyFleetGraph();
  addSystem(g, sys(1, 'HS-1', 0.9)); addSystem(g, sys(2, 'LS-2', 0.3)); addSystem(g, sys(3, 'NS-3', -0.5));
  addSystem(g, sys(4, 'LS-4', 0.3)); addSystem(g, sys(5, 'HS-5', 0.9));
  for (const [a, b] of [[1, 2], [2, 3], [3, 4], [4, 5]]) addGate(g, a, b);
  return g;
}
function jbShortcut(): FleetGraph {
  const g = linearGates();
  addSpecial(g, 1, 5, { method: 'jump_bridge', weight: 1 });
  return g;
}
const WH_META: Omit<FleetEdge, 'to'> = {
  method: 'wormhole', weight: 1, whType: 'K162', massStatus: 'stable', timeStatus: 'stable',
  maxJumpMass: 300_000_000, maxStableMass: 3_000_000_000,
};
function whShortcut(): FleetGraph {
  const g = linearGates();
  addSpecial(g, 2, 4, WH_META);
  return g;
}
function capitalBridgeGraph(): FleetGraph {
  const g = emptyFleetGraph();
  addSystem(g, sys(100, 'CAP-A', -0.5)); addSystem(g, sys(200, 'CAP-B', -0.5));
  for (let i = 101; i <= 109; i++) addSystem(g, sys(i, `CHAIN-${i}`, -0.5));
  addGate(g, 100, 101);
  for (let i = 101; i < 109; i++) addGate(g, i, i + 1);
  addGate(g, 109, 200);
  addSystem(g, sys(90, 'NEAR', -0.5));
  addGate(g, 100, 90); addGate(g, 90, 102);
  addSpecial(g, 100, 200, { method: 'titan_bridge', weight: 1, distanceLy: 5 });
  addSpecial(g, 100, 102, { method: 'titan_bridge', weight: 1, distanceLy: 2 });
  return g;
}
function theraGraph(): FleetGraph {
  const g = emptyFleetGraph();
  for (let i = 1; i <= 7; i++) addSystem(g, sys(i));
  addSystem(g, sys(THERA_ID, 'Thera', -0.99, true));
  for (const [a, b] of [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7]]) addGate(g, a, b);
  addSpecial(g, 2, THERA_ID, { method: 'wormhole', weight: 1, whType: 'T458', massStatus: 'stable', timeStatus: 'stable' });
  addSpecial(g, 6, THERA_ID, { method: 'wormhole', weight: 1, whType: 'T458', massStatus: 'stable', timeStatus: 'stable' });
  return g;
}
function turnurGraph(): FleetGraph {
  const g = emptyFleetGraph();
  addSystem(g, sys(1, 'A', 0.4)); addSystem(g, sys(TURNUR_ID, 'Turnur', 0.3));
  addSystem(g, sys(3, 'C', 0.4)); addSystem(g, sys(4, 'D', 0));
  addGate(g, 1, TURNUR_ID); addGate(g, TURNUR_ID, 3);
  addSpecial(g, TURNUR_ID, 4, { method: 'wormhole', weight: 1, whType: 'K162', massStatus: 'stable', timeStatus: 'stable' });
  return g;
}
const seg = (from: number, to: number, method: FleetEdge['method'], distanceLy = 0): FleetSegment =>
  ({ from, to, method, edge: { to, method, weight: 1, distanceLy } });

describe('dijkstra', () => {
  it('walks a linear chain', () => {
    expect(dijkstra(linearGates(), 1, 5, opts())).toEqual({ path: [1, 2, 3, 4, 5], cost: 4 });
  });
  it('handles origin == destination', () => {
    expect(dijkstra(linearGates(), 3, 3, opts())).toEqual({ path: [3], cost: 0 });
  });
  it('returns null for unreachable or unknown systems', () => {
    expect(dijkstra(linearGates(), 1, 999, opts())).toBeNull();
    expect(dijkstra(linearGates(), 999, 1, opts())).toBeNull();
  });
  it('takes a jump bridge when enabled and falls back to gates when not', () => {
    expect(dijkstra(jbShortcut(), 1, 5, opts())).toEqual({ path: [1, 5], cost: 1 });
    expect(dijkstra(jbShortcut(), 1, 5, opts({ useJumpBridges: false }))).toEqual({ path: [1, 2, 3, 4, 5], cost: 4 });
  });
});

describe('calculateRoutes', () => {
  it('returns a diverse set: the bridge route AND a gates-only route', () => {
    const routes = calculateRoutes(jbShortcut(), 1, 5, opts(), 5);
    const methods = routes.map((r) => new Set(r.segments.map((s) => s.method)));
    expect(methods.some((m) => m.has('jump_bridge'))).toBe(true);
    expect(methods.some((m) => m.size === 1 && m.has('stargate'))).toBe(true);
  });
  it('sorts by jumps, numbers routes sequentially, and respects maxRoutes', () => {
    const routes = calculateRoutes(jbShortcut(), 1, 5, opts(), 5);
    const jumps = routes.map((r) => r.totalJumps);
    expect(jumps).toEqual([...jumps].sort((a, b) => a - b));
    expect(routes.map((r) => r.id)).toEqual(routes.map((_, i) => i + 1));
    expect(calculateRoutes(jbShortcut(), 1, 5, opts(), 1).length).toBeLessThanOrEqual(1);
  });
  it('keeps segments and systems consistent', () => {
    for (const r of calculateRoutes(linearGates(), 1, 5, opts(), 3)) {
      expect([...r.segments.map((s) => s.from), r.segments[r.segments.length - 1].to]).toEqual(r.systems);
      expect(r.totalJumps).toBe(r.segments.length);
    }
  });
  it('is deterministic', () => {
    const a = calculateRoutes(jbShortcut(), 1, 5, opts(), 5).map((r) => r.systems);
    const b = calculateRoutes(jbShortcut(), 1, 5, opts(), 5).map((r) => r.systems);
    expect(a).toEqual(b);
  });
  it('always includes a gates-only route when gates are on, never when off', () => {
    expect(calculateRoutes(jbShortcut(), 1, 5, opts(), 5).some((r) => r.categories.includes('gates_only'))).toBe(true);
    for (const r of calculateRoutes(jbShortcut(), 1, 5, opts({ useStargates: false }), 5)) {
      expect(r.categories).not.toContain('gates_only');
    }
    expect(calculateRoutes(linearGates(), 1, 5, opts({ useStargates: false, useJumpBridges: false }), 3)).toEqual([]);
  });
});

describe('security tri-state', () => {
  function detour(): FleetGraph {
    const g = emptyFleetGraph();
    addSystem(g, sys(1, 'A', -0.5)); addSystem(g, sys(2, 'LS', 0.4)); addSystem(g, sys(3, 'B', -0.5));
    addSystem(g, sys(4, 'N1', -0.5)); addSystem(g, sys(5, 'N2', -0.5));
    addGate(g, 1, 2); addGate(g, 2, 3); addGate(g, 1, 4); addGate(g, 4, 5); addGate(g, 5, 3);
    return g;
  }
  it('permit: direct path through low-sec wins', () => {
    expect(dijkstra(detour(), 1, 3, opts())!.path).toEqual([1, 2, 3]);
  });
  it('avoid: the null-sec detour wins, but low-sec is still used when it is the only way', () => {
    expect(dijkstra(detour(), 1, 3, opts({ avoidLowsec: 1 }))!.path).toEqual([1, 4, 5, 3]);
    const g = emptyFleetGraph();
    addSystem(g, sys(1, 'A', -0.5)); addSystem(g, sys(2, 'LS', 0.4)); addSystem(g, sys(3, 'B', -0.5));
    addGate(g, 1, 2); addGate(g, 2, 3);
    expect(dijkstra(g, 1, 3, opts({ avoidLowsec: 1 }))).toEqual({ path: [1, 2, 3], cost: 2 + AVOID_PENALTY });
    expect(dijkstra(g, 1, 3, opts({ avoidLowsec: 2 }))).toBeNull();
  });
  it('avoid high-sec penalises 0.5+ destinations', () => {
    const g = emptyFleetGraph();
    addSystem(g, sys(1, 'A', 0)); addSystem(g, sys(2, 'HS', 0.7)); addSystem(g, sys(3, 'B', 0));
    addGate(g, 1, 2); addGate(g, 2, 3);
    expect(dijkstra(g, 1, 3, opts({ avoidHighsec: 1 }))!.cost).toBe(2 + AVOID_PENALTY);
  });
  it('null-sec avoidance never applies to w-space, and w-space can be hard-blocked', () => {
    const g = emptyFleetGraph();
    addSystem(g, sys(1, 'A', -0.5)); addSystem(g, sys(2, 'WH', -1, true)); addSystem(g, sys(3, 'B', -0.5));
    addGate(g, 1, 2); addGate(g, 2, 3);
    expect(dijkstra(g, 1, 3, opts({ avoidNullsec: 1 }))!.cost).toBe(2 + AVOID_PENALTY);
    expect(dijkstra(g, 1, 3, opts({ avoidWhSpace: 2 }))).toBeNull();
  });
  it('security summary buckets systems by class', () => {
    const g = mixedSecChain();
    const [r] = calculateRoutes(g, 1, 5, opts(), 1);
    expect(routeToJson(r, g).securitySummary).toEqual({ highsec: 2, lowsec: 2, nullsec: 1, wh: 0 });
  });
});

describe('wormholes, Thera and Turnur toggles', () => {
  it('wormholes are off by default and taken when enabled', () => {
    expect(dijkstra(whShortcut(), 1, 5, opts())!.path).toEqual([1, 2, 3, 4, 5]);
    expect(dijkstra(whShortcut(), 1, 5, opts({ useWormholes: true }))!.path).toEqual([1, 2, 4, 5]);
  });
  it('a wormhole segment carries its metadata', () => {
    const routes = calculateRoutes(whShortcut(), 1, 5, opts({ useWormholes: true }), 3);
    const s = routes.flatMap((r) => r.segments).find((x) => x.method === 'wormhole')!;
    expect(s).toBeDefined();
    expect(s.edge).toMatchObject({ whType: 'K162', massStatus: 'stable', timeStatus: 'stable', maxJumpMass: 300_000_000, maxStableMass: 3_000_000_000 });
  });
  it('includeThera governs the Thera holes only', () => {
    const g = theraGraph();
    expect(dijkstra(g, 1, 7, opts({ useWormholes: true, includeThera: false }))!.path).not.toContain(THERA_ID);
    expect(calculateRoutes(g, 1, 7, opts({ useWormholes: true }), 5).some((r) => r.systems.includes(THERA_ID))).toBe(true);
  });
  it('includeTurnur blocks the Turnur wormhole but never gate transit through Turnur', () => {
    const g = turnurGraph();
    expect(dijkstra(g, 1, 4, opts({ useWormholes: true, includeTurnur: false }))).toBeNull();
    expect(dijkstra(g, 1, 3, opts({ useWormholes: true, includeTurnur: false }))!.path).toEqual([1, TURNUR_ID, 3]);
    expect(dijkstra(g, 1, 4, opts({ useWormholes: true }))!.path).toEqual([1, TURNUR_ID, 4]);
  });
  it('useJumpBridges=false removes only bridge hops', () => {
    const routes = calculateRoutes(jbShortcut(), 1, 5, opts({ useJumpBridges: false }), 5);
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) for (const s of r.segments) expect(s.method).not.toBe('jump_bridge');
  });
});

describe('capital bridges', () => {
  it('uses the titan bridge when enabled: one hop beats the nine-gate chain', () => {
    const top = calculateRoutes(capitalBridgeGraph(), 100, 200, opts({ useTitanBridge: true }), 5)[0];
    expect(top.totalJumps).toBe(1);
    expect(top.segments[0].method).toBe('titan_bridge');
  });
  it('never uses a capital hop when disabled or when maxBridges is 0', () => {
    for (const o of [opts(), opts({ useTitanBridge: true, maxBridges: 0, minBridgeRange: 1 })]) {
      for (const r of calculateRoutes(capitalBridgeGraph(), 100, 200, o, 5)) {
        for (const s of r.segments) expect(s.method).not.toBe('titan_bridge');
      }
    }
  });
  it('minBridgeRange rejects a bridge that saves too few gates, and 1 allows any', () => {
    const g = capitalBridgeGraph();
    for (const r of calculateRoutes(g, 100, 102, opts({ useTitanBridge: true, minBridgeRange: 3 }), 5)) {
      for (const s of r.segments) {
        if (s.method !== 'titan_bridge') continue;
        const d = gateDistance(g, s.from, s.to, 3);
        expect(d === null || d >= 3).toBe(true);
      }
    }
    const top = calculateRoutes(g, 100, 102, opts({ useTitanBridge: true, minBridgeRange: 1 }), 5)[0];
    expect(top.totalJumps).toBe(1);
    expect(top.segments[0].method).toBe('titan_bridge');
  });
  it('maxBridges=1 rejects a route that needs two titan hops', () => {
    const g = emptyFleetGraph();
    addSystem(g, sys(1, 'A', -0.5)); addSystem(g, sys(2, 'B', -0.5)); addSystem(g, sys(3, 'C', -0.5));
    addSpecial(g, 1, 2, { method: 'titan_bridge', weight: 1, distanceLy: 5 });
    addSpecial(g, 2, 3, { method: 'titan_bridge', weight: 1, distanceLy: 5 });
    const routes = calculateRoutes(g, 1, 3, opts({ useTitanBridge: true, maxBridges: 1, minBridgeRange: 1 }), 5);
    for (const r of routes) expect(r.segments.filter((s) => s.method === 'titan_bridge').length).toBeLessThanOrEqual(1);
  });
  it('gateDistance is a stargate-only BFS bounded by maxDepth', () => {
    const g = linearGates();
    expect(gateDistance(g, 1, 1, 10)).toBe(0);
    expect(gateDistance(g, 1, 2, 10)).toBe(1);
    expect(gateDistance(g, 1, 5, 10)).toBe(4);
    expect(gateDistance(g, 1, 5, 3)).toBeNull();
  });
  it('LY_METRES matches the SDE metre-per-light-year constant', () => {
    expect(LY_METRES).toBeCloseTo(9.4607e15, -12);
  });
});

describe('categorise and fatigue', () => {
  const o = opts();
  it('labels routes by what they use', () => {
    expect(categorise([seg(1, 2, 'stargate'), seg(2, 3, 'stargate')], o)).toEqual(['gates_only']);
    const jb = categorise([seg(1, 2, 'jump_bridge'), seg(2, 3, 'stargate')], o);
    expect(jb).toContain('via_jb'); expect(jb).not.toContain('gates_only');
    expect(categorise([seg(1, 2, 'wormhole')], o)).toContain('via_wh');
    const thera = categorise([seg(1, THERA_ID, 'wormhole'), seg(THERA_ID, 2, 'wormhole')], o);
    expect(thera).toContain('via_thera'); expect(thera).not.toContain('via_wh');
    for (const m of ['titan_bridge', 'blops_bridge', 'carrier_conduit', 'command_conduit'] as const) {
      expect(categorise([seg(1, 2, m)], o)).toContain(m);
    }
  });
  it('reaches half a light-year further from a command carrier than from a carrier', () => {
    expect(CAPITAL_RANGE_LY.carrier_conduit).toBe(7);
    expect(CAPITAL_RANGE_LY.command_conduit).toBe(7.5);
  });
  it('treats a command conduit as a capital hop only when its own switch is on', () => {
    const g = emptyFleetGraph();
    for (let i = 1; i <= 4; i++) addSystem(g, sys(i, `NS-${i}`, -0.5));
    addGate(g, 1, 2); addGate(g, 2, 3); addGate(g, 3, 4);
    addSpecial(g, 1, 4, { method: 'command_conduit', weight: 1, distanceLy: 7.4 });
    // The carrier conduit switch does not cover a command carrier's conduit.
    const gatesOnly = calculateRoutes(g, 1, 4, opts({ useCarrierConduit: true, minBridgeRange: 1 }), 5);
    expect(gatesOnly.every((r) => r.segments.every((s) => s.method === 'stargate'))).toBe(true);
    const on = opts({ useCommandConduit: true, minBridgeRange: 1 });
    const withConduit = calculateRoutes(g, 1, 4, on, 5);
    expect(withConduit[0].segments.map((s) => s.method)).toEqual(['command_conduit']);
    expect(categorise(withConduit[0].segments, on)).toContain('command_conduit');
  });
  it('estimates fatigue with EVE’s formula', () => {
    expect(estimateFatigue([seg(1, 2, 'stargate'), seg(2, 3, 'stargate')])).toBe(0);
    expect(estimateFatigue([seg(1, 2, 'titan_bridge', 5)])).toBe(6);
    expect(estimateFatigue([seg(1, 2, 'blops_bridge', 5)])).toBe(3.5);
    const decayed = estimateFatigue([seg(1, 2, 'titan_bridge', 5), seg(2, 3, 'stargate')]);
    expect(decayed).toBeGreaterThanOrEqual(5.9); expect(decayed).toBeLessThanOrEqual(6);
    expect(estimateFatigue([seg(1, 2, 'titan_bridge', 5), seg(2, 3, 'titan_bridge', 5)])).toBe(36);
  });
});

describe('routeToJson', () => {
  it('has the expected shape', () => {
    const g = linearGates();
    const [r] = calculateRoutes(g, 1, 5, opts(), 1);
    const j = routeToJson(r, g);
    expect(j.totalJumps).toBe(4);
    expect(j.segments).toHaveLength(4);
    expect(j.systems.map((s) => s.id)).toEqual([1, 2, 3, 4, 5]);
    expect(j.bottleneck).toBeNull();
    expect(j.warnings).toEqual([]);
  });
  it('exposes capacity, bottleneck and warnings for a critical, EOL, expiring hole', () => {
    const g = linearGates();
    addSpecial(g, 2, 4, { ...WH_META, massStatus: 'critical', timeStatus: 'eol', remainingHours: 2 });
    const routes = calculateRoutes(g, 1, 5, opts({ useWormholes: true }), 5);
    const whRoute = routes.find((r) => r.segments.some((s) => s.method === 'wormhole'))!;
    const j = routeToJson(whRoute, g);
    const wh = j.segments.find((s) => s.method === 'wormhole')!;
    expect(wh.capacity).toBeDefined();
    // 10% of 3B = 300M remaining; battleships (100M) fit 3 passes, capitals never fit.
    expect(wh.capacity!.battleship).toEqual({ perJump: true, totalPasses: 3 });
    expect(wh.capacity!.capital.perJump).toBe(false);
    expect(j.bottleneck).toEqual({ description: 'WH S2 → S4 (K162)', maxShipClass: 'battleship' });
    const blob = j.warnings.join(' ').toLowerCase();
    expect(blob).toContain('end-of-life');
    expect(blob).toContain('critical');
    expect(blob).toContain('expires');
  });
});

describe('extractWaypoints', () => {
  it('keeps only the ends of non-gate hops plus the destination, skipping J-space', () => {
    const s = (a: number, b: number, method: string) => ({ from: { id: a }, to: { id: b }, method });
    expect(extractWaypoints([
      s(1, 2, 'stargate'), s(2, 3, 'jump_bridge'), s(3, 4, 'stargate'),
      s(4, 31000123, 'wormhole'), s(31000123, 6, 'wormhole'), s(6, 7, 'stargate'),
    ])).toEqual([2, 3, 4, 6, 7]);
    expect(extractWaypoints([s(1, 2, 'stargate'), s(2, 3, 'stargate')])).toEqual([3]);
    expect(extractWaypoints([])).toEqual([]);
  });
});

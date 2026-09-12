// Fleet route planner API: diverse routes across gates, Ansiblex bridges,
// mapped wormholes, Thera/Turnur and capital bridges, plus "send to autopilot".
import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { createLogger } from '../utils/logger.js';
import { esiFetch } from '../utils/esi.js';
import { getValidToken } from '../utils/eveToken.js';
import { resolveOwnerId } from '../utils/owner.js';
import { visibleMapIds } from './maps.js';
import { buildFleetGraph, getHubIds, resolveSystem } from '../services/fleetRouteGraph.js';
import {
  calculateRoutes, defaultFleetOptions, extractWaypoints, routeToJson,
  type FleetRouteOptions, type SecurityLevel,
} from '../services/fleetRoutes.js';

const router = Router();
router.use(requireAuth);
const log = createLogger('fleetRoutes');

const MAX_ROUTES = 10;

const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const level = (v: unknown, d: SecurityLevel): SecurityLevel => (v === 0 || v === 1 || v === 2 ? v : d);
const int = (v: unknown, d: number, min: number, max: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : d;
};

export function parseFleetOptions(raw: unknown): FleetRouteOptions {
  const d = defaultFleetOptions();
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    useStargates:      bool(o.useStargates, d.useStargates),
    useJumpBridges:    bool(o.useJumpBridges, d.useJumpBridges),
    useWormholes:      bool(o.useWormholes, d.useWormholes),
    includeThera:      bool(o.includeThera, d.includeThera),
    includeTurnur:     bool(o.includeTurnur, d.includeTurnur),
    useTitanBridge:    bool(o.useTitanBridge, d.useTitanBridge),
    useBlopsBridge:    bool(o.useBlopsBridge, d.useBlopsBridge),
    useCarrierConduit: bool(o.useCarrierConduit, d.useCarrierConduit),
    avoidHighsec:      level(o.avoidHighsec, d.avoidHighsec),
    avoidLowsec:       level(o.avoidLowsec, d.avoidLowsec),
    avoidNullsec:      level(o.avoidNullsec, d.avoidNullsec),
    avoidWhSpace:      level(o.avoidWhSpace, d.avoidWhSpace),
    minBridgeRange:    int(o.minBridgeRange, d.minBridgeRange, 0, 20),
    maxBridges:        int(o.maxBridges, d.maxBridges, 0, 10),
    theraId:           d.theraId,
    turnurId:          d.turnurId,
  };
}

// POST /api/fleet-routes { from, to, options, maxRoutes }
// `from`/`to` are system ids or names. Wormhole chains and drawn gates come
// from every map the caller can see (visibleMapIds is access-scoped).
router.post('/', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const [from, to] = await Promise.all([resolveSystem(body.from), resolveSystem(body.to)]);
  if (!from) return res.status(400).json({ error: 'Unknown origin system' });
  if (!to)   return res.status(400).json({ error: 'Unknown destination system' });
  const options = parseFleetOptions(body.options);
  const hubs = await getHubIds();
  options.theraId = hubs.thera; options.turnurId = hubs.turnur;
  const maxRoutes = int(body.maxRoutes, 6, 1, MAX_ROUTES);

  try {
    const ownerId = await resolveOwnerId(req);
    const needMaps = options.useWormholes || options.useJumpBridges;
    const mapIds = needMaps ? await visibleMapIds(req) : [];
    const started = Date.now();
    const { graph, summary } = await buildFleetGraph({
      thera: options.useWormholes && options.includeThera,
      turnur: options.useWormholes && options.includeTurnur,
      wormholes: options.useWormholes,
      jumpBridges: options.useJumpBridges,
      titan: options.useTitanBridge, blops: options.useBlopsBridge, conduit: options.useCarrierConduit,
      mapIds, ownerId,
    });
    const routes = calculateRoutes(graph, from.id, to.id, options, maxRoutes).map((r) => routeToJson(r, graph));
    // Star-map coordinates (CCP's 2D projection) for the route map. Only the
    // projection is used: J-space systems have none, and their raw galactic
    // position sits far outside the k-space map, so mixing the two scales
    // piles every k-space system into one corner. Missing ones are
    // interpolated client-side.
    const ids = [...new Set(routes.flatMap((r) => r.systems.map((s) => s.id)))];
    const coords: Record<number, { x: number; y: number }> = {};
    if (ids.length) {
      const { rows } = await db.query<{ id: number; x: number | null; y: number | null }>(
        `SELECT id, pos2d_x AS x, pos2d_y AS y FROM solar_systems WHERE id = ANY($1::int[])`, [ids]);
      for (const r of rows) if (r.x != null && r.y != null) coords[r.id] = { x: r.x, y: r.y };
    }
    log.info(`${from.name} → ${to.name}: ${routes.length} route(s) in ${Date.now() - started} ms`);
    return res.json({ from, to, routes, coords, sources: summary });
  } catch (err) {
    log.error('plan failed:', err);
    return res.status(500).json({ error: 'Route planning failed' });
  }
});

// POST /api/fleet-routes/waypoints { segments } — push a plan to the in-game
// autopilot: only the systems either side of a non-gate hop plus the
// destination are set; the autopilot fills in the gate legs itself.
router.post('/waypoints', async (req, res) => {
  const body = (req.body ?? {}) as { segments?: unknown };
  const segments = Array.isArray(body.segments) ? body.segments as { from?: { id?: unknown }; to?: { id?: unknown }; method?: unknown }[] : [];
  const clean = segments
    .map((s) => ({ from: { id: Number(s?.from?.id) }, to: { id: Number(s?.to?.id) }, method: String(s?.method ?? 'stargate') }))
    .filter((s) => Number.isInteger(s.from.id) && s.from.id > 0 && Number.isInteger(s.to.id) && s.to.id > 0 && s.to.id <= 2_147_483_647);
  if (!clean.length) return res.status(400).json({ error: 'No route segments provided' });
  const waypoints = extractWaypoints(clean);
  if (!waypoints.length) return res.status(400).json({ error: 'No valid waypoints in route' });

  let token: string;
  try { token = await getValidToken(req.session.userId!); }
  catch { return res.status(401).json({ error: 'No usable ESI token — log out and back in' }); }

  const errors: { systemId: number; status: number }[] = [];
  for (let i = 0; i < waypoints.length; i++) {
    const params = new URLSearchParams({
      add_to_beginning: 'false', clear_other_waypoints: String(i === 0), destination_id: String(waypoints[i]),
    });
    try {
      const r = await esiFetch(`https://esi.evetech.net/latest/ui/autopilot/waypoint/?${params}`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) errors.push({ systemId: waypoints[i], status: r.status });
    } catch { errors.push({ systemId: waypoints[i], status: 0 }); }
  }
  return res.json({ ok: errors.length === 0, set: waypoints.length - errors.length, total: waypoints.length, waypoints, errors });
});

export default router;

// Standby capital bridge services (titan / black ops / carrier conduit) for
// the fleet route planner. Shared rows are managed by full users and admins;
// anyone can keep personal ones.
import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { resolveOwnerId } from '../utils/owner.js';
import { createLogger } from '../utils/logger.js';
import { resolveSystem, SERVICE_DEFAULT_RANGE } from '../services/fleetRouteGraph.js';
import { canManageShared } from './jumpBridges.js';

const log = createLogger('bridgeServices');
export const bridgeServicesRouter = Router();
bridgeServicesRouter.use(requireAuth);

const KINDS = new Set(['titan', 'blops', 'conduit']);
type Kind = 'titan' | 'blops' | 'conduit';

interface ServiceRow {
  id: number; systemId: number; systemName: string | null; security: string | null; regionName: string | null;
  kind: Kind; rangeLy: string | null; name: string; active: boolean; addedBy: string | null; personal: boolean; createdAt: string;
}

const SELECT = `
  SELECT s.id, s.system_id AS "systemId", ss.name AS "systemName", ss.security::text AS security, r.name AS "regionName",
         s.kind, s.range_ly AS "rangeLy", s.name, s.active, u.character_name AS "addedBy",
         (s.owner_id IS NOT NULL) AS personal, s.created_at AS "createdAt"
    FROM bridge_services s
    LEFT JOIN solar_systems ss ON ss.id = s.system_id
    LEFT JOIN map_regions r ON r.id = ss.region_id
    LEFT JOIN users u ON u.id = s.added_by`;

const shape = (r: ServiceRow) => ({
  ...r, security: r.security != null ? Number(r.security) : null,
  rangeLy: r.rangeLy != null ? Number(r.rangeLy) : SERVICE_DEFAULT_RANGE[r.kind],
});

// GET /api/bridge-services
bridgeServicesRouter.get('/', async (req, res) => {
  const owner = await resolveOwnerId(req);
  try {
    const { rows } = await db.query<ServiceRow>(`${SELECT} WHERE s.owner_id IS NULL OR s.owner_id = $1 ORDER BY ss.name`, [owner]);
    return res.json({
      shared: rows.filter((r) => !r.personal).map(shape),
      personal: rows.filter((r) => r.personal).map(shape),
      defaults: SERVICE_DEFAULT_RANGE,
      canManageShared: canManageShared(req.session.role),
    });
  } catch (err) { log.error('list failed:', err); return res.status(500).json({ error: 'Database query failed' }); }
});

function parseRange(v: unknown): number | null | undefined {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 20 ? Math.round(n * 10) / 10 : undefined;
}

// POST /api/bridge-services { system, kind, rangeLy?, name?, scope }
bridgeServicesRouter.post('/', async (req, res) => {
  const owner = await resolveOwnerId(req);
  if (owner == null) return res.status(401).json({ error: 'Not authenticated' });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const shared = body.scope !== 'personal';
  if (shared && !canManageShared(req.session.role)) return res.status(403).json({ error: 'Only full users and admins edit shared services' });
  const kind = String(body.kind ?? '');
  if (!KINDS.has(kind)) return res.status(400).json({ error: 'kind must be titan, blops or conduit' });
  const system = await resolveSystem(body.system ?? body.systemId);
  if (!system) return res.status(400).json({ error: 'Unknown system' });
  const { rows: sec } = await db.query<{ security: string }>(`SELECT security::text AS security FROM solar_systems WHERE id = $1`, [system.id]);
  if (Number(sec[0]?.security ?? 1) >= 0.45) return res.status(400).json({ error: 'A cyno cannot be lit in high-sec; pick a low or null system' });
  const rangeLy = parseRange(body.rangeLy);
  if (rangeLy === undefined) return res.status(400).json({ error: 'rangeLy must be between 0 and 20' });
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 200) : '';
  try {
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO bridge_services (system_id, kind, range_ly, name, owner_id, added_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [system.id, kind, rangeLy, name, shared ? null : owner, req.session.userId!],
    );
    return res.status(201).json({ id: rows[0].id, system });
  } catch (err) { log.error('insert failed:', err); return res.status(500).json({ error: 'Database query failed' }); }
});

async function loadOwner(id: number): Promise<{ owner_id: number | null } | null> {
  const { rows } = await db.query<{ owner_id: number | null }>(`SELECT owner_id FROM bridge_services WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

// PATCH /api/bridge-services/:id { active?, name?, rangeLy?, kind? }
bridgeServicesRouter.patch('/:id', async (req, res) => {
  const owner = await resolveOwnerId(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  const row = await loadOwner(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.owner_id != null ? row.owner_id !== owner : !canManageShared(req.session.role)) return res.status(403).json({ error: 'Forbidden' });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const sets: string[] = []; const vals: unknown[] = [];
  if (typeof body.active === 'boolean') { vals.push(body.active); sets.push(`active = $${vals.length}`); }
  if (typeof body.name === 'string')    { vals.push(body.name.trim().slice(0, 200)); sets.push(`name = $${vals.length}`); }
  if (typeof body.kind === 'string' && KINDS.has(body.kind)) { vals.push(body.kind); sets.push(`kind = $${vals.length}`); }
  if ('rangeLy' in body) {
    const r = parseRange(body.rangeLy);
    if (r === undefined) return res.status(400).json({ error: 'rangeLy must be between 0 and 20' });
    vals.push(r); sets.push(`range_ly = $${vals.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });
  vals.push(id);
  await db.query(`UPDATE bridge_services SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length}`, vals);
  return res.json({ ok: true });
});

// DELETE /api/bridge-services/:id
bridgeServicesRouter.delete('/:id', async (req, res) => {
  const owner = await resolveOwnerId(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  const row = await loadOwner(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.owner_id != null ? row.owner_id !== owner : !canManageShared(req.session.role)) return res.status(403).json({ error: 'Forbidden' });
  await db.query(`DELETE FROM bridge_services WHERE id = $1`, [id]);
  return res.json({ ok: true });
});

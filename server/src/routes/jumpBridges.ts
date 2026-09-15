// Ansiblex jump bridges for the fleet route planner: the shared alliance table
// (structure readers + pasted lists, managed by full/admin users), each
// account's personal bridges, per-account exclusions, and the structure
// readers themselves (admin only).
import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { isAdmin, type Role } from '../middleware/authContext.js';
import { resolveOwnerId } from '../utils/owner.js';
import { createLogger } from '../utils/logger.js';
import { parseBridgeLine } from '../services/jumpBridgeNames.js';
import { resolveSystem, resolveSystemNames } from '../services/fleetRouteGraph.js';
import { syncStructureReaders } from '../services/structureReaderSync.js';
import { bridgeUsability, type BridgeUsability } from '../services/bridgeState.js';
import { projectBridgesSoon } from '../services/bridgeMapSync.js';

const log = createLogger('jumpBridges');
export const jumpBridgesRouter = Router();
jumpBridgesRouter.use(requireAuth);

/** Shared bridges and services are edited by `full` users and admins. */
export function canManageShared(role: Role | undefined): boolean {
  return role === 'full' || (role != null && isAdmin(role));
}

const MAX_BULK_LINES = 500;

interface BridgeRow {
  id: number; fromSystemId: number; fromName: string | null; toSystemId: number; toName: string | null;
  name: string; ownerCorpId: number | null; source: string; active: boolean; missedSyncs: number;
  lastSeenAt: string | null; addedBy: string | null; personal: boolean; createdAt: string;
  esiState: string | null; stateTimerEnd: string | null; fuelExpiresAt: string | null; serviceOnline: boolean | null;
}

const SELECT_BRIDGES = `
  SELECT b.id, b.from_system_id AS "fromSystemId", sf.name AS "fromName",
         b.to_system_id AS "toSystemId", st.name AS "toName",
         b.name, b.owner_corp_id AS "ownerCorpId", b.source, b.active, b.missed_syncs AS "missedSyncs",
         b.last_seen_at AS "lastSeenAt", u.character_name AS "addedBy",
         b.esi_state AS "esiState", b.state_timer_end AS "stateTimerEnd", b.fuel_expires_at AS "fuelExpiresAt", b.service_online AS "serviceOnline",
         (b.owner_id IS NOT NULL) AS personal, b.created_at AS "createdAt"
    FROM jump_bridges b
    LEFT JOIN solar_systems sf ON sf.id = b.from_system_id
    LEFT JOIN solar_systems st ON st.id = b.to_system_id
    LEFT JOIN users u ON u.id = b.added_by`;

// GET /api/jump-bridges — shared + the caller's personal bridges + exclusions.
jumpBridgesRouter.get('/', async (req, res) => {
  const owner = await resolveOwnerId(req);
  try {
    const { rows } = await db.query<BridgeRow>(
      `${SELECT_BRIDGES} WHERE b.owner_id IS NULL OR b.owner_id = $1 ORDER BY sf.name, st.name`, [owner],
    );
    const { rows: ex } = await db.query<{ kind: string; targetId: number }>(
      `SELECT kind, target_id AS "targetId" FROM bridge_exclusions WHERE owner_id = $1`, [owner],
    );
    const corpIds = [...new Set(rows.map((r) => r.ownerCorpId).filter((x): x is number => x != null))];
    const corpNames = new Map<number, string>();
    if (corpIds.length) {
      const { rows: cn } = await db.query<{ corpId: number; corpName: string }>(
        `SELECT DISTINCT corp_id AS "corpId", corp_name AS "corpName" FROM structure_readers WHERE corp_id = ANY($1::int[])`, [corpIds]);
      cn.forEach((c) => corpNames.set(c.corpId, c.corpName));
    }
    const withCorp = rows.map((r): BridgeRow & { ownerCorpName: string | null; usability: BridgeUsability } => ({
      ...r, ownerCorpName: r.ownerCorpId != null ? corpNames.get(r.ownerCorpId) ?? null : null, usability: bridgeUsability(r),
    }));
    // How many of the shared bridges are currently drawn on the alliance maps.
    const { rows: drawn } = await db.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM map_connections c JOIN maps m ON m.id = c.map_id
        WHERE c.jump_bridge_id IS NOT NULL AND m.alliance_id IS NOT NULL`,
    );
    return res.json({
      shared: withCorp.filter((r) => !r.personal),
      personal: withCorp.filter((r) => r.personal),
      excludedBridges: ex.filter((e) => e.kind === 'bridge').map((e) => e.targetId),
      excludedServices: ex.filter((e) => e.kind === 'service').map((e) => e.targetId),
      canManageShared: canManageShared(req.session.role),
      drawnLinks: Number(drawn[0]?.n ?? 0),
    });
  } catch (err) { log.error('list failed:', err); return res.status(500).json({ error: 'Database query failed' }); }
});

async function insertBridge(a: number, b: number, name: string, ownerId: number | null, addedBy: number): Promise<'added' | 'exists'> {
  const { rowCount } = await db.query(
    `INSERT INTO jump_bridges (from_system_id, to_system_id, owner_id, name, source, added_by, last_seen_at)
     VALUES ($1, $2, $3, $4, 'manual', $5, NOW())
     ON CONFLICT (LEAST(from_system_id, to_system_id), GREATEST(from_system_id, to_system_id), COALESCE(owner_id, 0)) DO NOTHING`,
    [a, b, ownerId, name, addedBy],
  );
  return rowCount ? 'added' : 'exists';
}

// POST /api/jump-bridges { from, to, name?, scope: 'shared' | 'personal' }
jumpBridgesRouter.post('/', async (req, res) => {
  const owner = await resolveOwnerId(req);
  if (owner == null) return res.status(401).json({ error: 'Not authenticated' });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const shared = body.scope !== 'personal';
  if (shared && !canManageShared(req.session.role)) return res.status(403).json({ error: 'Only full users and admins edit shared bridges' });
  const [a, b] = await Promise.all([resolveSystem(body.from), resolveSystem(body.to)]);
  if (!a || !b) return res.status(400).json({ error: 'Unknown system name' });
  if (a.id === b.id) return res.status(400).json({ error: 'A bridge needs two different systems' });
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
  try {
    const status = await insertBridge(a.id, b.id, name, shared ? null : owner, req.session.userId!);
    if (shared && status === 'added') projectBridgesSoon();
    return res.status(status === 'added' ? 201 : 200).json({ status, from: a, to: b });
  } catch (err) { log.error('insert failed:', err); return res.status(500).json({ error: 'Database query failed' }); }
});

// POST /api/jump-bridges/bulk { text, scope } — one bridge per line.
jumpBridgesRouter.post('/bulk', async (req, res) => {
  const owner = await resolveOwnerId(req);
  if (owner == null) return res.status(401).json({ error: 'Not authenticated' });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const shared = body.scope !== 'personal';
  if (shared && !canManageShared(req.session.role)) return res.status(403).json({ error: 'Only full users and admins edit shared bridges' });
  const text = typeof body.text === 'string' ? body.text : '';
  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_BULK_LINES) return res.status(400).json({ error: `At most ${MAX_BULK_LINES} lines per paste` });

  const parsed = lines.map((line, i) => ({ line: i + 1, text: line, ends: parseBridgeLine(line) }));
  const names = await resolveSystemNames(parsed.flatMap((p) => (p.ends ? [p.ends.a, p.ends.b] : [])));
  let added = 0, skipped = 0;
  const errors: { line: number; text: string; reason: string }[] = [];
  try {
    for (const p of parsed) {
      if (!p.text.trim() || p.text.trim().startsWith('#')) continue;
      if (!p.ends) { errors.push({ line: p.line, text: p.text, reason: 'Could not read two system names' }); continue; }
      const a = names.get(p.ends.a.toLowerCase()), b = names.get(p.ends.b.toLowerCase());
      if (!a) { errors.push({ line: p.line, text: p.text, reason: `Unknown system "${p.ends.a}"` }); continue; }
      if (!b) { errors.push({ line: p.line, text: p.text, reason: `Unknown system "${p.ends.b}"` }); continue; }
      if (a.id === b.id) { errors.push({ line: p.line, text: p.text, reason: 'Both ends are the same system' }); continue; }
      const status = await insertBridge(a.id, b.id, p.ends.label.slice(0, 120), shared ? null : owner, req.session.userId!);
      if (status === 'added') added++; else skipped++;
    }
  } catch (err) { log.error('bulk insert failed:', err); return res.status(500).json({ error: 'Database query failed' }); }
  if (shared && added > 0) projectBridgesSoon();
  return res.json({ added, skipped, errors });
});

// PATCH /api/jump-bridges/:id { active?, name? }
jumpBridgesRouter.patch('/:id', async (req, res) => {
  const owner = await resolveOwnerId(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { rows } = await db.query<{ owner_id: number | null }>(`SELECT owner_id FROM jump_bridges WHERE id = $1`, [id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const personal = rows[0].owner_id != null;
  if (personal ? rows[0].owner_id !== owner : !canManageShared(req.session.role)) return res.status(403).json({ error: 'Forbidden' });
  const sets: string[] = []; const vals: unknown[] = [];
  if (typeof body.active === 'boolean') { vals.push(body.active); sets.push(`active = $${vals.length}`); }
  if (typeof body.name === 'string')    { vals.push(body.name.trim().slice(0, 120)); sets.push(`name = $${vals.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });
  // A manual reactivation also clears the "missing from ESI" parking.
  if (body.active === true) sets.push('missed_syncs = 0');
  vals.push(id);
  await db.query(`UPDATE jump_bridges SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length}`, vals);
  if (!personal) projectBridgesSoon();
  return res.json({ ok: true });
});

// DELETE /api/jump-bridges/:id
jumpBridgesRouter.delete('/:id', async (req, res) => {
  const owner = await resolveOwnerId(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  const { rows } = await db.query<{ owner_id: number | null }>(`SELECT owner_id FROM jump_bridges WHERE id = $1`, [id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const personal = rows[0].owner_id != null;
  if (personal ? rows[0].owner_id !== owner : !canManageShared(req.session.role)) return res.status(403).json({ error: 'Forbidden' });
  await db.query(`DELETE FROM jump_bridges WHERE id = $1`, [id]);
  if (!personal) projectBridgesSoon();
  return res.json({ ok: true });
});

// PUT /api/jump-bridges/exclusions { bridges: number[], services: number[] } —
// replaces the caller's "hide from my plans" set.
jumpBridgesRouter.put('/exclusions', async (req, res) => {
  const owner = await resolveOwnerId(req);
  if (owner == null) return res.status(401).json({ error: 'Not authenticated' });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const ids = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 1000) : []);
  const bridges = ids(body.bridges), services = ids(body.services);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM bridge_exclusions WHERE owner_id = $1`, [owner]);
    if (bridges.length)  await client.query(`INSERT INTO bridge_exclusions (owner_id, kind, target_id) SELECT $1, 'bridge', UNNEST($2::int[])`, [owner, bridges]);
    if (services.length) await client.query(`INSERT INTO bridge_exclusions (owner_id, kind, target_id) SELECT $1, 'service', UNNEST($2::int[])`, [owner, services]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK'); log.error('exclusions failed:', err);
    return res.status(500).json({ error: 'Database query failed' });
  } finally { client.release(); }
  return res.json({ ok: true, excludedBridges: bridges, excludedServices: services });
});

// ── Structure readers (admin) ────────────────────────────────────────────────

// GET /api/jump-bridges/readers
jumpBridgesRouter.get('/readers', requireAdmin, async (_req, res) => {
  const { rows } = await db.query(
    `SELECT r.character_id AS "characterId", r.character_name AS "characterName", r.corp_id AS "corpId",
            r.corp_name AS "corpName", r.role, r.gates_found AS "gatesFound", r.last_sync_at AS "lastSyncAt",
            r.last_error AS "lastError", u.character_name AS "addedBy", r.created_at AS "createdAt"
            , (r.user_id IS NOT NULL) AS "viaUsers"
       FROM structure_readers r LEFT JOIN users u ON u.id = r.added_by
      ORDER BY r.created_at`,
  );
  return res.json({ readers: rows });
});

// POST /api/jump-bridges/readers/sync — run the hourly sync now.
jumpBridgesRouter.post('/readers/sync', requireAdmin, async (_req, res) => {
  try {
    const results = await syncStructureReaders();
    return res.json({ results });
  } catch (err) { log.error('manual sync failed:', err); return res.status(500).json({ error: 'Sync failed' }); }
});

// DELETE /api/jump-bridges/readers/:characterId — forget the reader's token.
// Bridges it discovered stay (they are alliance data, not the reader's).
jumpBridgesRouter.delete('/readers/:characterId', requireAdmin, async (req, res) => {
  const id = Number(req.params.characterId);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  const { rows } = await db.query<{ user_id: number | null }>(`SELECT user_id FROM structure_readers WHERE character_id = $1`, [id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  // Enrolled from Admin › Users: the extra there is the switch, not this button.
  if (rows[0].user_id != null) return res.status(409).json({ error: 'Untick Corp structures for this character in Admin › Users instead' });
  await db.query(`DELETE FROM structure_readers WHERE character_id = $1`, [id]);
  return res.json({ ok: true });
});

import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { sweepAll } from './whSweep.js';
import { sweepConnLifetimes } from './connLifetimeSweep.js';
import { reportPresence, removePresence } from './presence.js';
import type { CollapseAction } from './deadConnections.js';

const dbReady = await ensureIntegrationDb();

const OCCUPIED_EVE_ID = 31000999;

async function seedMap(userId: number, action: CollapseAction): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO maps (user_id, name, lazy_remove_wormholes, collapse_grace_hours, collapse_action)
     VALUES ($1, 'Collapse Map', TRUE, 0.5, $2) RETURNING id`, [userId, action]);
  return rows[0].id;
}

async function seedSystem(
  mapId: string, name: string,
  over: { home?: boolean; locked?: boolean; eveSystemId?: number } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO map_systems (id, map_id, name, system_class, is_home, locked, eve_system_id)
     VALUES ($1, $2, $3, 'C4', $4, $5, $6)`,
    [id, mapId, name, !!over.home, !!over.locked, over.eveSystemId ?? null]);
  return id;
}

// A D382 (16h) wormhole sig on `systemId` pointing at a C4, aged past 16h + 0.5h grace.
async function seedAgedSig(systemId: string, ageHours: number): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO map_signatures (system_id, sig_id, sig_type, wh_type, wh_leads_to, created_at)
     VALUES ($1, 'DEA-D', 'wormhole', 'D382', 'C4', NOW() - ($2 || ' hours')::interval) RETURNING id`,
    [systemId, String(ageHours)]);
  return rows[0].id;
}

async function seedConn(
  mapId: string, src: string, tgt: string,
  over: { sigId?: string; ageHours?: number; whType?: string | null; broken?: boolean } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO map_connections (id, map_id, source_id, target_id, connection_type, wh_type,
                                  source_signature_id, created_at, broken)
     VALUES ($1, $2, $3, $4, 'standard', $5, $6, NOW() - ($7 || ' hours')::interval, $8)`,
    [id, mapId, src, tgt, over.whType === undefined ? 'D382' : over.whType,
     over.sigId ?? null, String(over.ageHours ?? 1), !!over.broken]);
  return id;
}

const connRow = async (id: string) =>
  (await db.query<{ broken: boolean }>(`SELECT broken FROM map_connections WHERE id = $1`, [id])).rows[0] ?? null;
const systemExists = async (id: string) =>
  (await db.query(`SELECT 1 FROM map_systems WHERE id = $1`, [id])).rows.length > 0;

/**
 * The chain every case starts from:
 *
 *   HOME —live— A —dead— B —live— C
 *                        ├—live— LOCKED
 *                        └—live— OCCUPIED   (a viewer is sitting in it)
 *
 * The dead hole is a D382 (16h) created 20h ago whose sig sits on A, also 20h
 * old — past max life + the 0.5h grace for both the sig sweep and the lifetime
 * sweep. The live links are untyped, so neither sweep ever looks at them.
 */
async function seedChain(mapId: string, over: { noHome?: boolean; deadBroken?: boolean } = {}) {
  const home     = await seedSystem(mapId, 'HOME', { home: !over.noHome });
  const a        = await seedSystem(mapId, 'A');
  const b        = await seedSystem(mapId, 'B');
  const c        = await seedSystem(mapId, 'C');
  const locked   = await seedSystem(mapId, 'LOCKED', { locked: true });
  const occupied = await seedSystem(mapId, 'OCCUPIED', { eveSystemId: OCCUPIED_EVE_ID });
  await seedConn(mapId, home, a, { whType: null });
  const sig  = await seedAgedSig(a, 20);
  const dead = await seedConn(mapId, a, b, { sigId: sig, ageHours: 20, broken: over.deadBroken });
  const bc   = await seedConn(mapId, b, c, { whType: null });
  await seedConn(mapId, b, locked, { whType: null });
  await seedConn(mapId, b, occupied, { whType: null });
  return { home, a, b, c, locked, occupied, sig, dead, bc };
}

async function withViewerIn(mapId: string, eveSystemId: number, run: () => Promise<void>): Promise<void> {
  reportPresence(mapId, { characterId: 1, characterName: 'Scout', eveSystemId, shipTypeId: null }, null);
  try { await run(); } finally { removePresence(mapId, 1); }
}

describe.skipIf(!dbReady)('collapse action (integration)', () => {
  let ownerId: number;
  beforeEach(async () => {
    await truncateAll();
    ownerId = await seedUser({ characterId: 901 });
  });

  describe('via the sig sweep', () => {
    it("'break' quarantines the dead connection and keeps every system", async () => {
      const mapId = await seedMap(ownerId, 'break');
      const s = await seedChain(mapId);
      await sweepAll();
      expect((await connRow(s.dead))?.broken).toBe(true);
      for (const id of [s.home, s.a, s.b, s.c, s.locked, s.occupied]) expect(await systemExists(id)).toBe(true);
    });

    it("'disconnect' deletes the dead connection and keeps every system", async () => {
      const mapId = await seedMap(ownerId, 'disconnect');
      const s = await seedChain(mapId);
      await sweepAll();
      expect(await connRow(s.dead)).toBeNull();
      expect(await connRow(s.bc)).not.toBeNull();
      for (const id of [s.home, s.a, s.b, s.c, s.locked, s.occupied]) expect(await systemExists(id)).toBe(true);
    });

    it("'prune' also deletes the cut-off branch, keeping home, locked and occupied systems", async () => {
      const mapId = await seedMap(ownerId, 'prune');
      const s = await seedChain(mapId);
      await withViewerIn(mapId, OCCUPIED_EVE_ID, () => sweepAll());
      expect(await connRow(s.dead)).toBeNull();
      expect(await systemExists(s.b)).toBe(false);
      expect(await systemExists(s.c)).toBe(false);
      expect(await connRow(s.bc)).toBeNull();           // cascaded with B
      expect(await systemExists(s.home)).toBe(true);
      expect(await systemExists(s.a)).toBe(true);
      expect(await systemExists(s.locked)).toBe(true);
      expect(await systemExists(s.occupied)).toBe(true);
    });

    it("'prune' on a map with no home system only disconnects", async () => {
      const mapId = await seedMap(ownerId, 'prune');
      const s = await seedChain(mapId, { noHome: true });
      await sweepAll();
      expect(await connRow(s.dead)).toBeNull();
      for (const id of [s.home, s.a, s.b, s.c, s.locked, s.occupied]) expect(await systemExists(id)).toBe(true);
    });

    it("'disconnect' still removes a hole another heuristic quarantined first", async () => {
      const mapId = await seedMap(ownerId, 'disconnect');
      const s = await seedChain(mapId, { deadBroken: true });
      await sweepAll();
      expect(await connRow(s.dead)).toBeNull();
    });
  });

  describe('via the lifetime sweep', () => {
    it("'disconnect' deletes a connection that outlived its type; a 'break' map's quarantined hole is left alone", async () => {
      const disc = await seedMap(ownerId, 'disconnect');
      const s1 = await seedChain(disc);
      const brk = await seedMap(ownerId, 'break');
      const s2 = await seedChain(brk, { deadBroken: true });

      await sweepConnLifetimes();

      expect(await connRow(s1.dead)).toBeNull();
      expect((await connRow(s2.dead))?.broken).toBe(true);
      for (const id of [s1.home, s1.a, s1.b, s1.c]) expect(await systemExists(id)).toBe(true);
    });

    it("'prune' deletes the connection and the cut-off branch", async () => {
      const mapId = await seedMap(ownerId, 'prune');
      const s = await seedChain(mapId);
      await withViewerIn(mapId, OCCUPIED_EVE_ID, () => sweepConnLifetimes());
      expect(await connRow(s.dead)).toBeNull();
      expect(await systemExists(s.b)).toBe(false);
      expect(await systemExists(s.c)).toBe(false);
      expect(await systemExists(s.locked)).toBe(true);
      expect(await systemExists(s.occupied)).toBe(true);
      expect(await systemExists(s.a)).toBe(true);
    });
  });
});

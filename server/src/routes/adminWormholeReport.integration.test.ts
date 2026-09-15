import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Alliance install: the report is scoped to the caller's alliance maps, which is
// how production runs (ALLIANCE_ID set, admin pinned to alliance_admin).
const state = vi.hoisted(() => ({ over: {} as Record<string, unknown> }));
vi.mock('../config.js', async (importActual) => {
  const base = (await importActual<typeof import('../config.js')>()).config as Record<string, unknown>;
  return { config: new Proxy({}, { get: (_t, k: string) => (k in state.over ? state.over[k] : base[k]) }) };
});

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { reportsRouter } from './admin.js';

const dbReady = await ensureIntegrationDb();

const ALLIANCE = 2000;

function makeApp(userId: number) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { session: Record<string, unknown> }).session = {
      userId, characterId: 1, role: 'alliance_admin', userCorpId: null, userAllianceId: ALLIANCE, ownerId: null,
    };
    next();
  });
  app.use('/api/admin/reports', reportsRouter);
  return app;
}

interface Row { userId: number; characterName: string; jumped: number; typed: number; wormholes: number }
interface Resp { month: string; totalHoles: number; rows: Row[] }

describe.skipIf(!dbReady)('wormhole credits report (integration)', () => {
  let adminId: number;
  let scannerId: number;
  let jumperId: number;

  // Two credited holes in September 2026 and one in August: a shared hole (the
  // scanner typed its code, another pilot jumped it: half each) and one the
  // scanner did alone. The regression this guards: the month parameter used to
  // be ignored, so every month showed the previous month's figures.
  beforeEach(async () => {
    await truncateAll();
    state.over = { corpMode: false, allianceMode: true, allianceIds: [ALLIANCE], restrictedMode: true, adminCharId: null, reportsCharId: null };
    // No corp id on purpose: a real one would send the report to ESI for the ticker.
    adminId   = await seedUser({ characterId: 1, allianceId: ALLIANCE, role: 'alliance_admin', name: 'Admin' });
    scannerId = await seedUser({ characterId: 2, allianceId: ALLIANCE, role: 'edit', name: 'Scanner' });
    jumperId  = await seedUser({ characterId: 3, allianceId: ALLIANCE, role: 'edit', name: 'Jumper' });
    const mapId = (await db.query<{ id: string }>(
      `INSERT INTO maps (user_id, name, alliance_id) VALUES ($1, 'Alliance Map', $2) RETURNING id`, [adminId, ALLIANCE],
    )).rows[0].id;
    const credit = (jumper: number, typer: number, code: string, at: string) => db.query(
      `INSERT INTO wh_credits (connection_id, map_id, jumper_user_id, typer_user_id, wh_type, from_eve_system_id, to_eve_system_id, credited_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 31000001, 30000142, $5)`,
      [mapId, jumper, typer, code, at],
    );
    await credit(jumperId, scannerId, 'Z971', '2026-09-15T21:51:00Z');
    await credit(scannerId, scannerId, 'N110', '2026-09-15T22:11:00Z');
    await credit(scannerId, scannerId, 'C247', '2026-08-03T10:00:00Z');
  });

  it('reports the month that was asked for', async () => {
    const res = await request(makeApp(adminId)).get('/api/admin/reports/wormholes?month=2026-09');
    expect(res.status).toBe(200);
    const body = res.body as Resp;
    expect(body.month).toBe('2026-09');
    expect(body.totalHoles).toBe(2);
    const byName = Object.fromEntries(body.rows.map((r) => [r.characterName, r]));
    expect(byName.Scanner).toMatchObject({ jumped: 1, typed: 2, wormholes: 1.5 });
    expect(byName.Jumper).toMatchObject({ jumped: 1, typed: 0, wormholes: 0.5 });
  });

  it('a different month gives that month, not the default', async () => {
    const res = await request(makeApp(adminId)).get('/api/admin/reports/wormholes?month=2026-08');
    expect(res.status).toBe(200);
    const body = res.body as Resp;
    expect(body.month).toBe('2026-08');
    expect(body.totalHoles).toBe(1);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ characterName: 'Scanner', jumped: 1, typed: 1, wormholes: 1 });
  });

  it('a malformed month falls back to the previous calendar month', async () => {
    const res = await request(makeApp(adminId)).get('/api/admin/reports/wormholes?month=nonsense');
    expect(res.status).toBe(200);
    const now = new Date();
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    expect((res.body as Resp).month).toBe(`${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`);
  });
});

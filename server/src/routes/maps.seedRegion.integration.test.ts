import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { mapsRouter } from './maps.js';

const dbReady = await ensureIntegrationDb();

// Bare app: the real mapsRouter (incl. the real access checks) behind a fake
// session. The session user owns the map, so requireMapWrite passes on role.
function makeApp(userId: number) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { session: Record<string, unknown> }).session =
      { userId, characterId: 900, role: 'full', userCorpId: null, userAllianceId: null };
    next();
  });
  app.use('/api/maps', mapsRouter);
  return app;
}

async function seedMap(userId: number, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO maps (user_id, name) VALUES ($1, $2) RETURNING id`, [userId, name]);
  return rows[0].id;
}

// Two tiny K-space regions joined by one regional gate:
//
//   Fade (2):        C ── D      (star-map Y = 10: due NORTH of Pure Blind)
//                    │
//   regional gate:   │ (B ── C)
//                    │
//   Pure Blind (1):  A ── B      (star-map Y = 0)
//
// Every gate has a reverse twin, like the real SDE table.
const A = 30000001, B = 30000002, C = 30000003, D = 30000004;
async function seedSde(): Promise<void> {
  await db.query(`INSERT INTO map_regions (id, name) VALUES (1, 'Pure Blind'), (2, 'Fade')`);
  await db.query(
    `INSERT INTO solar_systems (id, name, region_id, pos2d_x, pos2d_y) VALUES
       ($1, 'A-1', 1, 0, 0), ($2, 'B-2', 1, 1, 0),
       ($3, 'C-3', 2, 0, 10), ($4, 'D-4', 2, 1, 10)`,
    [A, B, C, D]);
  const gates: [number, number][] = [[A, B], [B, A], [C, D], [D, C], [B, C], [C, B]];
  for (const [i, [from, to]] of gates.entries()) {
    await db.query(
      `INSERT INTO map_stargates (id, system_id, destination_gate_id, destination_system_id)
       VALUES ($1, $2, 0, $3)`, [i + 1, from, to]);
  }
}

async function systems(mapId: string) {
  const { rows } = await db.query<{ eve: number; region: string; x: number; y: number }>(
    `SELECT eve_system_id AS eve, region_name AS region, position_x AS x, position_y AS y
       FROM map_systems WHERE map_id = $1 ORDER BY eve_system_id`, [mapId]);
  return rows;
}
async function connections(mapId: string) {
  const { rows } = await db.query<{ a: number; b: number; type: string }>(
    `SELECT LEAST(s.eve_system_id, t.eve_system_id) AS a, GREATEST(s.eve_system_id, t.eve_system_id) AS b,
            c.connection_type AS type
       FROM map_connections c
       JOIN map_systems s ON s.id = c.source_id
       JOIN map_systems t ON t.id = c.target_id
      WHERE c.map_id = $1 ORDER BY 1, 2`, [mapId]);
  return rows;
}

describe.skipIf(!dbReady)('POST /api/maps/:id/seed-region (integration)', () => {
  let app: express.Express;
  let mapId: string;

  beforeEach(async () => {
    await truncateAll();
    const ownerId = await seedUser({ characterId: 900, role: 'full' });
    app = makeApp(ownerId);
    mapId = await seedMap(ownerId, 'Chain');
    await seedSde();
  });

  it('seeds a first region into an empty map with its stargates', async () => {
    const res = await request(app).post(`/api/maps/${mapId}/seed-region`).send({ regionId: 1 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ systems: 2, connections: 1, skipped: 0, region: 'Pure Blind' });
    expect((await systems(mapId)).map((s) => s.eve)).toEqual([A, B]);
    expect(await connections(mapId)).toEqual([{ a: A, b: B, type: 'gate' }]);
  });

  it('appends a second region on its true compass side (north → above) and wires the regional gate', async () => {
    await request(app).post(`/api/maps/${mapId}/seed-region`).send({ regionId: 1 });
    const res = await request(app).post(`/api/maps/${mapId}/seed-region`).send({ regionId: 2 });
    expect(res.status).toBe(201);
    // C-D inside Fade plus the B-C regional gate to the region already on the map.
    expect(res.body).toEqual({ systems: 2, connections: 2, skipped: 0, region: 'Fade' });

    const sys = await systems(mapId);
    expect(sys.map((s) => s.eve)).toEqual([A, B, C, D]);
    expect(sys.map((s) => s.region)).toEqual(['Pure Blind', 'Pure Blind', 'Fade', 'Fade']);
    // Fade is north of Pure Blind in star-map space, so its block lands ABOVE
    // (screen Y grows down), clear of the existing content, not off to the right.
    const pb   = sys.filter((s) => s.region === 'Pure Blind');
    const fade = sys.filter((s) => s.region === 'Fade');
    const pbMinY   = Math.min(...pb.map((s) => Number(s.y)));
    const fadeMaxY = Math.max(...fade.map((s) => Number(s.y)));
    expect(fadeMaxY).toBeLessThan(pbMinY - 300);
    const pbMinX = Math.min(...pb.map((s) => Number(s.x))), pbMaxX = Math.max(...pb.map((s) => Number(s.x)));
    const fadeMinX = Math.min(...fade.map((s) => Number(s.x)));
    expect(fadeMinX).toBeGreaterThanOrEqual(pbMinX - 600);
    expect(fadeMinX).toBeLessThanOrEqual(pbMaxX + 600);

    expect(await connections(mapId)).toEqual([
      { a: A, b: B, type: 'gate' },
      { a: B, b: C, type: 'gate' },
      { a: C, b: D, type: 'gate' },
    ]);
  });

  it('is idempotent — re-seeding a region already on the map adds nothing', async () => {
    await request(app).post(`/api/maps/${mapId}/seed-region`).send({ regionId: 1 });
    const res = await request(app).post(`/api/maps/${mapId}/seed-region`).send({ regionId: 1 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ systems: 0, connections: 0, skipped: 2, region: 'Pure Blind' });
    expect((await systems(mapId)).length).toBe(2);
    expect((await connections(mapId)).length).toBe(1);
  });

  it('never resurrects a gate the users removed between systems already on the map', async () => {
    await request(app).post(`/api/maps/${mapId}/seed-region`).send({ regionId: 1 });
    await db.query(`DELETE FROM map_connections WHERE map_id = $1`, [mapId]); // users dropped A-B
    const res = await request(app).post(`/api/maps/${mapId}/seed-region`).send({ regionId: 1 });
    expect(res.body).toEqual({ systems: 0, connections: 0, skipped: 2, region: 'Pure Blind' });
    expect(await connections(mapId)).toEqual([]);
  });

  it('rejects a missing regionId and an unknown region', async () => {
    expect((await request(app).post(`/api/maps/${mapId}/seed-region`).send({})).status).toBe(400);
    expect((await request(app).post(`/api/maps/${mapId}/seed-region`).send({ regionId: 999 })).status).toBe(404);
  });
});

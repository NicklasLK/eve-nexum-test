import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import statsRouter from './stats.js';

const dbReady = await ensureIntegrationDb();

function appFor(userId: number) {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { session: Record<string, unknown> }).session = { userId };
    next();
  });
  app.use('/api/stats', statsRouter);
  return app;
}

const JITA = 30000142, J_HOLE = 31000005;

async function credit(mapId: string, o: { jumper: number | null; typer: number | null; code: string; hoursAgo: number; from?: number; to?: number }) {
  await db.query(
    `INSERT INTO wh_credits (connection_id, map_id, jumper_user_id, typer_user_id, wh_type, from_eve_system_id, to_eve_system_id, credited_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW() - ($7 || ' hours')::interval)`,
    [mapId, o.jumper, o.typer, o.code, o.from ?? J_HOLE, o.to ?? JITA, o.hoursAgo],
  );
}

describe.skipIf(!dbReady)('GET /api/stats wormhole credits (integration)', () => {
  let me: number, mate: number, mapId: string;

  beforeEach(async () => {
    await truncateAll();
    // wh_credits has no FK to users or maps (it outlives both), so the harness
    // truncate list does not reach it.
    await db.query(`DELETE FROM wh_credits`);
    await db.query(`INSERT INTO map_regions (id, name) VALUES (10000002, 'The Forge')`);
    await db.query(`INSERT INTO solar_systems (id, name, class, region_id) VALUES ($1, 'Jita', 'HS', 10000002), ($2, 'J123456', 'C3', NULL)`, [JITA, J_HOLE]);
    me   = await seedUser({ characterId: 1, role: 'full', name: 'Me' });
    mate = await seedUser({ characterId: 2, role: 'full', name: 'Mate' });
    const { rows } = await db.query<{ id: string }>(`INSERT INTO maps (user_id, name) VALUES ($1, 'Home') RETURNING id`, [me]);
    mapId = rows[0].id;
  });

  it('lists the holes behind the card, newest first, from the pilot\'s side', async () => {
    await credit(mapId, { jumper: me,   typer: me,   code: 'N944', hoursAgo: 1 });          // mine alone → 1
    await credit(mapId, { jumper: me,   typer: mate, code: 'C247', hoursAgo: 3 * 24 });     // I jumped, Mate named → ½
    await credit(mapId, { jumper: mate, typer: me,   code: 'H296', hoursAgo: 40 * 24 });    // Mate jumped, I named → ½
    await credit(mapId, { jumper: mate, typer: mate, code: 'B274', hoursAgo: 2 });          // not mine → not listed

    const res = await request(appFor(me)).get('/api/stats').expect(200);

    expect(res.body.day.wormholes).toBe(1);
    expect(res.body.week.wormholes).toBe(1.5);
    expect(res.body.forever.wormholes).toBe(2);
    expect(res.body.creditsTruncated).toBe(false);
    expect(typeof res.body.generatedAt).toBe('string');

    const codes = res.body.credits.map((c: { whType: string }) => c.whType);
    expect(codes).toEqual(['N944', 'C247', 'H296']);

    const [own, jumped, named] = res.body.credits;
    expect(own).toMatchObject({
      whType: 'N944', role: 'both', partnerName: null, mapName: 'Home',
      fromSystem: 'J123456', fromClass: 'C3', toSystem: 'Jita', toClass: 'HS',
    });
    expect(typeof own.connectionId).toBe('string');
    expect(typeof own.creditedAt).toBe('string');
    expect(jumped).toMatchObject({ whType: 'C247', role: 'jumper', partnerName: 'Mate' });
    expect(named).toMatchObject({ whType: 'H296', role: 'typer',  partnerName: 'Mate' });
  });

  it('shows the raw system id when the SDE has no row for an end, and no partner name once the other pilot is gone', async () => {
    const gone = await seedUser({ characterId: 3, role: 'full', name: 'Gone' });
    await credit(mapId, { jumper: gone, typer: me, code: 'N944', hoursAgo: 1, from: 31009999 });
    await db.query(`DELETE FROM users WHERE id = $1`, [gone]);

    const res = await request(appFor(me)).get('/api/stats').expect(200);
    expect(res.body.credits).toHaveLength(1);
    expect(res.body.credits[0]).toMatchObject({ role: 'typer', partnerName: null, fromSystem: '31009999', fromClass: null });
    expect(res.body.day.wormholes).toBe(0.5);
  });

  it('returns an empty list for a pilot with no credits', async () => {
    const res = await request(appFor(me)).get('/api/stats').expect(200);
    expect(res.body.credits).toEqual([]);
    expect(res.body.forever.wormholes).toBe(0);
  });
});

// Keeps jump_bridges current from the connected structure readers: characters
// (usually alts) holding Station Manager or Director in the corp that owns the
// Ansiblex gates. Each reader's corp structures are listed hourly; every
// Ansiblex found is upserted as a shared bridge (source 'esi'). Gates a reader
// no longer reports are counted as missed; two misses in a row park the bridge
// (missed_syncs >= 2 → unused) but never delete it, so an ESI hiccup or a gate
// mid-unanchor can't silently erase the alliance's network.
//
// Why not ESI structure search: CCP dislikes the search endpoint being used
// this way and it is incomplete anyway. A corp's own structure list is the
// authoritative source.
import { db } from '../db.js';
import { esiFetch } from '../utils/esi.js';
import { getValidToken } from '../utils/eveToken.js';
import { bridgeStateFromEsi, type EsiStructureState } from './bridgeState.js';
import { syncBridgesToAllianceMaps } from './bridgeMapSync.js';
import { decryptToken, encryptToken } from '../utils/tokenCrypto.js';
import { createLogger } from '../utils/logger.js';
import { ANSIBLEX_TYPE_ID, parseAnsiblexName } from './jumpBridgeNames.js';
import { resolveSystemNames } from './fleetRouteGraph.js';

const log = createLogger('structureReaders');
const ESI = 'https://esi.evetech.net/latest';
const EVE_TOKEN_URL = 'https://login.eveonline.com/v2/oauth/token';
const STRUCTURE_ROLES = ['Station_Manager', 'Director'];
const SYNC_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 30 * 1000;

export interface ReaderRow {
  character_id: number; character_name: string; corp_id: number | null; corp_name: string;
  refresh_token: string; role: string; gates_found: number; last_sync_at: string | null; last_error: string | null;
  user_id: number | null;
}

/** EVE rotates refresh tokens on use; persist the new one before anything else. */
async function readerAccessToken(row: ReaderRow): Promise<string> {
  // Enrolled from Admin › Users: the character's own login token.
  if (row.user_id != null) {
    try { return await getValidToken(row.user_id); }
    catch { throw new Error('token refresh failed — ask them to log in again'); }
  }
  const res = await fetch(EVE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${process.env.EVE_CLIENT_ID}:${process.env.EVE_CLIENT_SECRET}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: decryptToken(row.refresh_token) }),
  });
  if (!res.ok) throw new Error(`token refresh failed (${res.status}) — reconnect this reader`);
  const t = await res.json() as { access_token: string; refresh_token: string };
  await db.query(`UPDATE structure_readers SET refresh_token = $1 WHERE character_id = $2`,
    [encryptToken(t.refresh_token), row.character_id]);
  return t.access_token;
}

interface CorpStructure extends EsiStructureState { structure_id: number; type_id: number; system_id?: number; name?: string }

export interface ReaderSyncResult {
  characterId: number; characterName: string; ok: boolean; gates: number; error?: string;
}

/** Sync one reader. Returns the corp id when the structure list was read in full. */
async function syncReader(row: ReaderRow, runStartedAt: Date): Promise<ReaderSyncResult & { corpId?: number }> {
  const base = { characterId: row.character_id, characterName: row.character_name };
  const fail = async (error: string) => {
    await db.query(`UPDATE structure_readers SET last_error = $1, last_sync_at = $2 WHERE character_id = $3`,
      [error, runStartedAt, row.character_id]);
    return { ...base, ok: false, gates: row.gates_found, error };
  };

  let token: string;
  try { token = await readerAccessToken(row); }
  catch (err) { return fail(err instanceof Error ? err.message : 'token refresh failed'); }
  // What fixes a missing scope depends on how the reader was connected.
  const reconnect = row.user_id != null ? 'ask them to press Grant extra access again' : 'reconnect this reader';
  const auth = { headers: { Authorization: `Bearer ${token}` } };

  // The character's current corp (they may have moved since connecting).
  const charRes = await esiFetch(`${ESI}/characters/${row.character_id}/`, auth);
  if (!charRes.ok) return fail(`character lookup failed (${charRes.status})`);
  const corpId = ((await charRes.json()) as { corporation_id: number }).corporation_id;

  const rolesRes = await esiFetch(`${ESI}/characters/${row.character_id}/roles/`, auth);
  if (rolesRes.status === 401 || rolesRes.status === 403) return fail(`roles scope missing — ${reconnect}`);
  if (!rolesRes.ok) return fail(`roles lookup failed (${rolesRes.status})`);
  const roles = ((await rolesRes.json()) as { roles?: string[] }).roles ?? [];
  const role = STRUCTURE_ROLES.find((r) => roles.includes(r)) ?? '';
  if (!role) return fail('character is not a Station Manager or Director in its corp');

  const all: CorpStructure[] = [];
  let page = 1, pages = 1;
  do {
    const res = await esiFetch(`${ESI}/corporations/${corpId}/structures/?page=${page}`, auth);
    if (res.status === 401 || res.status === 403) return fail(`read_structures scope missing — ${reconnect}`);
    if (!res.ok) return fail(`corp structures page ${page} failed (${res.status})`);
    pages = parseInt(res.headers.get('x-pages') ?? '1', 10) || 1;
    all.push(...(await res.json() as CorpStructure[]));
    page++;
  } while (page <= pages);

  const gates = all.filter((s) => s.type_id === ANSIBLEX_TYPE_ID);
  // Names: the corp listing usually carries them; fall back to universe/structures.
  const named = await Promise.all(gates.map(async (s) => {
    if (s.name) return { ...s, name: s.name };
    try {
      const r = await esiFetch(`${ESI}/universe/structures/${s.structure_id}/`, auth);
      if (r.ok) return { ...s, name: ((await r.json()) as { name?: string }).name ?? '' };
    } catch { /* leave blank */ }
    return { ...s, name: '' };
  }));

  const parsed = named.map((s) => ({ ...s, ends: parseAnsiblexName(s.name ?? '') }));
  const names = await resolveSystemNames(parsed.flatMap((p) => (p.ends ? [p.ends.a, p.ends.b] : [])));

  let upserted = 0;
  for (const p of parsed) {
    if (!p.ends) { log.warn(`reader ${row.character_name}: unparseable Ansiblex name "${p.name}"`); continue; }
    const a = names.get(p.ends.a.toLowerCase()), b = names.get(p.ends.b.toLowerCase());
    if (!a || !b || a.id === b.id) { log.warn(`reader ${row.character_name}: unknown system in "${p.name}"`); continue; }
    const st = bridgeStateFromEsi(p);
    await db.query(
      `INSERT INTO jump_bridges (from_system_id, to_system_id, owner_id, name, owner_corp_id, structure_id, source, last_seen_at, missed_syncs, updated_at,
                                 esi_state, state_timer_end, fuel_expires_at, service_online)
       VALUES ($1, $2, NULL, $3, $4, $5, 'esi', $6, 0, NOW(), $7, $8, $9, $10)
       ON CONFLICT (LEAST(from_system_id, to_system_id), GREATEST(from_system_id, to_system_id), COALESCE(owner_id, 0)) DO UPDATE
         SET name = CASE WHEN jump_bridges.source = 'esi' OR jump_bridges.name = '' THEN EXCLUDED.name ELSE jump_bridges.name END,
             owner_corp_id = EXCLUDED.owner_corp_id,
             structure_id  = COALESCE(jump_bridges.structure_id, EXCLUDED.structure_id),
             source        = 'esi',
             last_seen_at  = EXCLUDED.last_seen_at,
             missed_syncs  = 0,
             esi_state       = EXCLUDED.esi_state,
             state_timer_end = EXCLUDED.state_timer_end,
             fuel_expires_at = EXCLUDED.fuel_expires_at,
             service_online  = EXCLUDED.service_online,
             updated_at    = NOW()`,
      [a.id, b.id, p.ends.label || p.name || '', corpId, p.structure_id, runStartedAt,
       st.esiState, st.stateTimerEnd, st.fuelExpiresAt, st.serviceOnline],
    );
    upserted++;
  }

  let corpName = row.corp_name;
  if (corpId !== row.corp_id || !corpName) {
    const cr = await esiFetch(`${ESI}/corporations/${corpId}/`).catch(() => null);
    if (cr?.ok) corpName = ((await cr.json()) as { name?: string }).name ?? corpName;
  }
  // The corp becomes switchable on Admin › Jump bridges › Corporations.
  await db.query(
    `INSERT INTO bridge_corps (corp_id, corp_name) VALUES ($1, $2)
     ON CONFLICT (corp_id) DO UPDATE
       SET corp_name = CASE WHEN EXCLUDED.corp_name <> '' THEN EXCLUDED.corp_name ELSE bridge_corps.corp_name END`,
    [corpId, corpName ?? ''],
  );
  await db.query(
    `UPDATE structure_readers
        SET corp_id = $1, corp_name = $2, role = $3, gates_found = $4, last_sync_at = $5, last_error = NULL
      WHERE character_id = $6`,
    [corpId, corpName, role, upserted, runStartedAt, row.character_id],
  );
  return { ...base, ok: true, gates: upserted, corpId };
}

// Readers enrolled from Admin › Users: every unblocked character that holds
// the 'structures' extra and whose current token carries it. Re-derived on
// every run, so unticking the extra (or blocking the user) drops the reader.
// A character the admin also connected the dedicated way keeps that row.
async function enrolUserReaders(): Promise<void> {
  const qualifies = `NOT u.blocked AND 'structures' = ANY(u.extra_scopes)
                     AND u.granted_scopes LIKE '%esi-corporations.read_structures.v1%'`;
  await db.query(
    `DELETE FROM structure_readers r
      WHERE r.user_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = r.user_id AND ${qualifies})`,
  );
  await db.query(
    `INSERT INTO structure_readers (character_id, character_name, corp_id, refresh_token, scopes, user_id)
     SELECT u.character_id, u.character_name, u.corp_id, '', u.granted_scopes, u.id
       FROM users u
      WHERE ${qualifies} AND u.refresh_token IS NOT NULL
     ON CONFLICT (character_id) DO NOTHING`,
  );
  await db.query(
    `UPDATE structure_readers r
        SET character_name = u.character_name, corp_id = COALESCE(r.corp_id, u.corp_id), scopes = u.granted_scopes
       FROM users u WHERE u.id = r.user_id`,
  );
}

let running: Promise<ReaderSyncResult[]> | null = null;

/** Sync every reader. Concurrent calls share one run. */
export function syncStructureReaders(): Promise<ReaderSyncResult[]> {
  if (running) return running;
  running = (async () => {
    const runStartedAt = new Date();
    await enrolUserReaders();
    // Dedicated readers first, so a user-reader for a corp they already cover is skipped.
    const { rows } = await db.query<ReaderRow>(
      `SELECT character_id, character_name, corp_id, corp_name, refresh_token, role, gates_found, last_sync_at, last_error, user_id
         FROM structure_readers ORDER BY (user_id IS NOT NULL), created_at`,
    );
    const results: ReaderSyncResult[] = [];
    const fullyReadCorps = new Set<number>();
    for (const row of rows) {
      if (row.user_id != null && row.corp_id != null && fullyReadCorps.has(row.corp_id)) {
        // Another reader already read this corp's structures this run.
        await db.query(`UPDATE structure_readers SET last_sync_at = $1, last_error = NULL WHERE character_id = $2`, [runStartedAt, row.character_id]);
        results.push({ characterId: row.character_id, characterName: row.character_name, ok: true, gates: 0 });
        continue;
      }
      try {
        const r = await syncReader(row, runStartedAt);
        results.push(r);
        if (r.ok && r.corpId) fullyReadCorps.add(r.corpId);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.error(`reader ${row.character_name} failed:`, err);
        await db.query(`UPDATE structure_readers SET last_error = $1, last_sync_at = $2 WHERE character_id = $3`,
          [error, runStartedAt, row.character_id]).catch(() => undefined);
        results.push({ characterId: row.character_id, characterName: row.character_name, ok: false, gates: row.gates_found, error });
      }
    }
    // A gate is "missed" only when a reader for its corp completed this run
    // and did not report it — a reader that failed proves nothing.
    if (fullyReadCorps.size) {
      const { rowCount } = await db.query(
        `UPDATE jump_bridges
            SET missed_syncs = missed_syncs + 1, updated_at = NOW()
          WHERE source = 'esi' AND owner_id IS NULL
            AND owner_corp_id = ANY($1::int[])
            AND (last_seen_at IS NULL OR last_seen_at < $2)`,
        [[...fullyReadCorps], runStartedAt],
      );
      if (rowCount) log.info(`${rowCount} bridge(s) not reported this run`);
    }
    if (rows.length) log.info(`synced ${rows.length} reader(s): ${results.filter((r) => r.ok).length} ok, ${results.reduce((n, r) => n + (r.ok ? r.gates : 0), 0)} gates`);
    // Redraw the gate network on the alliance maps from what this run found.
    try { await syncBridgesToAllianceMaps(); }
    catch (err) { log.error('map projection failed:', err); }
    return results;
  })().finally(() => { running = null; });
  return running;
}

let timer: NodeJS.Timeout | null = null;
export function startStructureReaderSync(): void {
  if (timer) return;
  const tick = () => { void syncStructureReaders().catch((err) => log.error('sync failed:', err)); };
  setTimeout(tick, FIRST_RUN_DELAY_MS).unref();
  timer = setInterval(tick, SYNC_INTERVAL_MS);
  timer.unref();
}

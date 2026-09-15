import { db } from '../db.js';
import type { Request } from 'express';
import { resolveOwnerId } from '../utils/owner.js';

/**
 * The one thing a 'contributor' may do to a map's shape: record their own
 * movement. They cannot add a system by hand — not from the right-click menu,
 * not via "add adjacent" — and they cannot draw, edit or delete connections.
 *
 * The difference between "I jumped here" and "I clicked here" can't be taken on
 * the client's word: a flag in the request body is trivially forged. So it's
 * verified against where the character actually IS, which the location poll
 * writes to users.last_known_system_id before the client is ever told it moved.
 * A tracked add therefore always matches; a right-click on some other system
 * never does.
 *
 * The system the pilot has JUST left counts too, for a few minutes. With "don't
 * track K-space" on, the tracker records the K-space system a pilot departed
 * from only once they jump out of it into J-space — after the fact, when they
 * are already in the J system. The location poll keeps that departed system as
 * users.prev_known_system_id, and last_known_system_at (the moment of the move)
 * bounds how long it stays provable, so it can never be used to add somewhere
 * the pilot was hours ago.
 *
 * Checked across the whole account, not just the session character: a tab can be
 * pinned to an alt (routeOrigin), so the pilot doing the moving may not be the
 * one the session is bound to.
 */
const JUST_LEFT_WINDOW = '10 minutes';

export async function contributorIsAtSystem(req: Request, eveSystemId: number): Promise<boolean> {
  if (!Number.isInteger(eveSystemId) || eveSystemId <= 0) return false;
  const userId = req.session.userId;
  if (!userId) return false;
  const ownerId = await resolveOwnerId(req);
  const { rowCount } = await db.query(
    `SELECT 1 FROM users
      WHERE (last_known_system_id = $1
             OR (prev_known_system_id = $1
                 AND last_known_system_at > NOW() - $4::interval))
        AND (id = $2 OR ($3::int IS NOT NULL AND owner_id = $3))
      LIMIT 1`,
    [eveSystemId, userId, ownerId, JUST_LEFT_WINDOW],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * True when one END of a proposed connection is where the caller actually is —
 * i.e. it's the link their own jump just made. Either endpoint counts: the map
 * node for the system they arrived in is created moments before the connection,
 * and which of source/target it lands on depends on the direction of travel.
 */
export async function contributorMayLinkSystems(
  req: Request, sourceMapSystemId: string, targetMapSystemId: string,
): Promise<boolean> {
  const { rows } = await db.query<{ eve: number | null }>(
    `SELECT eve_system_id AS eve FROM map_systems WHERE id = ANY($1::uuid[])`,
    [[sourceMapSystemId, targetMapSystemId]],
  );
  for (const r of rows) {
    if (r.eve != null && await contributorIsAtSystem(req, r.eve)) return true;
  }
  return false;
}

/**
 * The one PATCH a contributor may make to an existing connection: `{ broken:
 * false }`, alone. The tracker sends it when a pilot physically jumps a link
 * that had been quarantined — crossing it is proof it's live. Breaking one, or
 * un-breaking together with any other field, is editing and stays refused.
 */
export function isUnbreakOnly(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const keys = Object.keys(body as object);
  return keys.length === 1 && keys[0] === 'broken' && (body as { broken: unknown }).broken === false;
}

/** Same proof as creating the link: one end of it is where the pilot is. */
export async function contributorMayUnbreakConnection(
  req: Request, mapId: string, connectionId: string,
): Promise<boolean> {
  let rows: Array<{ src: string; tgt: string }>;
  try {
    ({ rows } = await db.query<{ src: string; tgt: string }>(
      `SELECT source_id AS src, target_id AS tgt FROM map_connections WHERE id = $1 AND map_id = $2`,
      [connectionId, mapId],
    ));
  } catch {
    return false; // not even a uuid — not a connection of theirs
  }
  if (!rows.length) return false;
  return contributorMayLinkSystems(req, rows[0].src, rows[0].tgt);
}

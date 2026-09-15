// How a connection came to exist and who first named its wormhole code — the
// two facts the wormhole credits are built on (plans/wh-scan-bounties.md).
import { db } from '../db.js';

export type ConnectionOrigin = 'manual' | 'jump' | 'merge' | 'bridge_sync';

/**
 * The client says 'jump' for a link its location tracking drew. The server
 * believes it only when the pilot is actually at one end of the link, so a
 * hand-drawn connection can never pose as a jump. Anything else is 'manual'.
 */
export function resolveCreatedVia(
  requested: unknown, callerSystemId: number | null, sourceEveId: number | null, targetEveId: number | null,
): ConnectionOrigin {
  if (requested !== 'jump' || callerSystemId == null) return 'manual';
  return callerSystemId === sourceEveId || callerSystemId === targetEveId ? 'jump' : 'manual';
}

/**
 * True when this write turns a wormhole code from "none" into a real one —
 * the moment that names the "typer". K162 is not a code (it only says "far
 * side"), and a real code replacing another real code changes nothing: the
 * first typer keeps the credit.
 */
export function namesTyper(prev: string | null | undefined, next: unknown): boolean {
  if (typeof next !== 'string') return false;
  const n = next.trim().toUpperCase();
  if (!n || n === 'K162') return false;
  const p = (prev ?? '').trim().toUpperCase();
  return !p || p === 'K162';
}

/** Where the tracker last saw this account's character. */
export async function lastKnownSystemId(userId: number): Promise<number | null> {
  const { rows } = await db.query<{ id: number | null }>(
    `SELECT last_known_system_id AS id FROM users WHERE id = $1`, [userId]);
  return rows[0]?.id ?? null;
}

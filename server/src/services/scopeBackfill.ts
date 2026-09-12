// One-off at boot: users who logged in before granted_scopes existed have an
// empty scope list even though their stored token is a JWT that names its
// scopes. Read it back so the admin table and the "grant extra access" prompt
// are right immediately instead of after everyone's next login. Cheap (no
// network), idempotent, and skips anything it cannot decode.
import { db } from '../db.js';
import { decryptToken } from '../utils/tokenCrypto.js';
import { scopesFromClaim } from '../scopes.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('scopeBackfill');

export async function backfillGrantedScopes(): Promise<void> {
  const { rows } = await db.query<{ id: number; access_token: string | null }>(
    `SELECT id, access_token FROM users WHERE granted_scopes = '' AND access_token IS NOT NULL`,
  );
  let done = 0;
  for (const r of rows) {
    try {
      const jwt = decryptToken(r.access_token!);
      const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')) as { scp?: unknown };
      const scopes = scopesFromClaim(payload.scp);
      if (!scopes.length) continue;
      await db.query(`UPDATE users SET granted_scopes = $1 WHERE id = $2 AND granted_scopes = ''`, [scopes.join(' '), r.id]);
      done++;
    } catch { /* undecodable token — the next login fills it in */ }
  }
  if (done) log.info(`backfilled granted scopes for ${done} user(s)`);
}

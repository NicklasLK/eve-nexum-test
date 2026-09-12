// ESI scope tiers. Every login asks only for what mapping needs (MEMBER_SCOPES);
// anything else is an "extra" an admin assigns to a specific character in
// Admin › Users, which that character then grants through GET /auth/elevate.
//
// Every scope named here must still be enabled on the deployment's EVE
// application — SSO refuses the whole authorize request otherwise — but a
// scope that is not REQUESTED is never shown to the member at login.

export const MEMBER_SCOPES = [
  'esi-location.read_location.v1',   // jump tracking: how connections get mapped
  'esi-location.read_online.v1',     // the poller skips offline pilots
  'esi-location.read_ship_type.v1',  // ship on the map, hole mass bookkeeping
  'esi-ui.write_waypoint.v1',        // set destination / waypoints in-game
  'esi-universe.read_structures.v1', // name of the structure you are docked at
] as const;

export type ExtraKey = 'structures' | 'standings' | 'windows' | 'fleet';

export const EXTRA_SCOPE_SETS: Record<ExtraKey, readonly string[]> = {
  // Corp structure list for the jump planner; Station Manager / Director only.
  structures: ['esi-corporations.read_structures.v1', 'esi-characters.read_corporation_roles.v1'],
  // Personal, corp (Contact Manager) and alliance (executor) standings.
  standings:  ['esi-characters.read_contacts.v1', 'esi-corporations.read_contacts.v1', 'esi-alliances.read_contacts.v1'],
  // Opening windows in the client (the admin invite-mail button).
  windows:    ['esi-ui.open_window.v1'],
  // Fleet-member positions (fleet boss only).
  fleet:      ['esi-fleets.read_fleet.v1'],
};

export const EXTRA_KEYS = Object.keys(EXTRA_SCOPE_SETS) as ExtraKey[];

export function isExtraKey(v: unknown): v is ExtraKey {
  return typeof v === 'string' && (EXTRA_KEYS as string[]).includes(v);
}

/** Scopes to request for a character with the given extras (member set included). */
export function scopesFor(extras: readonly string[], cloneScope: boolean): string[] {
  const out = new Set<string>(MEMBER_SCOPES);
  if (cloneScope) out.add('esi-clones.read_clones.v1');
  for (const k of extras) if (isExtraKey(k)) for (const s of EXTRA_SCOPE_SETS[k]) out.add(s);
  return [...out];
}

/** Extras assigned to a character whose current token does not cover them. */
export function missingExtras(granted: readonly string[], extras: readonly string[]): ExtraKey[] {
  const have = new Set(granted);
  return extras.filter(isExtraKey).filter((k) => EXTRA_SCOPE_SETS[k].some((s) => !have.has(s)));
}

/** The scopes a token carries, from the SSO JWT's `scp` claim. */
export function scopesFromClaim(scp: unknown): string[] {
  if (Array.isArray(scp)) return scp.filter((s): s is string => typeof s === 'string');
  if (typeof scp === 'string' && scp) return scp.split(' ').filter(Boolean);
  return [];
}

// One place for "can a fleet jump this Ansiblex right now", derived from the
// bridge's row: the per-corp and per-bridge admin switches, how many syncs it has been missing from ESI,
// and the live state the structure reader copies out of the corp structures
// listing. A reinforced gate, or one whose service module is offline (out of
// fuel, unfit), is still listed by ESI but nobody can jump it. Manual rows carry
// no live state and count as usable while active.
//
// Consumers: the fleet planner (bridgeUsableSql), the admin list
// (bridgeUsability) and the alliance-map projection (bridgeLinkState).

export interface BridgeStateRow {
  active:        boolean;
  missedSyncs:   number;
  esiState:      string | null;
  serviceOnline: boolean | null;
  /** Per-corp switch (bridge_corps.enabled); absent = no corp, which counts as on. */
  corpEnabled?:  boolean;
}

/** ESI structure states in which the gate cannot be jumped. */
export const REINFORCED_STATES: readonly string[] = ['armor_reinforce', 'hull_reinforce'];

/** The part of an ESI corp-structures entry that decides usability. */
export interface EsiStructureState {
  state?:           string;
  state_timer_end?: string;
  fuel_expires?:    string;
  services?:        { name: string; state: string }[];
}

export interface BridgeStateCols {
  esiState:      string | null;
  stateTimerEnd: Date | null;
  fuelExpiresAt: Date | null;
  serviceOnline: boolean | null;
}

/** The state columns to store for one structure from the corp listing. */
export function bridgeStateFromEsi(s: EsiStructureState): BridgeStateCols {
  const date = (v: string | undefined): Date | null => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  // An Ansiblex has one service module (jump gate access). No list at all is
  // "unknown" and counts as usable; an empty or all-offline list does not.
  const serviceOnline = s.services === undefined ? null : s.services.some((x) => x.state === 'online');
  return {
    esiState:      s.state ?? null,
    stateTimerEnd: date(s.state_timer_end),
    fuelExpiresAt: date(s.fuel_expires),
    serviceOnline,
  };
}

export type BridgeUsability = 'online' | 'reinforced' | 'offline' | 'missing' | 'inactive' | 'corp_off';

/** Why a bridge is or is not usable, most decisive reason first. */
export function bridgeUsability(b: BridgeStateRow): BridgeUsability {
  if (b.corpEnabled === false) return 'corp_off';
  if (!b.active) return 'inactive';
  if (b.missedSyncs >= 2) return 'missing';
  if (b.esiState != null && REINFORCED_STATES.includes(b.esiState)) return 'reinforced';
  if (b.serviceOnline === false) return 'offline';
  return 'online';
}

/** SQL for bridgeUsability(row) === 'online'; `alias` is the jump_bridges alias in the query. */
export function bridgeUsableSql(alias = ''): string {
  const p = alias ? `${alias}.` : '';
  const reinforced = REINFORCED_STATES.map((s) => `'${s}'`).join(', ');
  return `(${p}active AND ${p}missed_syncs < 2 AND COALESCE(${p}service_online, TRUE)`
       + ` AND COALESCE(${p}esi_state, '') NOT IN (${reinforced})`
       + ` AND NOT EXISTS (SELECT 1 FROM bridge_corps bc WHERE bc.corp_id = ${p}owner_corp_id AND NOT bc.enabled))`;
}

/**
 * What the alliance-map projection draws for a bridge: nothing once it is
 * switched off or gone from ESI; a severed (broken) link while it is
 * reinforced, offline, or missing from a single sync; else a normal link.
 */
export type BridgeLinkState = 'absent' | 'broken' | 'ok';

export function bridgeLinkState(b: BridgeStateRow): BridgeLinkState {
  const u = bridgeUsability(b);
  if (u === 'inactive' || u === 'missing' || u === 'corp_off') return 'absent';
  if (u !== 'online' || b.missedSyncs >= 1) return 'broken';
  return 'ok';
}

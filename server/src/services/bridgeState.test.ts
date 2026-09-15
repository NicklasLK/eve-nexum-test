import { describe, it, expect } from 'vitest';
import { bridgeLinkState, bridgeStateFromEsi, bridgeUsability, bridgeUsableSql } from './bridgeState.js';

const base = { active: true, missedSyncs: 0, esiState: null, serviceOnline: null };

describe('bridgeStateFromEsi', () => {
  it('copies state, timers and whether the gate service is online', () => {
    const s = bridgeStateFromEsi({
      state: 'armor_reinforce', state_timer_end: '2026-09-16T10:00:00Z', fuel_expires: '2026-09-20T00:00:00Z',
      services: [{ name: 'Jump Gate Access', state: 'online' }],
    });
    expect(s.esiState).toBe('armor_reinforce');
    expect(s.stateTimerEnd?.toISOString()).toBe('2026-09-16T10:00:00.000Z');
    expect(s.fuelExpiresAt?.toISOString()).toBe('2026-09-20T00:00:00.000Z');
    expect(s.serviceOnline).toBe(true);
  });
  it('treats a missing service list as unknown and an all-offline one as offline', () => {
    expect(bridgeStateFromEsi({}).serviceOnline).toBeNull();
    expect(bridgeStateFromEsi({ services: [] }).serviceOnline).toBe(false);
    expect(bridgeStateFromEsi({ services: [{ name: 'x', state: 'offline' }] }).serviceOnline).toBe(false);
  });
  it('drops unparseable dates rather than storing Invalid Date', () => {
    expect(bridgeStateFromEsi({ state_timer_end: 'soon' }).stateTimerEnd).toBeNull();
  });
});

describe('bridgeUsability', () => {
  it('ranks the admin switch above ESI state', () => {
    expect(bridgeUsability({ ...base, active: false, esiState: 'armor_reinforce' })).toBe('inactive');
  });
  it('reports missing, reinforced and offline in that order', () => {
    expect(bridgeUsability({ ...base, missedSyncs: 2, esiState: 'hull_reinforce' })).toBe('missing');
    expect(bridgeUsability({ ...base, esiState: 'hull_reinforce', serviceOnline: false })).toBe('reinforced');
    expect(bridgeUsability({ ...base, serviceOnline: false })).toBe('offline');
  });
  it('is online for a manual row and for a vulnerable-but-fuelled gate', () => {
    expect(bridgeUsability(base)).toBe('online');
    expect(bridgeUsability({ ...base, esiState: 'shield_vulnerable', serviceOnline: true })).toBe('online');
  });
  it('has a matching SQL form', () => {
    expect(bridgeUsableSql('b')).toContain('b.active AND b.missed_syncs < 2');
    expect(bridgeUsableSql()).toContain("NOT IN ('armor_reinforce', 'hull_reinforce')");
  });
});

describe('bridgeLinkState', () => {
  it('draws nothing for a switched-off or long-missing bridge', () => {
    expect(bridgeLinkState({ ...base, active: false })).toBe('absent');
    expect(bridgeLinkState({ ...base, missedSyncs: 2 })).toBe('absent');
  });
  it('severs the link while reinforced, offline, or missed once', () => {
    expect(bridgeLinkState({ ...base, esiState: 'armor_reinforce' })).toBe('broken');
    expect(bridgeLinkState({ ...base, serviceOnline: false })).toBe('broken');
    expect(bridgeLinkState({ ...base, missedSyncs: 1 })).toBe('broken');
  });
  it('is a normal link otherwise', () => {
    expect(bridgeLinkState(base)).toBe('ok');
  });
});

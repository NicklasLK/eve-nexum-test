import { describe, it, expect } from 'vitest';
import { planBridgeLinks, type ProjBridge, type ProjLink } from './bridgeMapSync.js';

const B = (id: number, from: number, to: number, over: Partial<ProjBridge> = {}): ProjBridge =>
  ({ id, fromSystemId: from, toSystemId: to, active: true, missedSyncs: 0, esiState: null, serviceOnline: null, ...over });
const L = (id: string, s: string, t: string, over: Partial<ProjLink> = {}): ProjLink =>
  ({ id, sourceId: s, targetId: t, connectionType: 'jumpgate', broken: false, jumpBridgeId: null, ...over });
const systems = [{ id: 'A', eveId: 1 }, { id: 'B', eveId: 2 }, { id: 'C', eveId: 3 }];

describe('planBridgeLinks', () => {
  it('draws a link for a usable bridge whose two systems are on the map', () => {
    const p = planBridgeLinks([B(1, 1, 2)], systems, []);
    expect(p.insert).toEqual([{ sourceId: 'A', targetId: 'B', sourceEveId: 1, targetEveId: 2, bridgeId: 1, broken: false }]);
    expect(p.adopt).toEqual([]); expect(p.remove).toEqual([]);
  });

  it('skips a bridge with an end off the map and counts it, never adding systems', () => {
    const p = planBridgeLinks([B(1, 1, 9)], systems, []);
    expect(p.insert).toEqual([]);
    expect(p.offMap).toBe(1);
  });

  it('adopts a hand-drawn jumpgate on the same pair, in either direction', () => {
    const p = planBridgeLinks([B(1, 1, 2)], systems, [L('l1', 'B', 'A')]);
    expect(p.adopt).toEqual([{ linkId: 'l1', bridgeId: 1, broken: false }]);
    expect(p.insert).toEqual([]);
  });

  it('leaves any other hand-drawn link on the pair alone and does not draw over it', () => {
    const p = planBridgeLinks([B(1, 1, 2)], systems, [L('l1', 'A', 'B', { connectionType: 'gate' })]);
    expect(p.insert).toEqual([]); expect(p.adopt).toEqual([]); expect(p.remove).toEqual([]);
    expect(p.blocked).toBe(1);
  });

  it('severs a tagged link while reinforced, offline or missed once, and restores it after', () => {
    const drawn = [L('l1', 'A', 'B', { jumpBridgeId: 1 })];
    expect(planBridgeLinks([B(1, 1, 2, { esiState: 'armor_reinforce' })], systems, drawn).setBroken).toEqual([{ linkId: 'l1', broken: true }]);
    expect(planBridgeLinks([B(1, 1, 2, { serviceOnline: false })], systems, drawn).setBroken).toEqual([{ linkId: 'l1', broken: true }]);
    expect(planBridgeLinks([B(1, 1, 2, { missedSyncs: 1 })], systems, drawn).setBroken).toEqual([{ linkId: 'l1', broken: true }]);
    const severed = [L('l1', 'A', 'B', { jumpBridgeId: 1, broken: true })];
    expect(planBridgeLinks([B(1, 1, 2)], systems, severed).setBroken).toEqual([{ linkId: 'l1', broken: false }]);
  });

  it('draws a new link already severed when the bridge is unusable right now', () => {
    const p = planBridgeLinks([B(1, 1, 2, { esiState: 'hull_reinforce' })], systems, []);
    expect(p.insert[0]?.broken).toBe(true);
  });

  it('removes a tagged link once its bridge is switched off, missing twice, or deleted', () => {
    const drawn = [L('l1', 'A', 'B', { jumpBridgeId: 1 })];
    expect(planBridgeLinks([B(1, 1, 2, { active: false })], systems, drawn).remove).toEqual(['l1']);
    expect(planBridgeLinks([B(1, 1, 2, { missedSyncs: 2 })], systems, drawn).remove).toEqual(['l1']);
    expect(planBridgeLinks([], systems, drawn).remove).toEqual(['l1']);
  });

  it('removes the links of a corporation that is switched off and draws none for it', () => {
    const drawn = [L('l1', 'A', 'B', { jumpBridgeId: 1 })];
    expect(planBridgeLinks([B(1, 1, 2, { corpEnabled: false })], systems, drawn).remove).toEqual(['l1']);
    expect(planBridgeLinks([B(1, 1, 2, { corpEnabled: false })], systems, []).insert).toEqual([]);
  });

  it('never removes an untagged link', () => {
    const p = planBridgeLinks([], systems, [L('l1', 'A', 'B'), L('l2', 'A', 'C', { connectionType: 'standard' })]);
    expect(p.remove).toEqual([]);
  });

  it('redraws a tagged link whose ends no longer match its bridge', () => {
    const p = planBridgeLinks([B(1, 1, 3)], systems, [L('l1', 'A', 'B', { jumpBridgeId: 1 })]);
    expect(p.remove).toEqual(['l1']);
    expect(p.insert.map((i) => [i.sourceId, i.targetId])).toEqual([['A', 'C']]);
  });

  it('drops a duplicate tagged link for the same bridge', () => {
    const p = planBridgeLinks([B(1, 1, 2)], systems, [L('l1', 'A', 'B', { jumpBridgeId: 1 }), L('l2', 'B', 'A', { jumpBridgeId: 1 })]);
    expect(p.remove).toEqual(['l2']);
    expect(p.insert).toEqual([]);
  });

  it('does nothing for a bridge already drawn in the right state', () => {
    const p = planBridgeLinks([B(1, 1, 2)], systems, [L('l1', 'A', 'B', { jumpBridgeId: 1 })]);
    expect(p).toEqual({ insert: [], adopt: [], setBroken: [], remove: [], offMap: 0, blocked: 0 });
  });
});

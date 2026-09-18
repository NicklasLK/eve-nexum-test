import { describe, it, expect } from 'vitest';
import { evaluate, originSig, type CreditConn, type CreditSig } from './whCredit.js';

const known = new Set(['N944', 'C247', 'K162']);
const conn = (over: Partial<CreditConn> = {}): CreditConn => ({
  id: 'c1', mapId: 'm1', connectionType: 'standard', createdVia: 'jump', createdByUserId: 10,
  whType: 'N944', whTypeSetByUserId: null, sourceSystemId: 'A', targetSystemId: 'B',
  sourceEveId: 1, targetEveId: 2, sourceRegionId: null, targetRegionId: null,
  sourceSignatureId: null, targetSignatureId: null, ...over,
});
const sig = (over: Partial<CreditSig> = {}): CreditSig => ({
  id: 's1', systemId: 'A', sigType: 'wormhole', whType: 'N944', whTypeSetByUserId: 20, fromMerge: false, ...over,
});
// The far side's sig: the K162 in B, which nobody needs to have typed.
const far = (over: Partial<CreditSig> = {}): CreditSig =>
  sig({ id: 'sK', systemId: 'B', whType: 'K162', whTypeSetByUserId: null, ...over });
const both = [sig(), far()];

describe('originSig', () => {
  it('prefers a linked sig that carries the code', () => {
    const sigs = [sig({ id: 's1' }), sig({ id: 's2', whTypeSetByUserId: 30 })];
    expect(originSig(conn({ targetSignatureId: 's2' }), sigs)?.id).toBe('s2');
  });
  it('falls back to the one unlinked sig with that code in either end system, ignoring merged copies', () => {
    expect(originSig(conn(), [sig({ systemId: 'B' }), sig({ id: 'x', fromMerge: true })])?.id).toBe('s1');
    expect(originSig(conn(), [sig({ systemId: 'C' })])).toBeNull();
  });
  it('gives up when two sigs could be it', () => {
    expect(originSig(conn(), [sig({ id: 's1' }), sig({ id: 's2' })])).toBeNull();
  });
  it('ignores case in the code', () => {
    expect(originSig(conn({ whType: 'n944' }), [sig({ whType: 'N944' })])?.id).toBe('s1');
  });
});

describe('evaluate', () => {
  it('credits the jumper and the sig typer', () => {
    expect(evaluate(conn(), both, known)).toEqual({ jumperUserId: 10, typerUserId: 20, whType: 'N944' });
  });
  it('lets the same pilot be both', () => {
    expect(evaluate(conn({ createdByUserId: 20 }), both, known)).toEqual({ jumperUserId: 20, typerUserId: 20, whType: 'N944' });
  });
  it('needs a wormhole sig mapped in both end systems', () => {
    expect(evaluate(conn(), [sig()], known)).toBeNull();                                  // origin side only
    expect(evaluate(conn({ whTypeSetByUserId: 30 }), [far()], known)).toBeNull();       // far side only
    expect(evaluate(conn(), [sig(), far({ sigType: 'combat', whType: '' })], known)).toBeNull(); // B scanned, no hole in it
    expect(evaluate(conn(), [sig(), far({ systemId: 'C' })], known)).toBeNull();        // wrong system
    expect(evaluate(conn(), both, known)).not.toBeNull();
    // Which end carries the code doesn't matter, and a merged-in copy still counts as scanned.
    expect(evaluate(conn(), [sig({ systemId: 'B' }), far({ systemId: 'A' })], known)).not.toBeNull();
    expect(evaluate(conn(), [sig(), far({ fromMerge: true })], known)).not.toBeNull();
  });
  it('falls back to the connection typer when no sig names one', () => {
    expect(evaluate(conn({ whTypeSetByUserId: 30 }), [sig({ whTypeSetByUserId: null }), far()], known)?.typerUserId).toBe(30);
    // Code typed on the connection itself, K162 scanned on both sides.
    expect(evaluate(conn({ whTypeSetByUserId: 30 }), [far(), far({ id: 'sK2', systemId: 'A' })], known)?.typerUserId).toBe(30);
  });
  it('waits when nobody has named the code', () => {
    expect(evaluate(conn(), [sig({ whTypeSetByUserId: null }), far()], known)).toBeNull();
    expect(evaluate(conn(), [], known)).toBeNull();
  });
  it('refuses anything not jump-made, not a wormhole link, or without a jumper', () => {
    expect(evaluate(conn({ createdVia: 'manual' }), both, known)).toBeNull();
    expect(evaluate(conn({ createdVia: 'merge' }), both, known)).toBeNull();
    expect(evaluate(conn({ connectionType: 'gate' }), both, known)).toBeNull();
    expect(evaluate(conn({ createdByUserId: null }), both, known)).toBeNull();
  });
  it('never credits a hole with either end in an excluded region', () => {
    const ex = new Set([10]);
    expect(evaluate(conn({ sourceRegionId: 10 }), both, known, ex)).toBeNull();
    expect(evaluate(conn({ targetRegionId: 10 }), both, known, ex)).toBeNull();
    expect(evaluate(conn({ sourceRegionId: 11, targetRegionId: 12 }), both, known, ex)).not.toBeNull();
  });

  it('refuses K162, a blank, and a code the SDE does not know, even with both sides scanned', () => {
    expect(evaluate(conn({ whType: 'K162' }), [sig({ whType: 'K162' }), far()], known)).toBeNull();
    expect(evaluate(conn({ whType: '' }), both, known)).toBeNull();
    expect(evaluate(conn({ whType: 'ZZ99' }), [sig({ whType: 'ZZ99' }), far()], known)).toBeNull();
  });
});

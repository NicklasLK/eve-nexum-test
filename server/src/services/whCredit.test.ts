import { describe, it, expect } from 'vitest';
import { evaluate, originSig, type CreditConn, type CreditSig } from './whCredit.js';

const known = new Set(['N944', 'C247', 'K162']);
const conn = (over: Partial<CreditConn> = {}): CreditConn => ({
  id: 'c1', mapId: 'm1', connectionType: 'standard', createdVia: 'jump', createdByUserId: 10,
  whType: 'N944', whTypeSetByUserId: null, sourceSystemId: 'A', targetSystemId: 'B',
  sourceEveId: 1, targetEveId: 2, sourceSignatureId: null, targetSignatureId: null, ...over,
});
const sig = (over: Partial<CreditSig> = {}): CreditSig => ({
  id: 's1', systemId: 'A', sigType: 'wormhole', whType: 'N944', whTypeSetByUserId: 20, fromMerge: false, ...over,
});

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
    expect(evaluate(conn(), [sig()], known)).toEqual({ jumperUserId: 10, typerUserId: 20, whType: 'N944' });
  });
  it('lets the same pilot be both', () => {
    expect(evaluate(conn({ createdByUserId: 20 }), [sig()], known)).toEqual({ jumperUserId: 20, typerUserId: 20, whType: 'N944' });
  });
  it('falls back to the connection typer when no sig names one', () => {
    expect(evaluate(conn({ whTypeSetByUserId: 30 }), [], known)?.typerUserId).toBe(30);
    expect(evaluate(conn({ whTypeSetByUserId: 30 }), [sig({ whTypeSetByUserId: null })], known)?.typerUserId).toBe(30);
  });
  it('waits when nobody has named the code', () => {
    expect(evaluate(conn(), [sig({ whTypeSetByUserId: null })], known)).toBeNull();
    expect(evaluate(conn(), [], known)).toBeNull();
  });
  it('refuses anything not jump-made, not a wormhole link, or without a jumper', () => {
    expect(evaluate(conn({ createdVia: 'manual' }), [sig()], known)).toBeNull();
    expect(evaluate(conn({ createdVia: 'merge' }), [sig()], known)).toBeNull();
    expect(evaluate(conn({ connectionType: 'gate' }), [sig()], known)).toBeNull();
    expect(evaluate(conn({ createdByUserId: null }), [sig()], known)).toBeNull();
  });
  it('refuses K162, a blank, and a code the SDE does not know', () => {
    expect(evaluate(conn({ whType: 'K162' }), [sig({ whType: 'K162' })], known)).toBeNull();
    expect(evaluate(conn({ whType: '' }), [sig()], known)).toBeNull();
    expect(evaluate(conn({ whType: 'ZZ99' }), [sig({ whType: 'ZZ99' })], known)).toBeNull();
  });
});

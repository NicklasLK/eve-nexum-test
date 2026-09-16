import { describe, it, expect } from 'vitest';
import { cutOffSystems, isCollapseAction, parseCollapseAction } from './deadConnections.js';

const sys = (id: string, over: Partial<{ isHome: boolean; locked: boolean; eveSystemId: number | null }> = {}) =>
  ({ id, isHome: false, locked: false, eveSystemId: null, ...over });
const link = (a: string, b: string) => ({ sourceId: a, targetId: b });
const nobody = new Set<number>();

describe('collapse action parsing', () => {
  it('accepts the three actions', () => {
    expect(isCollapseAction('break')).toBe(true);
    expect(isCollapseAction('disconnect')).toBe(true);
    expect(isCollapseAction('prune')).toBe(true);
  });

  it('falls back to break for anything else — never escalate by accident', () => {
    expect(parseCollapseAction('delete-everything')).toBe('break');
    expect(parseCollapseAction(null)).toBe('break');
    expect(parseCollapseAction(undefined)).toBe('break');
    expect(parseCollapseAction(2)).toBe('break');
    expect(parseCollapseAction('prune')).toBe('prune');
  });
});

describe('cutOffSystems', () => {
  it('returns nothing when the map has no home system', () => {
    expect(cutOffSystems([sys('a'), sys('b')], [], nobody)).toEqual([]);
  });

  it('cuts the branch that lost its route home', () => {
    // home — a   b — c   (the a—b link is already gone)
    const systems = [sys('home', { isHome: true }), sys('a'), sys('b'), sys('c')];
    const links = [link('home', 'a'), link('b', 'c')];
    expect(cutOffSystems(systems, links, nobody).sort()).toEqual(['b', 'c']);
  });

  it('keeps home, locked systems and any system a viewer is sitting in', () => {
    const systems = [
      sys('home', { isHome: true }),
      sys('b', { locked: true }),
      sys('c', { eveSystemId: 31000001 }),
      sys('d'),
    ];
    const links = [link('b', 'c'), link('c', 'd')];
    expect(cutOffSystems(systems, links, new Set([31000001]))).toEqual(['d']);
  });

  it('treats links as undirected', () => {
    const systems = [sys('home', { isHome: true }), sys('a')];
    expect(cutOffSystems(systems, [link('a', 'home')], nobody)).toEqual([]);
  });

  it('follows every link it is given — the callers pass broken ones too', () => {
    const systems = [sys('home', { isHome: true }), sys('a'), sys('b')];
    expect(cutOffSystems(systems, [link('home', 'a'), link('a', 'b')], nobody)).toEqual([]);
  });
});

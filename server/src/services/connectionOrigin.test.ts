import { describe, it, expect } from 'vitest';
import { namesTyper, resolveCreatedVia } from './connectionOrigin.js';

describe('resolveCreatedVia', () => {
  it('accepts a jump only when the pilot is at one end', () => {
    expect(resolveCreatedVia('jump', 2, 1, 2)).toBe('jump');
    expect(resolveCreatedVia('jump', 1, 1, 2)).toBe('jump');
    expect(resolveCreatedVia('jump', 9, 1, 2)).toBe('manual');
  });
  it('is manual when the pilot has no known system or nothing was claimed', () => {
    expect(resolveCreatedVia('jump', null, 1, 2)).toBe('manual');
    expect(resolveCreatedVia(undefined, 1, 1, 2)).toBe('manual');
    expect(resolveCreatedVia('merge', 1, 1, 2)).toBe('manual');
  });
});

describe('namesTyper', () => {
  it('fires when a real code replaces none or K162', () => {
    expect(namesTyper('', 'N944')).toBe(true);
    expect(namesTyper(null, 'c247')).toBe(true);
    expect(namesTyper('K162', 'N944')).toBe(true);
  });
  it('does not fire for K162, a blank, a non-string, or a code replacing a code', () => {
    expect(namesTyper('', 'K162')).toBe(false);
    expect(namesTyper('', '  ')).toBe(false);
    expect(namesTyper('', null)).toBe(false);
    expect(namesTyper('N944', 'C247')).toBe(false);
  });
});

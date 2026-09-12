import { describe, it, expect } from 'vitest';
import { parseAnsiblexName, parseBridgeLine } from './jumpBridgeNames.js';

describe('parseAnsiblexName', () => {
  it('reads the in-game "here » there - label" form', () => {
    expect(parseAnsiblexName('X-7OMU » 5ZXX-K - Dreddit JB')).toEqual({ a: 'X-7OMU', b: '5ZXX-K', label: 'Dreddit JB' });
    expect(parseAnsiblexName('VFK-IV » 3V8-LJ')).toEqual({ a: 'VFK-IV', b: '3V8-LJ', label: '' });
    expect(parseAnsiblexName('F7C-H0 « 9-VO0Q - back')).toEqual({ a: 'F7C-H0', b: '9-VO0Q', label: 'back' });
  });
  it('rejects names without an arrow', () => {
    expect(parseAnsiblexName('Dreddit Fortizar')).toBeNull();
    expect(parseAnsiblexName('')).toBeNull();
  });
});

describe('parseBridgeLine', () => {
  it('accepts the ASCII stand-ins and bare pairs', () => {
    expect(parseBridgeLine('A-B <> C-D')).toEqual({ a: 'A-B', b: 'C-D', label: '' });
    expect(parseBridgeLine('A-B <-> C-D')).toEqual({ a: 'A-B', b: 'C-D', label: '' });
    expect(parseBridgeLine('A-B - C-D')).toEqual({ a: 'A-B', b: 'C-D', label: '' });
    expect(parseBridgeLine('A-B - C-D - highway')).toEqual({ a: 'A-B', b: 'C-D', label: 'highway' });
    expect(parseBridgeLine('A-B\tC-D')).toEqual({ a: 'A-B', b: 'C-D', label: '' });
    expect(parseBridgeLine('  A-B   C-D  ')).toEqual({ a: 'A-B', b: 'C-D', label: '' });
  });
  it('ignores blank and comment lines and rejects junk', () => {
    expect(parseBridgeLine('')).toBeNull();
    expect(parseBridgeLine('# header')).toBeNull();
    expect(parseBridgeLine('one two three four')).toBeNull();
  });
});

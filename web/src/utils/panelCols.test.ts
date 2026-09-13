import { describe, it, expect } from 'vitest';
import { clampPanelCols, fitPanelCols, MAX_PANEL_COLS } from './panelCols';

describe('clampPanelCols', () => {
  it('keeps valid counts', () => {
    expect(clampPanelCols(1)).toBe(1);
    expect(clampPanelCols(3)).toBe(3);
    expect(clampPanelCols(MAX_PANEL_COLS)).toBe(MAX_PANEL_COLS);
  });

  it('clamps out-of-range and rounds', () => {
    expect(clampPanelCols(0)).toBe(1);
    expect(clampPanelCols(-2)).toBe(1);
    expect(clampPanelCols(99)).toBe(MAX_PANEL_COLS);
    expect(clampPanelCols(2.6)).toBe(3);
  });

  it('falls back to one column for junk', () => {
    expect(clampPanelCols(undefined)).toBe(1);
    expect(clampPanelCols(null)).toBe(1);
    expect(clampPanelCols('abc')).toBe(1);
    expect(clampPanelCols('2')).toBe(2);
  });
});

describe('fitPanelCols', () => {
  it('returns the wanted count before the stack is measured', () => {
    expect(fitPanelCols(0, 4)).toBe(4);
  });

  it('gives the wanted count when there is room', () => {
    // 4 x 300 + 3 x 6 = 1218
    expect(fitPanelCols(1218, 4)).toBe(4);
    expect(fitPanelCols(1400, 2)).toBe(2);
  });

  it('drops to however many columns fit, never below one', () => {
    expect(fitPanelCols(1217, 4)).toBe(3);
    expect(fitPanelCols(700, 4)).toBe(2);
    expect(fitPanelCols(500, 4)).toBe(1);
    expect(fitPanelCols(100, 4)).toBe(1);
  });
});

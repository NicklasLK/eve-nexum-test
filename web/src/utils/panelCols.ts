// How many columns the docked pane stack under the map lays out in. Shared by
// the stack itself (SystemPanel) and the picker in the map sidebar, so both
// agree on the setting key and the accepted range.
export const PANEL_COLS_KEY = 'nexum.panelCols';
export const MAX_PANEL_COLS = 4;

/** Coerce a stored value to a valid column count (1..MAX_PANEL_COLS). */
export function clampPanelCols(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(MAX_PANEL_COLS, Math.max(1, n)) : 1;
}

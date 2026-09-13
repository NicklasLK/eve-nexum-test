// How many columns the docked pane stack under the map lays out in. Shared by
// the stack itself (SystemPanel) and the picker in the map sidebar, so both
// agree on the setting key and the accepted range.
export const PANEL_COLS_KEY = 'nexum.panelCols';
export const MAX_PANEL_COLS = 4;

/** Narrowest a column may get before the stack drops to fewer columns. Wide
 *  enough for the Signatures toolbar to wrap into two readable lines. */
export const MIN_PANEL_COL_WIDTH = 300;
/** Horizontal gap between columns — must match `.panel-stack`'s gap. */
export const PANEL_COL_GAP = 6;

/** Coerce a stored value to a valid column count (1..MAX_PANEL_COLS). */
export function clampPanelCols(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(MAX_PANEL_COLS, Math.max(1, n)) : 1;
}

/** How many of the `wanted` columns actually fit in a stack `stackWidth` px
 *  wide, never fewer than one. An unmeasured stack (width 0) gets `wanted`. */
export function fitPanelCols(stackWidth: number, wanted: number): number {
  if (stackWidth <= 0) return wanted;
  const fit = Math.floor((stackWidth + PANEL_COL_GAP) / (MIN_PANEL_COL_WIDTH + PANEL_COL_GAP));
  return Math.max(1, Math.min(wanted, fit));
}

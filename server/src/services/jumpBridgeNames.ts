// Ansiblex naming conventions. In-game a gate is named "<here> » <there>" with
// an optional " - <label>" suffix; pasted lists use the same arrows or a few
// ASCII stand-ins. Pure string helpers, shared by the reader sync and the
// paste importer.

/** ESI type id of the Ansiblex Jump Gate. */
export const ANSIBLEX_TYPE_ID = 35841;

export interface ParsedBridge { a: string; b: string; label: string }

/** "X-7OMU » 5ZXX-K - Dreddit JB" → { a: 'X-7OMU', b: '5ZXX-K', label: 'Dreddit JB' }. */
export function parseAnsiblexName(name: string): ParsedBridge | null {
  const m = /^(.+?)\s*[»«]\s*(.+?)(?:\s+-\s+(.*))?$/.exec(name.trim());
  if (!m) return null;
  const a = m[1].trim(), b = m[2].trim();
  if (!a || !b) return null;
  return { a, b, label: (m[3] ?? '').trim() };
}

/**
 * One pasted line → endpoints. Accepts "A » B", "A « B", "A <> B", "A <-> B",
 * "A - B", "A → B", "A, B", tab/space-separated pairs, and an optional
 * " - label" suffix after the arrow forms.
 */
export function parseBridgeLine(line: string): ParsedBridge | null {
  const s = line.trim();
  if (!s || s.startsWith('#')) return null;
  const arrow = parseAnsiblexName(s);
  if (arrow) return arrow;
  const m = /^(.+?)\s*(?:<->|<>|→|->|,|\s+-\s+)\s*(.+?)\s*$/.exec(s);
  if (m) {
    const [b, ...rest] = m[2].split(/\s+-\s+/);
    return { a: m[1].trim(), b: b.trim(), label: rest.join(' - ').trim() };
  }
  const tokens = s.split(/\s+/);
  if (tokens.length === 2) return { a: tokens[0], b: tokens[1], label: '' };
  return null;
}

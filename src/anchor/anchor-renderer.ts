import type { AnchoredLine } from "../types.js";

export const ANCHOR_DELIMITER = "§";

function renderAnchoredLine(line: AnchoredLine): string {
  return `${line.anchor}${ANCHOR_DELIMITER} ${line.text}`;
}

export function renderAnchoredLines(lines: AnchoredLine[]): string {
  return lines.map(renderAnchoredLine).join("\n");
}

/**
 * Parse a bare anchor word or a complete `WORD§content` coordinate. Returns
 * null for empty or orphan (§-prefixed) input.
 */
export function parseAnchoredCoordinate(raw: string): { anchor: string; content?: string } | null {
  if (!raw) return null;
  const idx = raw.indexOf(ANCHOR_DELIMITER);
  if (idx === -1) return raw.trim() ? { anchor: raw.trim() } : null;
  const anchor = raw.slice(0, idx);
  if (!anchor.trim()) return null;
  return {
    anchor: anchor.trim(),
    content: raw.slice(idx + ANCHOR_DELIMITER.length),
  };
}

export function stripAnchorPrefix(line: string): string {
  const index = line.indexOf(ANCHOR_DELIMITER);
  if (index === -1) return line;
  return line.slice(index + ANCHOR_DELIMITER.length).replace(/^ /, "");
}

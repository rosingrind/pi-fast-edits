import type { AnchoredLine } from "../types.js";

export const ANCHOR_DELIMITER = "§";

export function renderAnchoredLine(line: AnchoredLine): string {
  return `${line.anchor}${ANCHOR_DELIMITER} ${line.text}`;
}

export function renderAnchoredLines(lines: AnchoredLine[]): string {
  return lines.map(renderAnchoredLine).join("\n");
}

export function stripAnchorPrefix(line: string): string {
  const index = line.indexOf(ANCHOR_DELIMITER);
  if (index === -1) return line;
  return line.slice(index + ANCHOR_DELIMITER.length).replace(/^ /, "");
}

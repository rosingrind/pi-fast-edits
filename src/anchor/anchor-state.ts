import type { AnchoredLine, FileAnchorState, LineEnding } from "../types.js";
import { hashText } from "../fs/text-file.js";
import { AnchorPool, poolRngForPath } from "./anchor-pool.js";

export function createFileAnchorState(
  path: string,
  lines: string[],
  lineEnding: LineEnding,
  hadFinalNewline: boolean,
  hadBom: boolean,
  fullText?: string,
): FileAnchorState {
  const pool = new AnchorPool(poolRngForPath(path));
  const anchored: AnchoredLine[] = lines.map((text, index) => ({
    anchor: pool.next(),
    text,
    lineNo: index + 1,
  }));
  return {
    path,
    revisionHash: fullText === undefined ? hashText(lines.join("\n")) : hashText(fullText),
    lineEnding,
    hadFinalNewline,
    hadBom,
    lines: anchored,
    retiredAnchors: new Set<string>(),
  };
}

export type AnchorSuggestion = {
  suggestion: string;
  caseOnly: boolean;
  lineNo: number;
  text: string;
};

/** Levenshtein distance with a band cutoff — anchor words are short, so this is cheap. */
function boundedEditDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Best-effort recovery hint for a rejected anchor: an existing anchor that
 * matches case-insensitively (definitely intended — anchors are TitleCase)
 * or sits within a small edit distance (likely typo). Undefined when nothing
 * is close; invented suggestions would just add a confusing hop.
 */
export function suggestAnchor(state: FileAnchorState, bad: string): AnchorSuggestion | undefined {
  const wanted = normalizeAnchor(bad);
  if (!wanted) return undefined;
  const lower = wanted.toLowerCase();
  let best: AnchoredLine | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const line of state.lines) {
    if (line.anchor.toLowerCase() === lower) {
      return {
        suggestion: line.anchor,
        caseOnly: line.anchor !== wanted,
        lineNo: line.lineNo,
        text: line.text,
      };
    }
    const d = boundedEditDistance(wanted, line.anchor, 2);
    if (d <= 2 && d < bestDistance) {
      bestDistance = d;
      best = line;
    }
  }
  return best
    ? { suggestion: best.anchor, caseOnly: false, lineNo: best.lineNo, text: best.text }
    : undefined;
}

/**
 * O(1) anchor→line-index lookups for batch verification. Built fresh from the
 * state's current lines — never cached across calls — so it cannot go stale
 * when lines change. Duplicate anchors cannot occur within a file (the pool
 * guarantees uniqueness via suffixing), and first-wins matches findIndex.
 */
export class AnchorIndex {
  private readonly byAnchor: Map<string, number>;

  constructor(state: FileAnchorState) {
    this.byAnchor = new Map();
    state.lines.forEach((line, i) => {
      if (!this.byAnchor.has(line.anchor)) this.byAnchor.set(line.anchor, i);
    });
  }

  /** Line index for `anchor`, or -1 when not found (mirrors findIndex). */
  find(anchor: string): number {
    return this.byAnchor.get(normalizeAnchor(anchor)) ?? -1;
  }
}

function normalizeAnchor(anchor: string): string {
  return anchor.replace(/[§|]\s*$/, "").trim();
}

export function poolFromState(state: FileAnchorState): AnchorPool {
  // Seed from the file path so post-edit allocations are reproducible: the
  // same state (path + used/retired sets) always yields the same words for
  // newly added lines, keeping multi-session and hydration behavior stable.
  const pool = new AnchorPool(poolRngForPath(state.path));
  for (const line of state.lines) pool.markUsed(line.anchor);
  for (const anchor of state.retiredAnchors) pool.retire(anchor);
  return pool;
}

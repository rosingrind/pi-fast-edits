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

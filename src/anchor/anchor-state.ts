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

export function findAnchorIndex(state: FileAnchorState, anchor: string): number {
  return state.lines.findIndex((line) => line.anchor === normalizeAnchor(anchor));
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

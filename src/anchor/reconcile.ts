import type { AnchoredLine, FileAnchorState, LineEnding } from "../types.js";
import { hashText, joinLines } from "../fs/text-file.js";
import { myersDiff, type DiffOp } from "../diff/myers.js";
import { poolFromState } from "./anchor-state.js";

// Cap on retired anchors retained per file. A Set grows unboundedly as lines
// churn; beyond this the oldest retirements are dropped (they are only kept to
// avoid recycling anchor words, and 10k is far beyond any realistic file).
export const MAX_RETIRED_ANCHORS = 10000;

export function reconcileState(
  state: FileAnchorState,
  newLines: string[],
  lineEnding: LineEnding,
  hadFinalNewline: boolean,
  hadBom: boolean,
  snapshotHash?: string,
  diffOps?: DiffOp[],
): FileAnchorState {
  const oldTexts = state.lines.map((line) => line.text);
  const ops = diffOps ?? myersDiff(oldTexts, newLines);
  const pool = poolFromState(state);
  const nextLines: AnchoredLine[] = [];

  for (const op of ops) {
    if (op.type === "equal") {
      for (let i = 0; i < op.count; i++) {
        const oldLine = state.lines[op.oldStart + i];
        const text = newLines[op.newStart + i];
        nextLines.push({
          anchor: oldLine.anchor,
          text,
          lineNo: nextLines.length + 1,
        });
      }
    } else if (op.type === "delete") {
      for (let i = 0; i < op.count; i++) {
        const oldLine = state.lines[op.oldStart + i];
        state.retiredAnchors.add(oldLine.anchor);
      }
    } else {
      for (let i = 0; i < op.count; i++) {
        const text = newLines[op.newStart + i];
        nextLines.push({
          anchor: pool.next(),
          text,
          lineNo: nextLines.length + 1,
        });
      }
    }
  }

  state.lines = nextLines;
  state.lineEnding = lineEnding;
  state.hadFinalNewline = hadFinalNewline;
  state.hadBom = hadBom;
  state.skeletonCache.clear();
  state.revisionHash = snapshotHash ?? hashText(joinLines(newLines, lineEnding, hadFinalNewline));
  trimRetiredAnchors(state);
  return state;
}

/**
 * Bound the retired-anchor set to `MAX_RETIRED_ANCHORS`. Sets iterate in
 * insertion order, so the oldest retirements (front of the set) are dropped
 * first. This is a memory safety measure only — old anchors do not collide with
 * the live word pool in any way that would break uniqueness.
 */
function trimRetiredAnchors(state: FileAnchorState): void {
  if (state.retiredAnchors.size <= MAX_RETIRED_ANCHORS) return;
  const excess = state.retiredAnchors.size - MAX_RETIRED_ANCHORS;
  let dropped = 0;
  for (const anchor of state.retiredAnchors) {
    if (dropped >= excess) break;
    state.retiredAnchors.delete(anchor);
    dropped++;
  }
}

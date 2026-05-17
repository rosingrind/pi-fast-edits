import type { AnchoredLine, FileAnchorState, LineEnding } from "../types.js";
import { hashLine, hashText, joinLines } from "../fs/text-file.js";
import { myersDiff } from "../diff/myers.js";
import { poolFromState } from "./anchor-state.js";

export function reconcileState(
  state: FileAnchorState,
  newLines: string[],
  lineEnding: LineEnding,
  hadFinalNewline: boolean
): FileAnchorState {
  const oldTexts = state.lines.map((line) => line.text);
  const ops = myersDiff(oldTexts, newLines);
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
          lineHash: hashLine(text)
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
          lineHash: hashLine(text)
        });
      }
    }
  }

  state.lines = nextLines;
  state.lineEnding = lineEnding;
  state.hadFinalNewline = hadFinalNewline;
  state.revisionHash = hashText(joinLines(newLines, lineEnding, hadFinalNewline));
  return state;
}

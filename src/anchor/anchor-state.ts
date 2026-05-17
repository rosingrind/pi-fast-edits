import type { AnchoredLine, FileAnchorState, LineEnding } from "../types.js";
import { hashLine, hashText } from "../fs/text-file.js";
import { AnchorPool } from "./anchor-pool.js";

export function createFileAnchorState(path: string, lines: string[], lineEnding: LineEnding, hadFinalNewline: boolean, fullText?: string): FileAnchorState {
  const pool = new AnchorPool();
  const anchored: AnchoredLine[] = lines.map((text, index) => ({
    anchor: pool.next(),
    text,
    lineNo: index + 1,
    lineHash: hashLine(text)
  }));
  return {
    path,
    revisionHash: fullText === undefined ? hashText(lines.join("\n")) : hashText(fullText),
    lineEnding,
    hadFinalNewline,
    lines: anchored,
    retiredAnchors: new Set<string>()
  };
}

export function findAnchorIndex(state: FileAnchorState, anchor: string): number {
  return state.lines.findIndex((line) => line.anchor === normalizeAnchor(anchor));
}

export function normalizeAnchor(anchor: string): string {
  return anchor.replace(/§$/, "").trim();
}

export function poolFromState(state: FileAnchorState): AnchorPool {
  const pool = new AnchorPool();
  for (const line of state.lines) pool.markUsed(line.anchor);
  for (const anchor of state.retiredAnchors) pool.retire(anchor);
  return pool;
}

export function refreshLineNumbers(state: FileAnchorState): void {
  state.lines.forEach((line, index) => {
    line.lineNo = index + 1;
    line.lineHash = hashLine(line.text);
  });
}

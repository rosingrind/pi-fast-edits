import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { FileAnchorState, SessionState } from "../types.js";

export function stateFilePath(): string {
  return join(getAgentDir(), "pi-fast-edits", "anchor-state.json");
}

export function exportAnchorState(session: SessionState): object {
  const files: unknown[] = [];
  for (const [absPath, state] of session.files) {
    files.push({
      path: absPath,
      lineEnding: state.lineEnding,
      hadFinalNewline: state.hadFinalNewline,
      hadBom: state.hadBom,
      revisionHash: state.revisionHash,
      lines: state.lines.map((l) => ({ anchor: l.anchor, text: l.text })),
      retiredAnchors: [...state.retiredAnchors],
    });
  }
  return { version: 1, files };
}

export function hydrateAnchorState(session: SessionState, data: unknown): void {
  try {
    const parsed = data as {
      version?: number;
      files?: Array<{
        path?: string;
        lineEnding?: string;
        hadFinalNewline?: boolean;
        hadBom?: boolean;
        revisionHash?: string;
        lines?: Array<{ anchor?: string; text?: string }>;
        retiredAnchors?: string[];
      }>;
    };
    if (parsed?.version !== 1 || !Array.isArray(parsed.files)) return;
    for (const file of parsed.files) {
      if (
        typeof file.path !== "string" ||
        typeof file.revisionHash !== "string" ||
        !Array.isArray(file.lines) ||
        file.lines.some((l) => typeof l.anchor !== "string" || typeof l.text !== "string")
      ) {
        continue;
      }
      const lines = file.lines.map((l, i) => ({
        anchor: l.anchor!,
        text: l.text!,
        lineNo: i + 1,
      }));
      const state: FileAnchorState = {
        path: file.path,
        revisionHash: file.revisionHash,
        lineEnding: file.lineEnding === "\r\n" ? "\r\n" : "\n",
        hadFinalNewline: file.hadFinalNewline === true,
        hadBom: file.hadBom === true,
        lines,
        retiredAnchors: new Set(file.retiredAnchors ?? []),
        skeletonCache: new Map(),
      };
      session.files.set(file.path, state);
    }
  } catch {
    // Malformed state must never break startup.
  }
}

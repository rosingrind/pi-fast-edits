import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiFastEditsConfig, ReadMode, SessionState } from "../types.js";
import { renderAnchoredLines } from "../anchor/anchor-renderer.js";
import { getCwd, loadStateForPath, textResult } from "./shared.js";

export function registerReadAnchoredFile(pi: ExtensionAPI, session: SessionState, config: PiFastEditsConfig): void {
  pi.registerTool({
    name: "read_anchored_file",
    label: "Read Anchored File",
    description: "Read a text file with Dirac-style word anchors for future fast anchored edits. For large files, returns a skeleton unless a range is requested.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to a text file inside the workspace." }),
      startLine: Type.Optional(Type.Number({ description: "1-based start line for ranged reads." })),
      endLine: Type.Optional(Type.Number({ description: "1-based inclusive end line for ranged reads." })),
      mode: Type.Optional(Type.String({ description: "auto, full, range, or skeleton." })),
      maxBytes: Type.Optional(Type.Number({ description: "Optional full-read byte cap." }))
    }),
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const cwd = getCwd(ctx);
      const { relativePath, state, snapshot } = await loadStateForPath(session, cwd, params.path);
      const requestedMode = (params.mode ?? "auto") as ReadMode;
      const hasRange = typeof params.startLine === "number" || typeof params.endLine === "number";
      const maxBytes = params.maxBytes ?? config.maxFullReadBytes;
      let mode: ReadMode = requestedMode;
      if (mode === "auto") {
        if (hasRange) mode = "range";
        else if (snapshot.byteLength > maxBytes || state.lines.length > config.maxFullReadLines) mode = "skeleton";
        else mode = "full";
      }

      if (mode === "range") {
        const start = Math.max(1, Math.floor(params.startLine ?? 1));
        const end = Math.min(state.lines.length, Math.floor(params.endLine ?? Math.min(state.lines.length, start + config.maxRangeReadLines - 1)));
        const selected = state.lines.slice(start - 1, end);
        return textResult(`File: ${relativePath}\nLines: ${start}-${end} of ${state.lines.length}\nRevision: ${state.revisionHash}\n\n${renderAnchoredLines(selected)}`, {
          path: relativePath,
          mode,
          startLine: start,
          endLine: end,
          revision: state.revisionHash
        });
      }

      if (mode === "skeleton") {
        return textResult(renderSkeleton(relativePath, state, config.maxSkeletonItems), {
          path: relativePath,
          mode,
          revision: state.revisionHash
        });
      }

      return textResult(`File: ${relativePath}\nLines: ${state.lines.length}\nRevision: ${state.revisionHash}\n\n${renderAnchoredLines(state.lines)}`, {
        path: relativePath,
        mode: "full",
        revision: state.revisionHash
      });
    }
  });
}

function renderSkeleton(relativePath: string, state: { lines: Array<{ anchor: string; text: string; lineNo: number }>; revisionHash: string }, maxItems: number): string {
  const items: string[] = [];
  const interesting = /^(\s*(import\s|from\s|export\s|async\s+function\s|function\s|class\s|interface\s|type\s|const\s+\w+\s*=|let\s+\w+\s*=|var\s+\w+\s*=|def\s|#|\/\/|\/\*|\*))/;
  for (const line of state.lines) {
    const text = line.text;
    const lowIndent = /^\S/.test(text) || /^\s{0,2}\S/.test(text);
    if ((interesting.test(text) && lowIndent) || line.lineNo <= 30) {
      const display = text.length > 140 ? `${text.slice(0, 137)}...` : text;
      items.push(`${line.anchor}§ ${display}    lines ${line.lineNo}`);
    }
    if (items.length >= maxItems) break;
  }
  if (items.length === 0) {
    for (const line of state.lines.slice(0, Math.min(maxItems, 50))) {
      items.push(`${line.anchor}§ ${line.text}    lines ${line.lineNo}`);
    }
  }
  return `File: ${relativePath}\nLines: ${state.lines.length}\nMode: skeleton\nRevision: ${state.revisionHash}\n\n${items.join("\n")}`;
}

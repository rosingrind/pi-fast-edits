import { Text, type Component } from "@earendil-works/pi-tui";
import type { PiFastEditsConfig, ReadMode, SessionState } from "../types.js";
import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ANCHOR_DELIMITER,
  renderAnchoredLines,
  stripAnchorPrefix,
} from "../anchor/anchor-renderer.js";
import {
  renderToolCall,
  type ToolResult,
  type RenderOptions,
  type RenderContext,
} from "./render.js";
import { getCwd, loadStateForPath, textResult, type PiContext } from "./shared.js";
import type { Theme } from "./theme.js";

const readSchema = Type.Object({
  path: Type.String({
    description: "Path to a text file inside the workspace.",
  }),
  startLine: Type.Optional(Type.Number({ description: "1-based start line for ranged reads." })),
  endLine: Type.Optional(
    Type.Number({
      description: "1-based inclusive end line for ranged reads.",
    }),
  ),
  mode: Type.Optional(
    Type.Union(
      [Type.Literal("auto"), Type.Literal("full"), Type.Literal("range"), Type.Literal("skeleton")],
      { description: "auto, full, range, or skeleton." },
    ),
  ),
  maxBytes: Type.Optional(Type.Number({ description: "Optional full-read byte cap." })),
});
type ReadParams = Static<typeof readSchema>;

export function registerReadAnchoredFile(
  pi: ExtensionAPI,
  session: SessionState,
  config: PiFastEditsConfig,
): void {
  pi.registerTool({
    name: "read_anchored_file",
    label: "Read Anchored File",
    description:
      "Read a text file with stable word anchors for fast subsequent edits. For large files, returns a skeleton unless a range is requested.",
    renderCall: renderToolCall("read_anchored_file", (args, theme) => {
      const startLine = args.startLine as number | undefined;
      const endLine = args.endLine as number | undefined;
      if (startLine === undefined && endLine === undefined) return "";
      const s = startLine ?? 1;
      const e = endLine !== undefined ? `-${endLine}` : "";
      return theme.fg("warning", `:${s}${e}`);
    }),
    renderResult: renderReadAnchoredResult,
    promptSnippet: "Read a file with stable word anchors for future edits",
    promptGuidelines: [
      "Use the returned anchors to reference specific lines in subsequent edits",
      "For large files, use mode:'skeleton' or mode:'range' to focus on specific sections",
      "Pass the revision hash from this result as expectedRevision in edit tools",
    ],
    renderShell: "default",
    executionMode: "parallel",
    parameters: readSchema,
    async execute(
      _toolCallId: string,
      params: ReadParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: PiContext,
    ) {
      if (_signal?.aborted) return textResult("Read cancelled (aborted).");
      const cwd = getCwd(ctx);
      const { relativePath, state, snapshot } = await loadStateForPath(session, cwd, params.path);
      const requestedMode = (params.mode ?? "auto") as ReadMode;
      const hasRange = typeof params.startLine === "number" || typeof params.endLine === "number";
      const maxBytes = params.maxBytes ?? config.maxFullReadBytes;
      let mode: ReadMode = requestedMode;
      if (mode === "auto") {
        if (hasRange) mode = "range";
        else if (snapshot.byteLength > maxBytes || state.lines.length > config.maxFullReadLines)
          mode = "skeleton";
        else mode = "full";
      }

      if (mode === "range") {
        const start = Math.max(1, Math.floor(params.startLine ?? 1));
        const end = Math.min(
          state.lines.length,
          Math.floor(
            params.endLine ?? Math.min(state.lines.length, start + config.maxRangeReadLines - 1),
          ),
        );
        if (start > end) {
          throw new Error(`Invalid range: start line ${start} is greater than end line ${end}.`);
        }
        const selected = state.lines.slice(start - 1, end);
        return textResult(
          `File: ${relativePath}\nLines: ${start}-${end} of ${state.lines.length}\nRevision: ${state.revisionHash}\n\n${renderAnchoredLines(selected)}`,
          {
            path: relativePath,
            mode,
            startLine: start,
            endLine: end,
            revision: state.revisionHash,
            lines: selected.map((line) => ({
              anchor: line.anchor,
              text: line.text,
              lineNo: line.lineNo,
            })),
          },
        );
      }

      if (mode === "skeleton") {
        let items = state.skeletonCache.get(state.revisionHash);
        if (!items) {
          items = selectSkeletonItems(state, config.maxSkeletonItems);
          state.skeletonCache.set(state.revisionHash, items);
        }
        return textResult(renderSkeleton(relativePath, state, items), {
          path: relativePath,
          mode,
          revision: state.revisionHash,
          lines: items.map((line) => ({
            anchor: line.anchor,
            text: line.text,
            lineNo: line.lineNo,
          })),
        });
      }

      return textResult(
        `File: ${relativePath}\nLines: ${state.lines.length}\nRevision: ${state.revisionHash}\n\n${renderAnchoredLines(state.lines)}`,
        {
          path: relativePath,
          mode: "full",
          revision: state.revisionHash,
          lines: state.lines.map((line) => ({
            anchor: line.anchor,
            text: line.text,
            lineNo: line.lineNo,
          })),
        },
      );
    },
  });
}

export function renderReadAnchoredResult(
  result: ToolResult,
  options: RenderOptions,
  theme: Theme,
  context: RenderContext,
): Component {
  if (context.isError) {
    const text = result.content?.[0]?.text ?? "error";
    return new Text(theme.fg("error", text), 0, 0);
  }
  const raw = result.content?.[0]?.text ?? "";
  // Strip only the leading header block, the blank separator after it, and
  // anchor prefixes. Content lines that merely start with a header prefix
  // (e.g. `Apple§ Lines: 5`) are preserved.
  const headerPrefixes = ["File:", "Lines:", "Mode:", "Revision:"];
  const lines = raw.split("\n");
  const cleaned: string[] = [];
  let skippedSeparator = false;
  for (let i = 0; i < lines.length; i++) {
    if (i < 4 && headerPrefixes.some((prefix) => lines[i].startsWith(prefix))) {
      continue;
    }
    // Drop the single blank line separating headers from content. Content
    // lines carry an anchor prefix, so a truly empty line here is the separator.
    if (!skippedSeparator && cleaned.length === 0 && lines[i].trim() === "") {
      skippedSeparator = true;
      continue;
    }
    cleaned.push(stripAnchorPrefix(lines[i]));
  }
  // Match built-in read: empty body when collapsed, full body when expanded.
  if (!options.expanded) {
    return new Text("", 0, 0);
  }
  return new Text(cleaned.join("\n"), 0, 0);
}

function selectSkeletonItems(
  state: {
    lines: Array<{ anchor: string; text: string; lineNo: number }>;
  },
  maxItems: number,
): Array<{ anchor: string; text: string; lineNo: number }> {
  const items: Array<{ anchor: string; text: string; lineNo: number }> = [];
  const interesting =
    /^(\s*(import\s|from\s|export\s|async\s+function\s|function\s|class\s|interface\s|type\s|const\s+\w+\s*=|let\s+\w+\s*=|var\s+\w+\s*=|def\s|#|\/\/|\/\*|\*))/;
  for (const line of state.lines) {
    const lowIndent = /^\s{0,2}\S/.test(line.text);
    if ((interesting.test(line.text) && lowIndent) || line.lineNo <= 30) {
      items.push(line);
    }
    if (items.length >= maxItems) break;
  }
  if (items.length === 0) {
    for (const line of state.lines.slice(0, Math.min(maxItems, 50))) {
      items.push(line);
    }
  }
  return items;
}

function renderSkeleton(
  relativePath: string,
  state: {
    lines: Array<{ anchor: string; text: string; lineNo: number }>;
    revisionHash: string;
  },
  items: Array<{ anchor: string; text: string; lineNo: number }>,
): string {
  const rendered = items.map((line) => {
    const display = line.text.length > 140 ? `${line.text.slice(0, 137)}...` : line.text;
    return `${line.anchor}${ANCHOR_DELIMITER} ${display}    lines ${line.lineNo}`;
  });
  return `File: ${relativePath}\nLines: ${state.lines.length}\nMode: skeleton\nRevision: ${state.revisionHash}\n\n${rendered.join("\n")}`;
}

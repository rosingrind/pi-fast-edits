import { Text, type Component } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import { experimentalToolSampling } from "./experimental-sampling.js";
import type { PiFastEditsConfig, ReadMode, SessionState } from "../types.js";
import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderAnchoredLines, stripAnchorPrefix } from "../anchor/anchor-renderer.js";
import {
  renderToolCall,
  toolResultText,
  errorResultComponent,
  collapsedPreview,
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
    Type.Union([Type.Literal("auto"), Type.Literal("full"), Type.Literal("range")], {
      description: "auto, full, or range.",
    }),
  ),
  anchored: Type.Optional(
    Type.Boolean({
      description:
        "Return plain `lineNo: text` lines without anchor prefixes or revision header. Default: anchored (edit-ready) output.",
    }),
  ),
});
type ReadParams = Static<typeof readSchema>;

export function registerReadAnchored(
  pi: ExtensionAPI,
  session: SessionState,
  config: PiFastEditsConfig,
) {
  const tool = {
    name: "read_anchored",
    label: "Read Anchored File",
    constrainedSampling: experimentalToolSampling(),
    description:
      "Read a text file with stable word anchors for fast subsequent edits. Use mode:'range' for windows of large files. Set anchored:false to read plain line-numbered output.",
    renderCall: renderToolCall(
      "read_anchored",
      (args, theme) => {
        const startLine = args.startLine as number | undefined;
        const endLine = args.endLine as number | undefined;
        if (startLine === undefined && endLine === undefined) return "";
        const s = startLine ?? 1;
        const e = endLine === undefined ? "" : `-${endLine}`;
        return theme.fg("warning", `:${s}${e}`);
      },
      { skillClassification: true },
    ),
    renderResult: renderReadAnchoredResult,
    promptSnippet: "Read a file with stable word anchors for future edits",
    promptGuidelines: [
      "Use the returned anchors to reference specific lines in subsequent edits",
      "For large files, use mode:'range' to focus on specific sections",
      "Pass the revision hash from this result as expectedRevision in edit tools",
    ],
    renderShell: "default" as const,
    executionMode: "parallel" as const,
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
      let loaded;
      try {
        loaded = await loadStateForPath(session, cwd, params.path, {
          extraReadRoots: session.readRoots,
        });
      } catch (error) {
        if (error instanceof Error && /outside workspace/.test(error.message)) {
          throw new Error(
            `${error.message} Outside-workspace reads are limited to loaded skill directories and pi's docs — use bash cat for anything else.`,
          );
        }
        throw error;
      }
      const { displayPath, state } = loaded;
      const anchored = params.anchored ?? true;
      const requestedMode = (params.mode ?? "auto") as ReadMode;
      const hasRange = typeof params.startLine === "number" || typeof params.endLine === "number";
      let mode: ReadMode = requestedMode;
      if (mode === "auto") {
        mode = hasRange ? "range" : "full";
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
          `File: ${displayPath}\nLines: ${start}-${end} of ${state.lines.length}${revisionLine(state, anchored)}\n\n${renderLines(selected, anchored)}`,
          {
            path: displayPath,
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

      return textResult(
        `File: ${displayPath}\nLines: ${state.lines.length}${revisionLine(state, anchored)}\n\n${renderLines(state.lines, anchored)}`,
        {
          path: displayPath,
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
  };
  pi.registerTool(tool);
  return tool;
}

export function renderReadAnchoredResult(
  result: ToolResult,
  options: RenderOptions,
  theme: Theme,
  context: RenderContext,
): Component {
  const errorComponent = errorResultComponent(result, theme, context);
  if (errorComponent) return errorComponent;
  const raw = toolResultText(result);
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
  // Match pi's built-in read: skill-classified reads collapse to nothing
  // (the [skill] call box carries the identity); regular files show a
  // short preview with pi's "more lines" hint.
  if (!options.expanded) {
    const argsPath = (context.args as { path?: string } | undefined)?.path;
    if (argsPath && basename(argsPath) === "SKILL.md") {
      return new Text("", 0, 0);
    }
    return new Text(collapsedPreview(cleaned, 10, theme), 0, 0);
  }
  // Match built-in read's spacing convention: a leading newline separates the
  // title line from the body.
  return new Text("\n" + cleaned.join("\n"), 0, 0);
}

function revisionLine(state: { revisionHash: string }, anchored: boolean): string {
  return anchored ? `\nRevision: ${state.revisionHash}` : "";
}

function renderLines(
  lines: Array<{ anchor: string; text: string; lineNo: number }>,
  anchored: boolean,
): string {
  return anchored
    ? renderAnchoredLines(lines)
    : lines.map((l) => `${l.lineNo}: ${l.text}`).join("\n");
}

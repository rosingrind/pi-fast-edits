import { Text, type Component } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import { experimentalToolSampling } from "./experimental-sampling.js";
import type { AnchoredLine, PiFastEditsConfig, ReadMode, SessionState } from "../types.js";
import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderAnchoredLines, stripAnchorPrefix } from "../anchor/anchor-renderer.js";
import { DISPLAY_LINE_CAP } from "./edit-core.js";
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

/** Byte budget for a full read's model-facing text (pi's built-in read parity: 50KB). */
const MAX_READ_BYTES = 50_000;

/** Display truncation for one line: over-cap lines are cut with an ellipsis marker. */
function truncateForDisplay(text: string): string {
  return text.length > DISPLAY_LINE_CAP ? `${text.slice(0, DISPLAY_LINE_CAP)}...` : text;
}

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

      // Full mode: cap lines (maxReadLines) and bytes (MAX_READ_BYTES) so a
      // huge or minified file cannot dump megabytes into context — pi's
      // built-in read applies the same 2000-line/50KB convention. The
      // continuation notice teaches our range args for the rest.
      // Byte budget scales proportionally when maxReadLines is raised above
      // the 2000-line default (an explicit larger window implies a larger
      // allowance); at the default it stays at pi's 50KB parity.
      const byteBudget = Math.max(
        MAX_READ_BYTES,
        Math.ceil((MAX_READ_BYTES * config.maxReadLines) / 2000),
      );
      const shown: AnchoredLine[] = [];
      let bytes = 0;
      let truncated = false;
      for (const line of state.lines) {
        // Plain mode carries the full verbatim line (no 300-char cap), so its
        // budget cost is the real length; anchored mode is display-capped.
        const renderedLength = anchored
          ? `${line.anchor}§ ${truncateForDisplay(line.text)}`.length + 1
          : `${line.lineNo}: ${line.text}`.length + 1;
        if (shown.length >= config.maxReadLines || bytes + renderedLength > byteBudget) {
          truncated = true;
          break;
        }
        bytes += renderedLength;
        shown.push(line);
      }
      if (shown.length === 0 && state.lines.length > 0) {
        // A single line larger than the whole budget (e.g. a minified 2MB
        // line read with anchored:false): show its head rather than an empty
        // result with a nonsensical continuation.
        const first = state.lines[0];
        const head = first.text.slice(0, byteBudget);
        shown.push({ ...first, text: anchored ? truncateForDisplay(first.text) : head });
        truncated = true;
      }
      const header = truncated
        ? `File: ${displayPath}\nLines: 1-${shown.length} of ${state.lines.length}${revisionLine(state, anchored)}`
        : `File: ${displayPath}\nLines: ${state.lines.length}${revisionLine(state, anchored)}`;
      const remaining = state.lines.length - shown.length;
      let notice = "";
      if (truncated && remaining > 0) {
        notice = `\n[${remaining} more lines in file. Use startLine=${shown.length + 1} to continue.]`;
      } else if (truncated) {
        notice =
          "\n[line 1 exceeds the result budget and was truncated — use bash (sed/cut) to extract the exact text.]";
      }
      return textResult(`${header}\n\n${renderLines(shown, anchored)}${notice}`, {
        path: displayPath,
        mode: "full",
        revision: state.revisionHash,
        lines: shown.map((line) => ({
          anchor: line.anchor,
          text: anchored ? truncateForDisplay(line.text) : line.text,
          lineNo: line.lineNo,
        })),
      });
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
  // anchored:false is the documented VERBATIM path — the anchorLine mismatch
  // teaching sends models here to copy over-long lines exactly, so plain mode
  // must never display-truncate. Anchored mode caps each line for display.
  if (!anchored) {
    return lines.map((l) => `${l.lineNo}: ${l.text}`).join("\n");
  }
  const display = lines.map((l) => ({ ...l, text: truncateForDisplay(l.text) }));
  return renderAnchoredLines(display);
}

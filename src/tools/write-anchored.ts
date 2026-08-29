import { Text, type Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { PiFastEditsConfig, SessionState } from "../types.js";
import { createFileAnchorState } from "../anchor/anchor-state.js";
import { ANCHOR_DELIMITER, renderAnchoredLines } from "../anchor/anchor-renderer.js";
import { atomicWriteFile } from "../fs/atomic-write.js";
import {
  DEFAULT_PROTECTED_SKIP,
  isProtectedPath,
  resolveWorkspacePath,
  toWorkspaceRelative,
} from "../fs/path-safety.js";
import { splitTextPreserveFinal } from "../fs/text-file.js";
import {
  renderToolCall,
  type ToolResult,
  type RenderOptions,
  type RenderContext,
} from "./render.js";
import { getCwd, textResult, type PiContext } from "./shared.js";
import type { Theme } from "./theme.js";

/** Number of written lines echoed back in the preview. */
const PREVIEW_LINE_COUNT = 5;

const writeSchema = Type.Object({
  path: Type.String({
    description: "Path to the file to write, inside the workspace.",
  }),
  content: Type.String({
    description: "Full content to write to the file.",
  }),
});
type WriteParams = Static<typeof writeSchema>;

export function registerWriteAnchored(
  pi: ExtensionAPI,
  session: SessionState,
  config: PiFastEditsConfig,
): void {
  pi.registerTool({
    name: "write_anchored",
    label: "Write Anchored File",
    description:
      "Write a full file and seed its anchor state, returning the revision hash and an anchored preview so subsequent edits need no read_anchored_file call.",
    renderCall: renderToolCall("write_anchored"),
    renderResult: renderWriteResult,
    promptSnippet: "Write a file and get anchors for immediate edits",
    promptGuidelines: [
      "The result carries the revision hash and anchored preview lines — pass them straight to the anchored edit tools",
      "Use the returned anchors to reference specific lines in subsequent edits",
      "Pass the revision hash from this result as expectedRevision in edit tools",
      "The `    line N` suffix after each rendered line is positional metadata, not part of the line — do NOT include it in startAnchorLine/endAnchorLine/anchorLine values",
    ],
    renderShell: "default",
    executionMode: "sequential",
    parameters: writeSchema,
    async execute(
      _toolCallId: string,
      params: WriteParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: PiContext,
    ) {
      const cwd = getCwd(ctx);
      const absPath = await resolveWorkspacePath(cwd, params.path.replace(/^@/, ""));
      const relativePath = toWorkspaceRelative(cwd, absPath);
      if (isProtectedPath(relativePath, [...DEFAULT_PROTECTED_SKIP, ...config.protectedPaths])) {
        throw new Error(`Refusing to write protected path: ${relativePath}.`);
      }

      await atomicWriteFile(absPath, params.content);

      // Seed anchor state from the written content. A BOM is stripped from the
      // working text (and re-added on write by the edit tools), matching
      // readTextFile so revisions line up across writes and reads.
      const hadBom = params.content.startsWith("\uFEFF");
      const seedText = hadBom ? params.content.slice(1) : params.content;
      const { lines, lineEnding, hadFinalNewline } = splitTextPreserveFinal(seedText);
      const state = createFileAnchorState(
        absPath,
        lines,
        lineEnding,
        hadFinalNewline,
        hadBom,
        seedText,
      );
      session.files.set(absPath, state);

      const preview = renderAnchoredLines(state.lines.slice(0, PREVIEW_LINE_COUNT));
      const previewBlock = preview.length > 0 ? `\n\n${preview}` : "";
      return textResult(
        `Wrote ${relativePath} (revision ${state.revisionHash}).` +
          `${previewBlock}\n\nAnchors are ready — edit_anchored_range/insert_at_anchor can edit this file now; use read_anchored_file for the full map.`,
        {
          path: relativePath,
          revision: state.revisionHash,
          lines: state.lines.slice(0, PREVIEW_LINE_COUNT).map((line) => ({
            anchor: line.anchor,
            text: line.text,
            lineNo: line.lineNo,
          })),
        },
      );
    },
  });
}

export function renderWriteResult(
  result: ToolResult,
  options: RenderOptions,
  theme: Theme,
  context: RenderContext,
): Component {
  const raw = result.content?.[0]?.text ?? "";
  if (context.isError) {
    return new Text(theme.fg("error", raw), 0, 0);
  }
  if (!options.expanded) {
    // Collapsed shows just the summary line, matching the built-in tools.
    return new Text(theme.fg("muted", raw.split("\n")[0]), 0, 0);
  }
  // Expanded strips the anchored preview prefixes, leaving the written lines.
  const lines = raw.split("\n");
  const cleaned: string[] = [];
  let skippedHeaders = false;
  for (const line of lines) {
    const idx = line.indexOf(ANCHOR_DELIMITER);
    if (idx === -1) {
      cleaned.push(line);
      continue;
    }
    if (!skippedHeaders) {
      cleaned.push(line.slice(0, idx).trimEnd());
      skippedHeaders = true;
      continue;
    }
    cleaned.push(line.slice(idx + ANCHOR_DELIMITER.length).replace(/^ /, ""));
  }
  return new Text(cleaned.join("\n"), 0, 0);
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiFastEditsConfig, SessionState } from "../types.js";
import { unifiedDiff } from "../diff/unified-diff.js";
import {
  assertExpectedRevision,
  loadStateForPath,
  getCwd,
  textResult,
  type PiContext,
} from "./shared.js";
import { applyPlansToLines, planEdit } from "./edit-core.js";
import { renderEditResult } from "./single-edit-runner.js";
import { renderToolCall } from "./render.js";
import { replaceEditSchema, type ReplaceEditParams } from "./schemas.js";

export function registerPreviewAnchoredEdit(
  pi: ExtensionAPI,
  session: SessionState,
  config: PiFastEditsConfig,
): void {
  pi.registerTool({
    name: "preview_anchored_edit",
    label: "Preview Anchored Edit",
    description: "Preview a replacement edit between two anchors without writing files.",
    promptSnippet: "Preview a replacement edit between two anchors without writing",
    promptGuidelines: [
      "Copy anchor words verbatim from a prior read_anchored_file or grep_anchored_files result",
      "Pass the exact current source line at each anchor as startAnchorLine/endAnchorLine, copied verbatim from read/grep output — the line content is verified before editing",
      "The `    line N` suffix after each rendered line is positional metadata, not part of the line — do NOT include it in startAnchorLine/endAnchorLine values",
      "Returns a diff showing what the edit would produce",
      "Does not modify the file — use edit_anchored_range to apply",
      "Pass the revision hash from read_anchored_file as expectedRevision",
    ],
    renderShell: "default",
    executionMode: "parallel",
    renderCall: renderToolCall("preview_anchored_edit"),
    renderResult: renderEditResult,
    parameters: replaceEditSchema(config.requireAnchorLines),
    async execute(
      _toolCallId: string,
      params: ReplaceEditParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: PiContext,
    ) {
      if (_signal?.aborted) return textResult("Preview cancelled (aborted).");
      const cwd = getCwd(ctx);
      const loaded = await loadStateForPath(session, cwd, params.path);
      assertExpectedRevision(
        loaded.relativePath,
        loaded.state.revisionHash,
        params.expectedRevision,
      );
      const beforeLines = loaded.state.lines.map((line) => line.text);
      const plan = planEdit(
        loaded.state,
        {
          type: "replace",
          path: params.path,
          startAnchor: params.startAnchor,
          endAnchor: params.endAnchor,
          startAnchorLine: params.startAnchorLine,
          endAnchorLine: params.endAnchorLine,
          replacement: params.replacement,
          allowAnchoredLines: params.allowAnchoredLines,
          includeStart: params.includeStart,
          includeEnd: params.includeEnd,
        },
        config.requireAnchorLines,
      );
      const afterLines = applyPlansToLines(beforeLines, [plan]);
      return textResult(unifiedDiff(beforeLines, afterLines), {
        path: loaded.relativePath,
        mode: "preview",
      });
    },
  });
}

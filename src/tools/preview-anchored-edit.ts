import type { Static } from "typebox";
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
import { replaceEditSchema } from "./schemas.js";

// The preview tool always performs a replace, so it reuses the replace schema.
type PreviewParams = Static<typeof replaceEditSchema>;

export function registerPreviewAnchoredEdit(
  pi: ExtensionAPI,
  session: SessionState,
  _config: PiFastEditsConfig,
): void {
  pi.registerTool({
    name: "preview_anchored_edit",
    label: "Preview Anchored Edit",
    description: "Preview a replacement edit between two anchors without writing files.",
    promptSnippet: "Preview a replacement edit between two anchors without writing",
    promptGuidelines: [
      "Returns a diff showing what the edit would produce",
      "Does not modify the file — use edit_anchored_range to apply",
      "Pass the revision hash from read_anchored_file as expectedRevision",
    ],
    renderShell: "default",
    executionMode: "parallel",
    renderCall: renderToolCall("preview_anchored_edit"),
    renderResult: renderEditResult,
    parameters: replaceEditSchema,
    async execute(
      _toolCallId: string,
      params: PreviewParams,
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
      const plan = planEdit(loaded.state, {
        type: "replace",
        path: params.path,
        startAnchor: params.startAnchor,
        endAnchor: params.endAnchor,
        replacement: params.replacement,
        includeStart: params.includeStart,
        includeEnd: params.includeEnd,
      });
      const afterLines = applyPlansToLines(beforeLines, [plan]);
      return textResult(unifiedDiff(beforeLines, afterLines), {
        path: loaded.relativePath,
        mode: "preview",
      });
    },
  });
}

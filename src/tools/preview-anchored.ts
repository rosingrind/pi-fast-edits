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
import { renderEditResult } from "./render-edit-result.js";
import { renderToolCall } from "./render.js";
import { replaceEditSchema, type ReplaceEditParams } from "./schemas.js";

export function registerPreviewAnchored(
  pi: ExtensionAPI,
  session: SessionState,
  config: PiFastEditsConfig,
): void {
  pi.registerTool({
    name: "preview_anchored",
    label: "Preview Anchored Edit",
    description: "Preview a replacement edit between two anchors without writing files.",
    promptSnippet: "Preview a replacement edit between two anchors without writing",
    promptGuidelines: [
      "Pass the exact current source line at each anchor as startAnchorLine/endAnchorLine, copied verbatim from read/grep output — the line content is verified before editing",
      "Dry-run only: no write; apply with edit. Pass the file's current revision hash as expectedRevision",
    ],
    renderShell: "default",
    executionMode: "parallel",
    renderCall: renderToolCall("preview_anchored"),
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

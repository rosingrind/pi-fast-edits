import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiFastEditsConfig, SessionState } from "../types.js";
import { renderEditResult, runSingleEdit } from "./single-edit-runner.js";
import { renderToolCall } from "./render.js";
import type { PiContext } from "./shared.js";
import { replaceEditSchema, type ReplaceEditParams } from "./schemas.js";

export function registerEditAnchoredRange(
  pi: ExtensionAPI,
  session: SessionState,
  config: PiFastEditsConfig,
): void {
  pi.registerTool({
    name: "edit_anchored_range",
    label: "Edit Anchored Range",
    description: "Replace a range of lines between two word anchors.",
    promptSnippet: "Replace a range between two word anchors",
    promptGuidelines: [
      "Pass the exact current source line at each anchor as startAnchorLine/endAnchorLine — verified against the file; mismatch rejects the edit",
      "includeStart/includeEnd default true; set both false with adjacent anchors for a zero-width insertion between lines",
      "Pass the file's current revision hash as expectedRevision",
      "Workflows and failure recovery: the pi-fast-edits skill (/skill:pi-fast-edits)",
    ],
    renderShell: "default",
    executionMode: "sequential",
    renderCall: renderToolCall("edit_anchored_range"),
    renderResult: renderEditResult,
    parameters: replaceEditSchema(config.requireAnchorLines),
    async execute(
      _toolCallId: string,
      params: ReplaceEditParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: PiContext,
    ) {
      return runSingleEdit(
        session,
        config,
        ctx,
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
          expectedRevision: params.expectedRevision,
        },
        _signal,
      );
    },
  });
}

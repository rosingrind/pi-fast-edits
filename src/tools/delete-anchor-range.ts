import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiFastEditsConfig, SessionState } from "../types.js";
import { renderEditResult, runSingleEdit } from "./single-edit-runner.js";
import { renderToolCall } from "./render.js";
import type { PiContext } from "./shared.js";
import { deleteEditSchema, type DeleteEditParams } from "./schemas.js";

export function registerDeleteAnchorRange(
  pi: ExtensionAPI,
  session: SessionState,
  config: PiFastEditsConfig,
): void {
  pi.registerTool({
    name: "delete_anchor_range",
    label: "Delete Anchor Range",
    description: "Delete a range of lines from start anchor through end anchor.",
    promptSnippet: "Delete a range of lines between two word anchors",
    promptGuidelines: [
      "Pass the exact current source line at each anchor as startAnchorLine/endAnchorLine — verified against the file; mismatch rejects the edit",
      "The range includes both anchor lines; pass the file's current revision hash as expectedRevision",
      "Workflows and failure recovery: the pi-fast-edits skill (/skill:pi-fast-edits)",
    ],
    renderShell: "default",
    executionMode: "sequential",
    renderCall: renderToolCall("delete_anchor_range"),
    renderResult: renderEditResult,
    parameters: deleteEditSchema(config.requireAnchorLines),
    async execute(
      _toolCallId: string,
      params: DeleteEditParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: PiContext,
    ) {
      return runSingleEdit(
        session,
        config,
        ctx,
        {
          type: "delete",
          path: params.path,
          startAnchor: params.startAnchor,
          endAnchor: params.endAnchor,
          startAnchorLine: params.startAnchorLine,
          endAnchorLine: params.endAnchorLine,
          expectedRevision: params.expectedRevision,
        },
        _signal,
      );
    },
  });
}

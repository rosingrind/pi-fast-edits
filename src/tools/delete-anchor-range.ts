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
      "Copy anchor words verbatim from a prior read_anchored_file or grep_anchored_files result",
      "Pass the exact current source line at each anchor as startAnchorLine/endAnchorLine, copied verbatim from read/grep output — the line content is verified before editing",
      "The `    line N` suffix after each rendered line is positional metadata, not part of the line — do NOT include it in startAnchorLine/endAnchorLine values",
      "The range includes both the start and end anchor lines",
      "Pass the revision hash from read_anchored_file as expectedRevision",
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

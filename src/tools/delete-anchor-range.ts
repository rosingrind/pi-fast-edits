import type { Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiFastEditsConfig, SessionState } from "../types.js";
import { renderEditResult, runSingleEdit } from "./single-edit-runner.js";
import { renderToolCall } from "./render.js";
import type { PiContext } from "./shared.js";
import { deleteEditSchema } from "./schemas.js";

type DeleteParams = Static<typeof deleteEditSchema>;

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
      "Anchors may be passed as complete ANCHOR§current-line coordinates copied verbatim from read/grep output — content is verified before editing",
      "Reference anchors from a prior read_anchored_file result",
      "The range includes both the start and end anchor lines",
      "Pass the revision hash from read_anchored_file as expectedRevision",
    ],
    renderShell: "default",
    executionMode: "sequential",
    renderCall: renderToolCall("delete_anchor_range"),
    renderResult: renderEditResult,
    parameters: deleteEditSchema,
    async execute(
      _toolCallId: string,
      params: DeleteParams,
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
          expectedRevision: params.expectedRevision,
        },
        _signal,
      );
    },
  });
}

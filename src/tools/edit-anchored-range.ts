import type { Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiFastEditsConfig, SessionState } from "../types.js";
import { renderEditResult, runSingleEdit } from "./single-edit-runner.js";
import { renderToolCall } from "./render.js";
import type { PiContext } from "./shared.js";
import { replaceEditSchema } from "./schemas.js";

type RangeParams = Static<typeof replaceEditSchema>;

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
      "Anchors may be passed as complete ANCHOR§current-line coordinates copied verbatim from read/grep output — content is verified before editing",
      "Reference anchors from a prior read_anchored_file result",
      "Use includeStart/includeEnd to fine-tune which anchor lines are replaced",
      "Pass the revision hash from read_anchored_file as expectedRevision",
      "Use raw text only in replacement — do NOT include the § anchor marker",
    ],
    renderShell: "default",
    executionMode: "sequential",
    renderCall: renderToolCall("edit_anchored_range"),
    renderResult: renderEditResult,
    parameters: replaceEditSchema,
    async execute(
      _toolCallId: string,
      params: RangeParams,
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
          replacement: params.replacement,
          includeStart: params.includeStart,
          includeEnd: params.includeEnd,
          expectedRevision: params.expectedRevision,
        },
        _signal,
      );
    },
  });
}

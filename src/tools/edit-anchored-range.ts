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
      "Copy anchor words verbatim from a prior read_anchored_file or grep_anchored_files result",
      "Pass the exact current source line at each anchor as startAnchorLine/endAnchorLine, copied verbatim from read/grep output — the line content is verified before editing",
      "The `    line N` suffix after each rendered line is positional metadata, not part of the line — do NOT include it in startAnchorLine/endAnchorLine values",
      "Use includeStart/includeEnd to fine-tune which anchor lines are replaced",
      "Pass the revision hash from read_anchored_file as expectedRevision",
      "Use raw text only in replacement — anchor-marked text (`Word§...`) is rejected; set allowAnchoredLines: true only if the § is genuine content",
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

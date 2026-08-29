import type { Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiFastEditsConfig, SessionState } from "../types.js";
import { renderEditResult, runSingleEdit } from "./single-edit-runner.js";
import { renderToolCall } from "./render.js";
import type { PiContext } from "./shared.js";
import { insertEditSchema } from "./schemas.js";

type InsertParams = Static<typeof insertEditSchema>;

export function registerInsertAtAnchor(
  pi: ExtensionAPI,
  session: SessionState,
  config: PiFastEditsConfig,
): void {
  pi.registerTool({
    name: "insert_at_anchor",
    label: "Insert At Anchor",
    description: "Insert content before or after a word anchor.",
    promptSnippet: "Insert content before or after a word anchor",
    promptGuidelines: [
      "Anchors may be passed as complete ANCHOR§current-line coordinates copied verbatim from read/grep output — content is verified before editing",
      "Reference an anchor from a prior read_anchored_file result",
      "Position must be 'before' or 'after' the anchor line",
      "Pass the revision hash from read_anchored_file as expectedRevision",
      "Use raw text only in content — do NOT include the § anchor marker",
    ],
    renderShell: "default",
    executionMode: "sequential",
    renderCall: renderToolCall("insert_at_anchor"),
    renderResult: renderEditResult,
    parameters: insertEditSchema,
    async execute(
      _toolCallId: string,
      params: InsertParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: PiContext,
    ) {
      return runSingleEdit(
        session,
        config,
        ctx,
        {
          type: "insert",
          path: params.path,
          anchor: params.anchor,
          position: params.position,
          content: params.content,
          expectedRevision: params.expectedRevision,
        },
        _signal,
      );
    },
  });
}

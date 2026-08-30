import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiFastEditsConfig, SessionState } from "../types.js";
import { renderEditResult, runSingleEdit } from "./single-edit-runner.js";
import { renderToolCall } from "./render.js";
import type { PiContext } from "./shared.js";
import { insertEditSchema, type InsertEditParams } from "./schemas.js";

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
      "Pass the exact current source line at the anchor as anchorLine — verified against the file; mismatch rejects the edit",
      "Use raw text only in content — anchor-marked text (`Word§...`) is rejected; set allowAnchoredLines: true only if the § is genuine content",
      "Pass the file's current revision hash as expectedRevision",
      "Workflows and failure recovery: the pi-fast-edits skill (/skill:pi-fast-edits)",
    ],
    renderShell: "default",
    executionMode: "sequential",
    renderCall: renderToolCall("insert_at_anchor"),
    renderResult: renderEditResult,
    parameters: insertEditSchema(config.requireAnchorLines),
    async execute(
      _toolCallId: string,
      params: InsertEditParams,
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
          anchorLine: params.anchorLine,
          position: params.position,
          content: params.content,
          allowAnchoredLines: params.allowAnchoredLines,
          expectedRevision: params.expectedRevision,
        },
        _signal,
      );
    },
  });
}

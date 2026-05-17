import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiFastEditsConfig, SessionState } from "../types.js";
import { runSingleEdit } from "./single-edit-runner.js";

export function registerInsertAtAnchor(pi: ExtensionAPI, session: SessionState, config: PiFastEditsConfig): void {
  pi.registerTool({
    name: "insert_at_anchor",
    label: "Insert At Anchor",
    description: "Insert content before or after a Dirac-style line anchor.",
    parameters: Type.Object({
      path: Type.String(),
      anchor: Type.String(),
      position: Type.String({ description: "before or after" }),
      content: Type.String(),
      expectedRevision: Type.Optional(Type.String())
    }),
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      return runSingleEdit(session, config, ctx, {
        type: "insert",
        path: params.path,
        anchor: params.anchor,
        position: params.position === "before" ? "before" : "after",
        content: params.content,
        expectedRevision: params.expectedRevision
      });
    }
  });
}

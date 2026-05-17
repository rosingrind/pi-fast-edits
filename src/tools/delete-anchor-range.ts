import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiFastEditsConfig, SessionState } from "../types.js";
import { runSingleEdit } from "./single-edit-runner.js";

export function registerDeleteAnchorRange(pi: ExtensionAPI, session: SessionState, config: PiFastEditsConfig): void {
  pi.registerTool({
    name: "delete_anchor_range",
    label: "Delete Anchor Range",
    description: "Delete a range of lines from start anchor through end anchor.",
    parameters: Type.Object({
      path: Type.String(),
      startAnchor: Type.String(),
      endAnchor: Type.String(),
      expectedRevision: Type.Optional(Type.String())
    }),
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      return runSingleEdit(session, config, ctx, {
        type: "delete",
        path: params.path,
        startAnchor: params.startAnchor,
        endAnchor: params.endAnchor,
        expectedRevision: params.expectedRevision
      });
    }
  });
}

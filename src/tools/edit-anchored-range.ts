import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiFastEditsConfig, SessionState } from "../types.js";
import { runSingleEdit } from "./single-edit-runner.js";

export function registerEditAnchoredRange(pi: ExtensionAPI, session: SessionState, config: PiFastEditsConfig): void {
  pi.registerTool({
    name: "edit_anchored_range",
    label: "Edit Anchored Range",
    description: "Replace a range of lines between two Dirac-style anchors.",
    parameters: Type.Object({
      path: Type.String(),
      startAnchor: Type.String(),
      endAnchor: Type.String(),
      replacement: Type.String(),
      includeStart: Type.Optional(Type.Boolean()),
      includeEnd: Type.Optional(Type.Boolean()),
      expectedRevision: Type.Optional(Type.String())
    }),
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      return runSingleEdit(session, config, ctx, {
        type: "replace",
        path: params.path,
        startAnchor: params.startAnchor,
        endAnchor: params.endAnchor,
        replacement: params.replacement,
        includeStart: params.includeStart,
        includeEnd: params.includeEnd,
        expectedRevision: params.expectedRevision
      });
    }
  });
}

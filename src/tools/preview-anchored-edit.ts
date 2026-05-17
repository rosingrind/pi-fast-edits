import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiFastEditsConfig, SessionState } from "../types.js";
import { unifiedDiff } from "../diff/unified-diff.js";
import { assertExpectedRevision, loadStateForPath, getCwd, textResult } from "./shared.js";
import { applyPlansToLines, planEdit } from "./edit-core.js";

export function registerPreviewAnchoredEdit(pi: ExtensionAPI, session: SessionState, _config: PiFastEditsConfig): void {
  pi.registerTool({
    name: "preview_anchored_edit",
    label: "Preview Anchored Edit",
    description: "Preview a replacement edit between two anchors without writing files.",
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
      const cwd = getCwd(ctx);
      const loaded = await loadStateForPath(session, cwd, params.path);
      assertExpectedRevision(loaded.relativePath, loaded.state.revisionHash, params.expectedRevision);
      const beforeLines = loaded.state.lines.map((line) => line.text);
      const plan = planEdit(loaded.state, {
        type: "replace",
        path: params.path,
        startAnchor: params.startAnchor,
        endAnchor: params.endAnchor,
        replacement: params.replacement,
        includeStart: params.includeStart,
        includeEnd: params.includeEnd
      });
      const afterLines = applyPlansToLines(beforeLines, [plan]);
      return textResult(unifiedDiff(loaded.relativePath, beforeLines, afterLines), { path: loaded.relativePath, mode: "preview" });
    }
  });
}

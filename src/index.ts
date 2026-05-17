import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "./config.js";
import type { SessionState } from "./types.js";
import { registerCommands } from "./commands/register.js";
import { registerReadAnchoredFile } from "./tools/read-anchored-file.js";
import { registerEditAnchoredRange } from "./tools/edit-anchored-range.js";
import { registerInsertAtAnchor } from "./tools/insert-at-anchor.js";
import { registerDeleteAnchorRange } from "./tools/delete-anchor-range.js";
import { registerPreviewAnchoredEdit } from "./tools/preview-anchored-edit.js";
import { registerApplyAnchoredEdits } from "./tools/apply-anchored-edits.js";

export default function piFastEdits(pi: ExtensionAPI): void {
  const config = { ...DEFAULT_CONFIG, protectedPaths: [...DEFAULT_CONFIG.protectedPaths] };
  const session: SessionState = { files: new Map() };

  registerReadAnchoredFile(pi, session, config);
  registerEditAnchoredRange(pi, session, config);
  registerInsertAtAnchor(pi, session, config);
  registerDeleteAnchorRange(pi, session, config);
  registerPreviewAnchoredEdit(pi, session, config);
  registerApplyAnchoredEdits(pi, session, config);
  registerCommands(pi, session, config);

  pi.on("tool_call", async (event: { toolName?: string }, _ctx: unknown) => {
    if (!config.overrideBuiltInEditTools) return;
    const name = event.toolName ?? "";
    if (["write", "edit", "write_file", "edit_file"].includes(name)) {
      return {
        block: true,
        reason: "pi-fast-edits override is enabled. Use read_anchored_file plus anchored edit tools instead."
      };
    }
  });
}

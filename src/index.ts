import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LRUMap, type PiFastEditsConfig, type SessionState } from "./types.js";
import { loadConfig } from "./config-persistence.js";
import { atomicWriteFile } from "./fs/atomic-write.js";
import {
  exportAnchorState,
  hydrateAnchorState,
  stateFilePath,
} from "./anchor/state-persistence.js";
import { registerCommands } from "./commands/register.js";
import { registerReadAnchoredFile } from "./tools/read-anchored-file.js";
import { registerGrepAnchoredFiles } from "./tools/grep-anchored.js";
import { registerWriteAnchored } from "./tools/write-anchored.js";
import { registerEditAnchoredRange } from "./tools/edit-anchored-range.js";
import { registerInsertAtAnchor } from "./tools/insert-at-anchor.js";
import { registerDeleteAnchorRange } from "./tools/delete-anchor-range.js";
import { registerPreviewAnchoredEdit } from "./tools/preview-anchored-edit.js";
import { registerApplyAnchoredEdits } from "./tools/apply-anchored-edits.js";
import {
  applyOverrideMode,
  installInterceptionFallback,
  type OverrideDeps,
} from "./tools/override.js";

export default async function piFastEdits(
  pi: ExtensionAPI,
  overrides?: Partial<PiFastEditsConfig>,
): Promise<void> {
  // Load persisted config, merge with defaults and overrides (overrides win)
  const diskConfig = await loadConfig();
  const config: PiFastEditsConfig = {
    ...diskConfig,
    protectedPaths: [...diskConfig.protectedPaths],
    ...overrides,
  };
  const session: SessionState = { files: new LRUMap() };

  registerReadAnchoredFile(pi, session, config);
  registerGrepAnchoredFiles(pi, session, config);
  registerWriteAnchored(pi, session, config);

  // The five anchored edit tools re-register whenever the config changes, so
  // their schemas (strict vs. lenient `*Line` args) follow the live
  // `requireAnchorLines` setting. pi.replace semantics: registering the same
  // tool name refreshes it in-session.
  const registerAnchoredEditTools = () => {
    registerEditAnchoredRange(pi, session, config);
    registerInsertAtAnchor(pi, session, config);
    registerDeleteAnchorRange(pi, session, config);
    registerPreviewAnchoredEdit(pi, session, config);
    registerApplyAnchoredEdits(pi, session, config);
  };
  registerAnchoredEditTools();
  registerCommands(pi, session, config, registerAnchoredEditTools);

  // Override wiring is applied from session_start, not the factory: pi's
  // runtime actions (getAllTools/getActiveTools/setActiveTools) are only bound
  // after extension loading, and re-registering at runtime refreshes the
  // registry in-session.
  const overrideDeps: OverrideDeps = {
    registerRead: registerReadAnchoredFile,
    registerEdit: registerApplyAnchoredEdits,
    registerGrep: registerGrepAnchoredFiles,
    registerWrite: registerWriteAnchored,
    installInterception: installInterceptionFallback,
  };

  pi.on("session_start", async (_event, ctx) => {
    try {
      if (existsSync(stateFilePath())) {
        hydrateAnchorState(session, JSON.parse(readFileSync(stateFilePath(), "utf-8")));
      }
    } catch {
      // Corrupt state — start fresh.
    }
    if (config.overrideBuiltInEditTools) {
      applyOverrideMode(pi, session, config, overrideDeps, ctx);
    }
  });
  pi.on("session_shutdown", async () => {
    try {
      // atomicWriteFile creates parent directories recursively.
      await atomicWriteFile(stateFilePath(), JSON.stringify(exportAnchorState(session)));
    } catch {
      // Best-effort persistence.
    }
  });
}

import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { LRUMap, type PiFastEditsConfig, type SessionState } from "./types.js";
import { loadConfig } from "./config-persistence.js";
import { atomicWriteFile } from "./fs/atomic-write.js";
import {
  exportAnchorState,
  hydrateAnchorState,
  stateFilePath,
} from "./anchor/state-persistence.js";
import { registerCommands } from "./commands/register.js";
import { registerReadAnchored } from "./tools/read-anchored.js";
import { registerGrepAnchored } from "./tools/grep-anchored.js";
import { registerWriteAnchored } from "./tools/write-anchored.js";
import { registerEditAnchored } from "./tools/edit-anchored.js";
import { applyToolSurface } from "./tools/override.js";
import { createOverrideNoticeHandler } from "./tools/override-notice.js";
import { collectReadRoots, piDocsRoot, type SkillRef } from "./fs/read-roots.js";

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
  const session: SessionState = { files: new LRUMap(), readRoots: [] };

  registerReadAnchored(pi, session, config);
  registerGrepAnchored(pi, session, config);
  registerWriteAnchored(pi, session, config);

  // The five anchored edit tools re-register whenever the config changes, so
  // their schemas (strict vs. lenient `*Line` args) follow the live
  // `requireAnchorLines` setting. pi.replace semantics: registering the same
  // tool name refreshes it in-session.
  const registerAnchoredEditTools = () => {
    registerEditAnchored(pi, session, config);
  };
  registerAnchoredEditTools();

  // The tool surface (which names the model can call) is applied from
  // session_start, not the factory: pi's runtime actions
  // (getActiveTools/setActiveTools) are only bound after extension loading.
  const onConfigChanged = (_id: string, _ctx?: ExtensionCommandContext) => {
    registerAnchoredEditTools();
    applyToolSurface(pi, config);
  };
  registerCommands(pi, session, config, onConfigChanged);

  // Mid-session toggle notice: compares each turn's override mode to the
  // previous turn's; fires only on a change (baseline is set on the first
  // turn, so startup-when-on stays silent). Handler is a single boolean
  // read + compare per turn.
  pi.on("before_agent_start", createOverrideNoticeHandler(config));

  // Host-sanctioned read roots: refreshed every turn from the skills pi has
  // loaded (their baseDirs) plus pi's package docs root. Reads may target
  // these outside-workspace roots; writes and greps stay workspace-bound.
  pi.on("before_agent_start", (event) => {
    const skills = (event as { systemPromptOptions?: { skills?: SkillRef[] } } | undefined)
      ?.systemPromptOptions?.skills;
    session.readRoots = collectReadRoots(skills, piDocsRoot());
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      if (existsSync(stateFilePath())) {
        hydrateAnchorState(session, JSON.parse(readFileSync(stateFilePath(), "utf-8")));
      }
    } catch {
      // Corrupt state — start fresh.
    }
    applyToolSurface(pi, config);
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

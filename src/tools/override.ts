import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiFastEditsConfig } from "../types.js";

/**
 * Tool-surface control: which names the model can call.
 *
 * pi-fast-edits used to rename its anchored implementations over the built-in
 * read/edit/write/grep names (overrideBuiltInEditTools). Newer pi versions
 * split dispatch for shadowed built-in names — validation and the prompt come
 * from the extension def, but execution runs the BUILT-IN body, so anchored-
 * shaped arguments crash inside the built-in edit's oldText normalization
 * ("Cannot read properties of undefined (reading 'replace')"). The rename
 * mechanism was therefore removed: the anchored tools are always registered
 * under their suffixed names, and the only surface control is
 * `suppressNativeTools` — hiding the native names entirely so the model can
 * only call the anchored tools (a hidden tool never executes, so the broken
 * built-in dispatch is unreachable).
 */

/** The suffixed anchored tool names — the canonical, always-registered surface. */
export const SUFFIXED_TOOL_NAMES = [
  "read_anchored",
  "grep_anchored",
  "write_anchored",
  "edit_anchored",
] as const;

/** The native built-in tool names suppress mode removes from the active set. */
const NATIVE_TOOL_NAMES = ["read", "edit", "write", "grep"] as const;

/**
 * Apply the configured tool surface. Runs on session_start and every config
 * change. The anchored tools are always present in the active set; the native
 * names are removed when `suppressNativeTools` is on and re-added when it
 * turns off. Idempotent — safe to call unconditionally.
 */
export function applyToolSurface(pi: ExtensionAPI, config: PiFastEditsConfig): void {
  const keepActive = new Set(pi.getActiveTools());
  for (const name of SUFFIXED_TOOL_NAMES) {
    keepActive.add(name);
  }
  if (config.suppressNativeTools) {
    for (const name of NATIVE_TOOL_NAMES) {
      keepActive.delete(name);
    }
  } else {
    for (const name of NATIVE_TOOL_NAMES) {
      keepActive.add(name);
    }
  }
  pi.setActiveTools([...keepActive]);
}

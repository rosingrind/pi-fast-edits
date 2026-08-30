import type { PiFastEditsConfig } from "../types.js";

/**
 * The anchored tool names announced in the override transition notices.
 *
 * All eight suffixed names, including `grep_anchored`: the enabled
 * notice lists them as deactivated while override is on, and the disabled
 * notice lists them as re-activated. Keep in sync with that copy — the tests
 * pin it verbatim.
 */
export const ANCHORED_TOOL_NAMES = [
  "read_anchored",
  "grep_anchored",
  "edit_anchored",
  "write_anchored",
] as const;

const ANCHORED_LIST = ANCHORED_TOOL_NAMES.join(", ");

export const OVERRIDE_ENABLED_NOTICE = `Tool override enabled: read/edit/write/grep now use anchor-line contracts (see each tool's schema). Previous anchored tool names (${ANCHORED_LIST}) are deactivated.`;

export const OVERRIDE_DISABLED_NOTICE = `Tool override disabled: the anchored tools (${ANCHORED_LIST}) are active again; read/edit/write/grep keep their anchored definitions until pi reloads the extension (fully native restore requires a reload).`;

export type OverrideToggleNotice = {
  message: {
    customType: string;
    content: string;
    display: boolean;
  };
};

export type OverrideToggleTracker = (current: boolean) => OverrideToggleNotice | undefined;

/**
 * Tracks the last-seen override mode across turns. The first call establishes
 * the baseline (no notice — startup-when-on is taught by the tool schemas and
 * guidelines themselves); every later call that differs from the last-seen
 * value fires exactly one notice for that direction. Deliberately cheap: one
 * boolean read + compare per turn, no allocation on the steady-state path.
 */
export function createOverrideToggleTracker(): OverrideToggleTracker {
  let lastSeen: boolean | undefined;
  return (current: boolean): OverrideToggleNotice | undefined => {
    if (lastSeen === undefined) {
      lastSeen = current;
      return undefined;
    }
    if (current === lastSeen) {
      return undefined;
    }
    lastSeen = current;
    return {
      message: {
        customType: "pi-fast-edits",
        content: current ? OVERRIDE_ENABLED_NOTICE : OVERRIDE_DISABLED_NOTICE,
        display: true,
      },
    };
  };
}

/**
 * The `before_agent_start` handler body: reads `overrideBuiltInEditTools`
 * from the live config each turn and delegates the compare to the tracker, so
 * a mid-session menu toggle surfaces as a notice on the next turn.
 */
export function createOverrideNoticeHandler(
  config: Pick<PiFastEditsConfig, "overrideBuiltInEditTools">,
  tracker: OverrideToggleTracker = createOverrideToggleTracker(),
): () => OverrideToggleNotice | undefined {
  return () => tracker(config.overrideBuiltInEditTools);
}

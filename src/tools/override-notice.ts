import type { PiFastEditsConfig } from "../types.js";

/**
 * The anchored tool names announced in the surface notices.
 */
export const ANCHORED_TOOL_NAMES = [
  "read_anchored",
  "grep_anchored",
  "edit_anchored",
  "write_anchored",
] as const;

const ANCHORED_LIST = ANCHORED_TOOL_NAMES.join(", ");

export const SUPPRESS_NOTICE = `Native read/edit/write/grep are hidden — use the anchored tools (${ANCHORED_LIST}) for all file work.`;

export const NATIVE_RESTORED_NOTICE = `Native read/edit/write/grep are active again — prefer the anchored tools (${ANCHORED_LIST}) for anchor-based file work.`;

export type OverrideToggleNotice = {
  message: {
    customType: string;
    content: string;
    display: boolean;
  };
};

export type OverrideToggleTracker = (current: boolean) => OverrideToggleNotice | undefined;

/**
 * Tracks the last-seen suppress state across turns. The first call establishes
 * the baseline (no notice — the tool schemas teach the surface); every later
 * call that differs fires exactly one notice for that direction. Deliberately
 * cheap: one boolean read + compare per turn.
 */
export function createOverrideToggleTracker(): OverrideToggleTracker {
  let lastSeen: boolean | undefined;
  const noticeByState: Record<"hidden" | "shown", string> = {
    hidden: SUPPRESS_NOTICE,
    shown: NATIVE_RESTORED_NOTICE,
  };
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
        content: noticeByState[current ? "hidden" : "shown"],
        display: true,
      },
    };
  };
}

/**
 * The `before_agent_start` handler body: reads `suppressNativeTools` from the
 * live config each turn and delegates the compare to the tracker, so a
 * mid-session menu toggle surfaces as a notice on the next turn.
 */
export function createOverrideNoticeHandler(
  config: Pick<PiFastEditsConfig, "suppressNativeTools">,
  tracker: OverrideToggleTracker = createOverrideToggleTracker(),
): () => OverrideToggleNotice | undefined {
  return () => tracker(config.suppressNativeTools);
}

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { PiFastEditsConfig } from "../src/types.js";
import {
  ANCHORED_TOOL_NAMES,
  NATIVE_RESTORED_NOTICE,
  SUPPRESS_NOTICE,
  createOverrideNoticeHandler,
  createOverrideToggleTracker,
} from "../src/tools/override-notice.js";

function makeConfig(suppressNativeTools: boolean): PiFastEditsConfig {
  return {
    ...DEFAULT_CONFIG,
    protectedPaths: [...DEFAULT_CONFIG.protectedPaths],
    suppressNativeTools,
  };
}

describe("surface toggle notice", () => {
  it("suppress notice names every anchored tool", () => {
    for (const name of ANCHORED_TOOL_NAMES) {
      expect(SUPPRESS_NOTICE).toContain(name);
    }
  });

  it("restore notice names every anchored tool", () => {
    for (const name of ANCHORED_TOOL_NAMES) {
      expect(NATIVE_RESTORED_NOTICE).toContain(name);
    }
  });

  it("primes the baseline on the first turn: no notice in either state", () => {
    expect(createOverrideToggleTracker()(false)).toBeUndefined();
    expect(createOverrideToggleTracker()(true)).toBeUndefined();
  });

  it("injects the suppress notice exactly once on a shown→hidden change, then stays silent", () => {
    const track = createOverrideToggleTracker();
    track(false); // primes the stored previous state
    const notice = track(true);
    expect(notice).toEqual({
      message: { customType: "pi-fast-edits", content: SUPPRESS_NOTICE, display: true },
    });
    expect(track(true)).toBeUndefined();
    expect(track(true)).toBeUndefined();
  });

  it("injects the restore notice exactly once on a hidden→shown change, then stays silent", () => {
    const track = createOverrideToggleTracker();
    track(true);
    expect(track(false)).toEqual({
      message: { customType: "pi-fast-edits", content: NATIVE_RESTORED_NOTICE, display: true },
    });
    expect(track(false)).toBeUndefined();
  });

  it("fires exactly once per change across alternating toggles", () => {
    const track = createOverrideToggleTracker();
    track(false);
    expect(track(true)?.message.content).toBe(SUPPRESS_NOTICE);
    expect(track(false)?.message.content).toBe(NATIVE_RESTORED_NOTICE);
    expect(track(true)?.message.content).toBe(SUPPRESS_NOTICE);
    // steady state back at hidden: no further notice
    expect(track(true)).toBeUndefined();
  });

  it("handler reads the live suppressNativeTools config each turn", () => {
    const config = makeConfig(false);
    const handler = createOverrideNoticeHandler(config);
    expect(handler()).toBeUndefined(); // baseline
    config.suppressNativeTools = true;
    expect(handler()?.message.content).toBe(SUPPRESS_NOTICE);
    expect(handler()).toBeUndefined();
  });
});

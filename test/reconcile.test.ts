import { describe, expect, it } from "vitest";
import { createFileAnchorState } from "../src/anchor/anchor-state.js";
import { MAX_RETIRED_ANCHORS, reconcileState } from "../src/anchor/reconcile.js";
import type { LineEnding } from "../src/types.js";

describe("reconcileState", () => {
  it("preserves anchors for unchanged shifted lines", () => {
    const state = createFileAnchorState("file.ts", ["a", "b", "c"], "\n", true, false, "a\nb\nc\n");
    const bAnchor = state.lines[1].anchor;
    reconcileState(state, ["z", "a", "b", "c"], "\n", true, false);
    expect(state.lines[2].anchor).toBe(bAnchor);
  });

  it("retires the anchor of a removed line", () => {
    const state = createFileAnchorState(
      "test.txt",
      ["a", "b", "c"],
      "\n",
      true,
      false,
      "a\nb\nc\n",
    );
    const bAnchor = state.lines[1].anchor;
    reconcileState(state, ["a", "c"], "\n", true, false);
    expect(state.retiredAnchors.has(bAnchor)).toBe(true);
    expect(state.lines.map((l) => l.text)).toEqual(["a", "c"]);
  });

  it("removing every line leaves empty lines and retires all anchors", () => {
    const state = createFileAnchorState("test.txt", ["a", "b"], "\n", true, false, "a\nb\n");
    reconcileState(state, [], "\n", false, false);
    expect(state.lines).toHaveLength(0);
    expect(state.retiredAnchors.size).toBe(2);
  });

  it("preserves anchors when only the line ending changes", () => {
    const state = createFileAnchorState(
      "test.txt",
      ["a", "b"],
      "\n" as LineEnding,
      true,
      false,
      "a\nb\n",
    );
    const oldAppleAnchor = state.lines[0].anchor;
    reconcileState(state, ["a", "b"], "\r\n" as LineEnding, true, false);
    expect(state.lines).toHaveLength(2);
    expect(state.lines[0].anchor).toBe(oldAppleAnchor);
    expect(state.lineEnding).toBe("\r\n");
  });

  it("caps retired anchors at MAX_RETIRED_ANCHORS, dropping the oldest", () => {
    const state = createFileAnchorState(
      "test.txt",
      ["a", "b", "c"],
      "\n",
      true,
      false,
      "a\nb\nc\n",
    );
    // Manually seed the retired set past the cap so the next reconcile trims it.
    for (let i = 0; i < MAX_RETIRED_ANCHORS + 50; i++) {
      state.retiredAnchors.add(`retired-${i}`);
    }
    // A no-op reconcile still runs the trim step.
    reconcileState(state, ["a", "b", "c"], "\n", true, false);
    expect(state.retiredAnchors.size).toBe(MAX_RETIRED_ANCHORS);
    // Oldest entries are dropped first; the newest survive.
    expect(state.retiredAnchors.has("retired-0")).toBe(false);
    expect(state.retiredAnchors.has(`retired-${MAX_RETIRED_ANCHORS + 49}`)).toBe(true);
  });
});

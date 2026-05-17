import { describe, expect, it } from "vitest";
import { createFileAnchorState } from "../src/anchor/anchor-state.js";
import { reconcileState } from "../src/anchor/reconcile.js";

describe("reconcileState", () => {
  it("preserves anchors for unchanged shifted lines", () => {
    const state = createFileAnchorState("file.ts", ["a", "b", "c"], "\n", true, "a\nb\nc\n");
    const bAnchor = state.lines[1].anchor;
    reconcileState(state, ["z", "a", "b", "c"], "\n", true);
    expect(state.lines[2].anchor).toBe(bAnchor);
  });
});

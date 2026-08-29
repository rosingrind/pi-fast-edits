import { describe, expect, it } from "vitest";
import { AnchorPool } from "../src/anchor/anchor-pool.js";
import { createFileAnchorState, poolFromState } from "../src/anchor/anchor-state.js";
import { reconcileState } from "../src/anchor/reconcile.js";
import { WORD_ANCHORS } from "../src/anchor/word-list.js";
import type { AnchoredEdit } from "../src/types.js";
import { applyPlansToLines, planEdit } from "../src/tools/edit-core.js";

describe("AnchorPool", () => {
  it("retired anchors are skipped in next()", () => {
    const pool = new AnchorPool();
    const a1 = pool.next();
    pool.retire(a1);
    const a2 = pool.next();
    expect(a2).not.toBe(a1);
  });

  it("poolFromState marks existing anchors used so next() returns fresh ones", () => {
    const state = createFileAnchorState("test.txt", ["a", "b", "c"], "\n", true, "a\nb\nc\n");
    const pool = poolFromState(state);
    const existing = new Set(state.lines.map((line) => line.anchor));
    expect(existing.size).toBe(3);
    const fresh = [pool.next(), pool.next(), pool.next()];
    expect(fresh).toHaveLength(3);
    // Used anchors are never re-issued, so every fresh anchor avoids the file's
    // existing anchors.
    expect(fresh.every((anchor) => !existing.has(anchor))).toBe(true);
  });

  it("poolFromState retires deleted anchors so they're skipped", () => {
    const state = createFileAnchorState("test.txt", ["a", "b", "c"], "\n", true, "a\nb\nc\n");
    const originalBAnchor = state.lines[1].anchor;

    // Delete "b"
    const edit: AnchoredEdit = {
      type: "delete",
      path: "test.txt",
      startAnchor: originalBAnchor,
      endAnchor: originalBAnchor,
    };
    const plan = planEdit(state, edit);
    const newLines = applyPlansToLines(
      state.lines.map((line) => line.text),
      [plan],
    );
    const newState = reconcileState(state, newLines, state.lineEnding, state.hadFinalNewline);

    // "b"'s anchor should be retired.
    expect(newState.retiredAnchors.has(originalBAnchor)).toBe(true);

    // A pool built from the retired state skips the retired anchor.
    const newPool = poolFromState(newState);
    const newAnchors = [newPool.next(), newPool.next()];
    expect(newAnchors).not.toContain(originalBAnchor);
  });
});

describe("AnchorPool randomization", () => {
  it("pool is a permutation of the word list", () => {
    const pool = new AnchorPool(() => 0.5); // deterministic rng
    // Exhaust into the cycle to observe the full base pool ordering.
    const seen: string[] = [];
    for (let i = 0; i < WORD_ANCHORS.length; i++) seen.push(pool.next());
    expect([...seen].sort()).toEqual([...WORD_ANCHORS].sort());
    expect(new Set(seen).size).toBe(WORD_ANCHORS.length);
  });

  it("two pools with different rng disagree on the first word (statistically)", () => {
    // With a fixed non-identity rng, first word must differ from "Apple" for
    // all but 1/199 of seeds; use two distinct fixed rngs.
    const a = new AnchorPool(() => 0.1).next();
    const b = new AnchorPool(() => 0.9).next();
    expect(a).not.toBe(b);
  });

  it("numeric cycling still works after exhaustion", () => {
    const pool = new AnchorPool(() => 0.5);
    const firstRound = new Set<string>();
    for (let i = 0; i < WORD_ANCHORS.length; i++) firstRound.add(pool.next());
    const again = pool.next();
    expect(again).toMatch(/\d+$/); // suffixed cycle word
  });
});

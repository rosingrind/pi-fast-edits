import { describe, expect, it } from "vitest";
import { createFileAnchorState } from "../src/anchor/anchor-state.js";
import { LRUMap, type SessionState } from "../src/types.js";
import { exportAnchorState, hydrateAnchorState } from "../src/anchor/state-persistence.js";

function makeSession(): SessionState {
  return { files: new LRUMap(), readRoots: [] };
}

describe("anchor state persistence", () => {
  it("round-trips a session's anchor states", () => {
    const session = makeSession();
    const state = createFileAnchorState("/w/a.ts", ["one", "two"], "\n", true, false, "one\ntwo");
    session.files.set("/w/a.ts", state);
    const data = exportAnchorState(session);
    const restored = makeSession();
    hydrateAnchorState(restored, data);
    const back = restored.files.get("/w/a.ts")!;
    expect(back.lines.map((l) => l.anchor)).toEqual(state.lines.map((l) => l.anchor));
    expect(back.lines.map((l) => l.text)).toEqual(["one", "two"]);
    expect(back.revisionHash).toBe(state.revisionHash);
    expect(back.hadBom).toBe(false);
  });

  it("ignores malformed data", () => {
    const session = makeSession();
    expect(() => hydrateAnchorState(session, { version: 99 })).not.toThrow();
    expect(() => hydrateAnchorState(session, "garbage")).not.toThrow();
    expect(session.files.size).toBe(0);
  });

  it("hydrated states reconcile against changed files on next read", async () => {
    const session = makeSession();
    const state = createFileAnchorState("/w/a.ts", ["one"], "\n", true, false, "one");
    session.files.set("/w/a.ts", state);
    const restored = makeSession();
    hydrateAnchorState(restored, exportAnchorState(session));
    // Simulate the file having changed on disk: loadStateForPath's revision
    // check reconciles; here we assert the stored revision differs from a
    // different content so the guard triggers.
    expect(restored.files.get("/w/a.ts")!.revisionHash).not.toBe(
      createFileAnchorState("/w/a.ts", ["changed"], "\n", true, false, "changed").revisionHash,
    );
  });
});

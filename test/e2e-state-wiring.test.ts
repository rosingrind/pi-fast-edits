import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import piFastEdits from "../src/index.js";
import { hydrateAnchorState, stateFilePath } from "../src/anchor/state-persistence.js";
import { LRUMap, type SessionState } from "../src/types.js";

type ToolDef = {
  name: string;
  execute: (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => Promise<any>;
};

async function harness() {
  const handlers: Record<string, (event?: any, ctx?: any) => Promise<any>> = {};
  const tools = new Map<string, ToolDef>();
  const pi = {
    registerTool(t: ToolDef) {
      tools.set(t.name, t);
    },
    registerCommand() {},
    getAllTools() {
      return [];
    },
    getActiveTools() {
      return [];
    },
    setActiveTools() {},
    on(event: string, handler: (event?: any, ctx?: any) => Promise<any>) {
      handlers[event] = handler;
    },
  };
  await piFastEdits(pi as any);
  return { handlers, tools };
}

describe("session event wiring (e2e)", () => {
  it("session_shutdown persists and session_start hydrates anchor state", async () => {
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pfe-e2e-"));

    // One instance: read builds anchor state in its session, shutdown persists it.
    const s = await harness();
    const cwd = mkdtempSync(join(tmpdir(), "pfe-ws-"));
    const file = join(cwd, "a.ts");
    writeFileSync(file, "one\ntwo\n");
    await s.tools
      .get("read_anchored")!
      .execute("1", { path: "a.ts" }, undefined, undefined, { cwd });

    await s.handlers.session_shutdown!();

    const path = stateFilePath();
    expect(existsSync(path)).toBe(true);

    // Persisted payload round-trips the anchor strings verbatim.
    const restored: SessionState = { files: new LRUMap(), readRoots: [] };
    hydrateAnchorState(restored, JSON.parse(readFileSync(path, "utf-8")));
    const state = restored.files.get(file)!;
    expect(state.lines.map((l) => l.anchor)).toEqual([
      expect.stringMatching(/^[A-Za-z]+$/),
      expect.stringMatching(/^[A-Za-z]+$/),
    ]);
    expect(state.lines.map((l) => l.text)).toEqual(["one", "two"]);
    expect(state.revisionHash).toMatch(/^[a-f0-9]{16}$/);

    // Corrupt file must not throw on session_start of a fresh instance.
    writeFileSync(path, "{ not json");
    const s3 = await harness();
    await expect(s3.handlers.session_start!()).resolves.toBeUndefined();

    process.env.PI_CODING_AGENT_DIR = prev;
  });
});

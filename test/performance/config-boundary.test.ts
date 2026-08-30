import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import piFastEdits from "../../src/index.js";
import type { PiFastEditsConfig } from "../../src/types.js";

type ToolDef = {
  name: string;
  execute: (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => Promise<any>;
};

async function loadTools(overrides?: Partial<PiFastEditsConfig>): Promise<Map<string, ToolDef>> {
  const tools = new Map<string, ToolDef>();
  const pi = {
    registerTool(tool: ToolDef) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    on() {},
  };
  await piFastEdits(pi as any, overrides);
  return tools;
}

async function workspace() {
  return mkdtemp(join(tmpdir(), "pi-fast-edits-boundary-"));
}

describe("config degenerate zero-values", () => {
  it("maxRangeReadLines=0 produces an invalid range error when endLine is omitted", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "range-zero.txt"), "alpha\nbeta\ngamma\n", "utf8");
    const tools = await loadTools({ maxRangeReadLines: 0 });

    // Without endLine, the default end = min(3, 1 + 0 - 1) = 0, so start(1) > end(0).
    await expect(
      tools
        .get("read_anchored")!
        .execute("1", { path: "range-zero.txt", startLine: 1 }, undefined, undefined, { cwd }),
    ).rejects.toThrow(/Invalid range/);
  });
});

describe("maxRangeReadLines clamp", () => {
  it("range without endLine is clamped to maxRangeReadLines from startLine", async () => {
    const cwd = await workspace();
    const lines = Array.from({ length: 1000 }, (_, i) => `line-${i}`);
    await writeFile(join(cwd, "range-clamp.txt"), lines.join("\n") + "\n", "utf8");
    const tools = await loadTools({ maxRangeReadLines: 400 });

    // Without endLine, the default end = min(1000, 1 + 400 - 1) = 400.
    const result = await tools
      .get("read_anchored")!
      .execute("1", { path: "range-clamp.txt", startLine: 1 }, undefined, undefined, { cwd });

    expect(result.details.mode).toBe("range");
    // The returned lines should be clamped to maxRangeReadLines (400).
    const linesReturned = (result.details as any)?.lines as any[];
    expect(linesReturned.length).toBe(400);
    // Verify the range metadata.
    expect((result.details as any)?.startLine).toBe(1);
    expect((result.details as any)?.endLine).toBe(400);
  });
});

describe("config NaN and negative values", () => {
  it("NaN maxRangeReadLines returns an empty range instead of crashing", async () => {
    const cwd = await workspace();
    const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`);
    await writeFile(join(cwd, "nan-range.txt"), lines.join("\n") + "\n", "utf8");
    const tools = await loadTools({ maxRangeReadLines: NaN });

    // slice(0, NaN) yields no lines; the start>end guard is skipped because 1 > NaN is false.
    const result = await tools
      .get("read_anchored")!
      .execute("1", { path: "nan-range.txt", startLine: 1 }, undefined, undefined, { cwd });

    expect(result.details.mode).toBe("range");
    expect((result.details as any)?.lines as any[]).toHaveLength(0);
  });

  it("negative maxRangeReadLines produces an invalid range error", async () => {
    const cwd = await workspace();
    const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`);
    await writeFile(join(cwd, "neg-range.txt"), lines.join("\n") + "\n", "utf8");
    const tools = await loadTools({ maxRangeReadLines: -1 });

    // end = min(100, 1 + (-1) - 1) = -1, so start(1) > end(-1) → invalid range.
    await expect(
      tools
        .get("read_anchored")!
        .execute("1", { path: "neg-range.txt", startLine: 1 }, undefined, undefined, { cwd }),
    ).rejects.toThrow(/Invalid range/);
  });
});

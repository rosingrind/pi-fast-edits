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

describe("auto mode boundary (line-count threshold)", () => {
  it("selects skeleton when lines exceed maxFullReadLines even under the byte cap", async () => {
    const cwd = await workspace();
    // 1501 short lines (~3KB) — over the 1500-line threshold but well under 80KB.
    const lines = Array.from({ length: 1501 }, () => "x");
    await writeFile(join(cwd, "many-short.txt"), lines.join("\n") + "\n", "utf8");
    const tools = await loadTools();

    const result = await tools
      .get("read_anchored")!
      .execute("1", { path: "many-short.txt" }, undefined, undefined, { cwd });

    expect(result.details.mode).toBe("skeleton");
    expect(result.content[0].text).toContain("Mode: skeleton");
  });

  it("stays in full mode at exactly the 1500-line boundary (strict >)", async () => {
    const cwd = await workspace();
    // Exactly 1500 lines is NOT > 1500, so the line threshold must not trigger.
    const lines = Array.from({ length: 1500 }, () => "x");
    await writeFile(join(cwd, "at-limit.txt"), lines.join("\n") + "\n", "utf8");
    const tools = await loadTools();

    const result = await tools
      .get("read_anchored")!
      .execute("1", { path: "at-limit.txt" }, undefined, undefined, { cwd });

    expect(result.details.mode).toBe("full");
    // Full mode renders every line (no truncation), unlike skeleton.
    const text = result.content[0].text as string;
    expect(text).toContain("Lines: 1500");
    expect(text.split("\n").filter((l) => l.includes("§")).length).toBe(1500);
  });

  it("byte threshold takes precedence when a small-line file is huge in bytes", async () => {
    const cwd = await workspace();
    // A single 85KB line: well under the line threshold, but over maxFullReadBytes.
    await writeFile(join(cwd, "huge-line.txt"), "x".repeat(85 * 1024) + "\n", "utf8");
    const tools = await loadTools();

    const result = await tools
      .get("read_anchored")!
      .execute("1", { path: "huge-line.txt" }, undefined, undefined, { cwd });

    expect(result.details.mode).toBe("skeleton");
    expect(result.content[0].text).toContain("Mode: skeleton");
  });
});

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

  it("maxSkeletonItems=0 caps rendering to first matching line only", async () => {
    const cwd = await workspace();
    // Lines that match the "interesting" pattern so skeleton would normally show them.
    const lines = Array.from({ length: 50 }, (_, i) => `function func${i}() { return ${i}; }`);
    await writeFile(join(cwd, "skeleton-zero.txt"), lines.join("\n") + "\n", "utf8");
    const tools = await loadTools({ maxSkeletonItems: 0 });

    const result = await tools
      .get("read_anchored")!
      .execute("1", { path: "skeleton-zero.txt", mode: "skeleton" }, undefined, undefined, { cwd });

    expect(result.details.mode).toBe("skeleton");
    // With maxSkeletonItems=0, the render loop breaks immediately after the first
    // matching line (push happens before the break check), so exactly 1 anchor line.
    const text = result.content[0].text;
    const anchorLines = text.split("\n").filter((line: string) => line.includes("§"));
    expect(anchorLines.length).toBe(1);
  });

  it("maxFullReadLines=0 with full mode still works (full has no line cap)", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "full-zero.txt"), "alpha\nbeta\n", "utf8");
    const tools = await loadTools({ maxFullReadLines: 0 });

    const result = await tools
      .get("read_anchored")!
      .execute("1", { path: "full-zero.txt", mode: "full" }, undefined, undefined, { cwd });

    // Full mode has no line cap — maxFullReadLines only affects auto mode.
    expect(result.details.mode).toBe("full");
    expect(result.content[0].text).toContain("alpha");
    expect(result.content[0].text).toContain("beta");
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
  it("NaN maxFullReadBytes stays in full mode (not skeleton)", async () => {
    const cwd = await workspace();
    // A single line with 100KB of content — well under maxFullReadLines, but far above a
    // real maxFullReadBytes. With a normal maxFullReadBytes this would force skeleton mode;
    // with NaN the byte comparison is always false, so auto mode stays in full.
    const longLine = "x".repeat(100 * 1024);
    await writeFile(join(cwd, "nan-bytes.txt"), longLine + "\n", "utf8");
    const tools = await loadTools({ maxFullReadBytes: NaN as any });

    const result = await tools
      .get("read_anchored")!
      .execute("1", { path: "nan-bytes.txt" }, undefined, undefined, { cwd });

    // byteLength > NaN is always false, so auto mode must not escalate to skeleton.
    expect(result.details.mode).toBe("full");
  });

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

describe("maxSkeletonItems cap", () => {
  it("skeleton returns at most maxSkeletonItems items", async () => {
    const cwd = await workspace();
    // Create a file with many "interesting" lines that would normally all be shown.
    const lines = Array.from({ length: 500 }, (_, i) => `function func${i}() { return ${i}; }`);
    await writeFile(join(cwd, "skeleton-cap.txt"), lines.join("\n") + "\n", "utf8");
    const tools = await loadTools({ maxSkeletonItems: 120 });

    const result = await tools
      .get("read_anchored")!
      .execute("1", { path: "skeleton-cap.txt", mode: "skeleton" }, undefined, undefined, { cwd });

    expect(result.details.mode).toBe("skeleton");
    // The skeleton should have at most maxSkeletonItems (120) anchor-prefixed lines.
    const text = result.content[0].text;
    const anchorLines = text.split("\n").filter((line: string) => line.includes("§"));
    expect(anchorLines.length).toBeLessThanOrEqual(120);
  });
});

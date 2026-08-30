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
  return mkdtemp(join(tmpdir(), "pi-fast-edits-large-"));
}

describe("large file end-to-end (10k+ lines)", () => {
  it("skeleton mode caps the rendered anchors at maxSkeletonItems", async () => {
    const cwd = await workspace();
    // Unique, "interesting" (top-level const) lines so every line qualifies.
    const lines = Array.from({ length: 10_000 }, (_, i) => `const value${i} = ${i};`);
    await writeFile(join(cwd, "big.ts"), lines.join("\n") + "\n", "utf8");
    const tools = await loadTools();

    const result = await tools
      .get("read_anchored")!
      .execute("1", { path: "big.ts", mode: "skeleton" }, undefined, undefined, { cwd });

    const text = result.content[0].text as string;
    expect(text).toContain("Mode: skeleton");
    const rendered = text.split("\n").filter((l) => l.includes("§"));
    // Capped by maxSkeletonItems (120).
    expect(rendered.length).toBe(120);
    // details carries only the skeleton items, not the full file.
    expect((result.details.lines as unknown[]).length).toBe(120);
  });

  it("range mode returns the requested window with correct metadata", async () => {
    const cwd = await workspace();
    const lines = Array.from({ length: 10_000 }, (_, i) => `const value${i} = ${i};`);
    await writeFile(join(cwd, "range.ts"), lines.join("\n") + "\n", "utf8");
    const tools = await loadTools();

    const result = await tools
      .get("read_anchored")!
      .execute(
        "1",
        { path: "range.ts", mode: "range", startLine: 100, endLine: 199 },
        undefined,
        undefined,
        { cwd },
      );

    expect(result.details.mode).toBe("range");
    expect(result.details.startLine).toBe(100);
    expect(result.details.endLine).toBe(199);
    expect((result.details.lines as unknown[]).length).toBe(100);
    const text = result.content[0].text as string;
    expect(text).toContain("Lines: 100-199 of 10000");
  });

  it("full mode returns all 10k anchors, all unique", async () => {
    const cwd = await workspace();
    const lines = Array.from({ length: 10_000 }, (_, i) => `const value${i} = ${i};`);
    await writeFile(join(cwd, "full.ts"), lines.join("\n") + "\n", "utf8");
    const tools = await loadTools();

    const result = await tools
      .get("read_anchored")!
      .execute("1", { path: "full.ts", mode: "full" }, undefined, undefined, { cwd });

    expect(result.details.mode).toBe("full");
    const anchors = (result.details.lines as Array<{ anchor: string }>).map((l) => l.anchor);
    expect(anchors.length).toBe(10_000);
    expect(new Set(anchors).size).toBe(10_000);
    const text = result.content[0].text as string;
    expect(text).toContain("Lines: 10000");
  });
});

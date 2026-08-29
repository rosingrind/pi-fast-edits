import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import piFastEdits from "../src/index.js";

type ToolDef = {
  name: string;
  execute: (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => Promise<any>;
};

async function loadTools(): Promise<Map<string, ToolDef>> {
  const tools = new Map<string, ToolDef>();
  const pi = {
    registerTool(tool: ToolDef) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    on() {},
  };
  await piFastEdits(pi as any);
  return tools;
}

async function workspace() {
  return mkdtemp(join(tmpdir(), "pi-fast-edits-output-"));
}

describe("structured tool output", () => {
  it("single replace returns structured anchorChanges", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "sample.ts"), "one\ntwo\nthree\n", "utf8");
    const tools = await loadTools();

    const read = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "sample.ts" }, undefined, undefined, { cwd });
    const lines = (read.details as any).lines as Array<{ anchor: string; text: string }>;
    const removed = [lines[0].anchor, lines[1].anchor];

    const result = await tools.get("edit_anchored_range")!.execute(
      "2",
      {
        path: "sample.ts",
        startAnchor: lines[0].anchor,
        startAnchorLine: lines[0].text,
        endAnchor: lines[1].anchor,
        endAnchorLine: lines[1].text,
        replacement: "ONE",
      },
      undefined,
      undefined,
      { cwd },
    );

    expect(result.content[0].text).toContain("-1 one");
    expect(result.content[0].text).toContain("+1 ONE");
    expect(result.details.editType).toBe("replace");
    expect(Array.isArray(result.details.anchorChanges.removed)).toBe(true);
    expect(Array.isArray(result.details.anchorChanges.added)).toBe(true);
    expect(Array.isArray(result.details.anchorChanges.preserved)).toBe(true);
    for (const anchor of removed) {
      expect(result.details.anchorChanges.removed).toContain(anchor);
    }
  });

  it("batch edits return per-edit anchor details", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "sample.txt"), "alpha\nbeta\ngamma\n", "utf8");
    const tools = await loadTools();

    const read = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "sample.txt" }, undefined, undefined, { cwd });
    const lines = (read.details as any).lines as Array<{ anchor: string; text: string }>;

    const result = await tools.get("apply_anchored_edits")!.execute(
      "2",
      {
        edits: [
          {
            type: "replace",
            path: "sample.txt",
            startAnchor: lines[0].anchor,
            startAnchorLine: lines[0].text,
            endAnchor: lines[0].anchor,
            endAnchorLine: lines[0].text,
            replacement: "ALPHA",
          },
          {
            type: "replace",
            path: "sample.txt",
            startAnchor: lines[1].anchor,
            startAnchorLine: lines[1].text,
            endAnchor: lines[1].anchor,
            endAnchorLine: lines[1].text,
            replacement: "BETA",
          },
        ],
      },
      undefined,
      undefined,
      { cwd },
    );

    expect(result.content[0].text).toContain("+1 ALPHA");
    expect(result.content[0].text).toContain("+2 BETA");
    expect(result.details).toHaveLength(1);
    expect(result.details[0].edits).toHaveLength(2);
    expect(result.details[0].edits[0].editType).toBe("replace");
    expect(result.details[0].edits[0].anchorChanges.removed).toEqual([lines[0].anchor]);
    expect(result.details[0].edits[1].anchorChanges.removed).toEqual([lines[1].anchor]);
  });

  it("out-of-order edits report correct anchor changes", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "sample.txt"), "alpha\nbeta\ngamma\n", "utf8");
    const tools = await loadTools();

    const read = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "sample.txt" }, undefined, undefined, { cwd });
    const lines = (read.details as any).lines as Array<{ anchor: string; text: string }>;

    const result = await tools.get("apply_anchored_edits")!.execute(
      "2",
      {
        edits: [
          {
            type: "replace",
            path: "sample.txt",
            startAnchor: lines[2].anchor,
            startAnchorLine: lines[2].text,
            endAnchor: lines[2].anchor,
            endAnchorLine: lines[2].text,
            replacement: "GAMMA",
          },
          {
            type: "replace",
            path: "sample.txt",
            startAnchor: lines[0].anchor,
            startAnchorLine: lines[0].text,
            endAnchor: lines[0].anchor,
            endAnchorLine: lines[0].text,
            replacement: "ALPHA",
          },
        ],
      },
      undefined,
      undefined,
      { cwd },
    );

    expect(result.details[0].edits[0].anchorChanges.removed).toEqual([lines[2].anchor]);
    expect(result.details[0].edits[1].anchorChanges.removed).toEqual([lines[0].anchor]);
  });

  it("empty batch returns empty result", async () => {
    const cwd = await workspace();
    const tools = await loadTools();

    const result = await tools
      .get("apply_anchored_edits")!
      .execute("1", { edits: [] }, undefined, undefined, { cwd });

    expect(result.content[0].text).toBe("No edits to apply.");
    expect(result.details).toEqual([]);
  });
});

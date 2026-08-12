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

    const result = await tools.get("edit_anchored_range")!.execute(
      "1",
      {
        path: "sample.ts",
        startAnchor: "Apple",
        endAnchor: "Brave",
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
    expect(result.details.anchorChanges.removed).toContain("Apple");
    expect(result.details.anchorChanges.removed).toContain("Brave");
  });

  it("batch edits return per-edit anchor details", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "sample.txt"), "alpha\nbeta\ngamma\n", "utf8");
    const tools = await loadTools();

    const result = await tools.get("apply_anchored_edits")!.execute(
      "1",
      {
        edits: [
          {
            type: "replace",
            path: "sample.txt",
            startAnchor: "Apple",
            endAnchor: "Apple",
            replacement: "ALPHA",
          },
          {
            type: "replace",
            path: "sample.txt",
            startAnchor: "Brave",
            endAnchor: "Brave",
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
    expect(result.details[0].edits[0].anchorChanges.removed).toEqual(["Apple"]);
    expect(result.details[0].edits[1].anchorChanges.removed).toEqual(["Brave"]);
  });

  it("out-of-order edits report correct anchor changes", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "sample.txt"), "alpha\nbeta\ngamma\n", "utf8");
    const tools = await loadTools();

    const result = await tools.get("apply_anchored_edits")!.execute(
      "1",
      {
        edits: [
          {
            type: "replace",
            path: "sample.txt",
            startAnchor: "Cider",
            endAnchor: "Cider",
            replacement: "GAMMA",
          },
          {
            type: "replace",
            path: "sample.txt",
            startAnchor: "Apple",
            endAnchor: "Apple",
            replacement: "ALPHA",
          },
        ],
      },
      undefined,
      undefined,
      { cwd },
    );

    expect(result.details[0].edits[0].anchorChanges.removed).toEqual(["Cider"]);
    expect(result.details[0].edits[1].anchorChanges.removed).toEqual(["Apple"]);
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

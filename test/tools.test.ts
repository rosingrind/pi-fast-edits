import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import piFastEdits from "../src/index.js";

type ToolDef = {
  name: string;
  execute: (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => Promise<any>;
};

function loadTools(): Map<string, ToolDef> {
  const tools = new Map<string, ToolDef>();
  const pi = {
    registerTool(tool: ToolDef) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    on() {}
  };
  piFastEdits(pi as any);
  return tools;
}

async function workspace() {
  return mkdtemp(join(tmpdir(), "pi-fast-edits-"));
}

describe("anchored tools", () => {
  it("reads anchors and applies an expected-revision guarded replacement", async () => {
    const cwd = await workspace();
    const file = join(cwd, "sample.ts");
    await writeFile(file, "export function run() {\n  return 1;\n}\n", "utf8");
    const tools = loadTools();

    const read = await tools.get("read_anchored_file")!.execute("1", { path: "sample.ts" }, undefined, undefined, { cwd });
    const text = read.content[0].text as string;
    expect(text).toContain("Apple§ export function run()");
    expect(read.details.revision).toMatch(/^[a-f0-9]{16}$/);

    await tools.get("edit_anchored_range")!.execute(
      "2",
      {
        path: "sample.ts",
        startAnchor: "Apple",
        endAnchor: "Cider",
        replacement: "export function run() {\n  return 2;\n}",
        expectedRevision: read.details.revision
      },
      undefined,
      undefined,
      { cwd }
    );

    await expect(readFile(file, "utf8")).resolves.toBe("export function run() {\n  return 2;\n}\n");
  });

  it("rejects stale expected revisions without changing the file", async () => {
    const cwd = await workspace();
    const file = join(cwd, "sample.ts");
    await writeFile(file, "one\ntwo\nthree\n", "utf8");
    const tools = loadTools();

    await expect(
      tools.get("delete_anchor_range")!.execute(
        "1",
        { path: "sample.ts", startAnchor: "Apple", endAnchor: "Apple", expectedRevision: "stale" },
        undefined,
        undefined,
        { cwd }
      )
    ).rejects.toThrow(/Revision mismatch/);

    await expect(readFile(file, "utf8")).resolves.toBe("one\ntwo\nthree\n");
  });

  it("blocks paths outside the workspace", async () => {
    const cwd = await workspace();
    const outside = join(await workspace(), "outside.txt");
    await writeFile(outside, "secret\n", "utf8");
    const tools = loadTools();

    await expect(
      tools.get("read_anchored_file")!.execute("1", { path: outside }, undefined, undefined, { cwd })
    ).rejects.toThrow(/outside workspace/);
  });
});

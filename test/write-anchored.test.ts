import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import piFastEdits from "../src/index.js";
import type { PiFastEditsConfig } from "../src/types.js";

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
    getAllTools() {
      return [];
    },
    getActiveTools() {
      return [];
    },
    setActiveTools() {},
    on() {},
  };
  await piFastEdits(pi as any, overrides);
  return tools;
}

async function workspace() {
  return mkdtemp(join(tmpdir(), "pi-fast-edits-"));
}

async function writeAnchored(
  tools: Map<string, ToolDef>,
  cwd: string,
  path: string,
  content: string,
  toolCallId = "1",
) {
  return tools
    .get("write_anchored")!
    .execute(toolCallId, { path, content }, undefined, undefined, { cwd });
}

describe("write_anchored", () => {
  it("writes a new file and returns revision plus an anchored preview", async () => {
    const cwd = await workspace();
    const tools = await loadTools();

    const result = await writeAnchored(tools, cwd, "hello.txt", "alpha\nbeta\ngamma\n");
    const details = (result as any).details as {
      revision: string;
      lines: Array<{ anchor: string; text: string; lineNo: number }>;
    };

    expect(details.revision).toMatch(/^[a-f0-9]{16}$/);
    expect(details.lines).toHaveLength(3);
    expect(details.lines[0].text).toBe("alpha");
    expect(details.lines[0].lineNo).toBe(1);
    expect(result.content[0].text).toContain("Wrote hello.txt");
    expect(result.content[0].text).toContain(`revision ${details.revision}`);
    expect(result.content[0].text).toContain(`${details.lines[0].anchor}§ alpha`);
    expect(result.content[0].text).toContain("Anchors are ready");
    await expect(readFile(join(cwd, "hello.txt"), "utf8")).resolves.toBe("alpha\nbeta\ngamma\n");
  });

  it("seeds session state so anchored edits work without a prior read", async () => {
    const cwd = await workspace();
    const tools = await loadTools();

    const result = await writeAnchored(tools, cwd, "seed.txt", "one\ntwo\nthree\n");
    const details = (result as any).details as {
      revision: string;
      lines: Array<{ anchor: string; text: string; lineNo: number }>;
    };

    // No read_anchored call: the write itself seeded the session state.
    const edit = await tools.get("apply_anchored")!.execute(
      "2",
      {
        edits: [
          {
            type: "replace",
            path: "seed.txt",
            startAnchor: details.lines[1].anchor,
            startAnchorLine: details.lines[1].text,
            endAnchor: details.lines[1].anchor,
            endAnchorLine: details.lines[1].text,
            replacement: "TWO",
            expectedRevision: details.revision,
          },
        ],
      },
      undefined,
      undefined,
      { cwd },
    );
    expect(edit.content[0].text).toMatch(/^[+-]/m);
    await expect(readFile(join(cwd, "seed.txt"), "utf8")).resolves.toBe("one\nTWO\nthree\n");
  });

  it("rejects protected paths without writing", async () => {
    const cwd = await workspace();
    const tools = await loadTools();

    await expect(
      writeAnchored(tools, cwd, "package-lock.json", '{\n  "lockfileVersion": 3\n}\n'),
    ).rejects.toThrow(/Refusing to write protected path: package-lock.json\./);

    await expect(readFile(join(cwd, "package-lock.json"), "utf8")).rejects.toThrow();
  });

  it("rejects paths outside the workspace", async () => {
    const cwd = await workspace();
    const tools = await loadTools();

    await expect(writeAnchored(tools, cwd, "../x.txt", "secret\n")).rejects.toThrow(
      /outside workspace/,
    );
  });

  it("overwrite replaces content and changes the revision", async () => {
    const cwd = await workspace();
    const tools = await loadTools();

    const first = await writeAnchored(tools, cwd, "over.txt", "first\n");
    const firstRevision = (first as any).details.revision as string;

    const second = await writeAnchored(tools, cwd, "over.txt", "second content\n");
    const secondDetails = (second as any).details as { revision: string };

    expect(secondDetails.revision).not.toBe(firstRevision);
    expect(second.content[0].text).toContain("Wrote over.txt");
    await expect(readFile(join(cwd, "over.txt"), "utf8")).resolves.toBe("second content\n");
  });

  it("result guidance does not name tools deactivated in override mode", async () => {
    const cwd = await workspace();
    const tools = await loadTools();

    const result = await writeAnchored(tools, cwd, "neutral.txt", "hello\n");
    const text = result.content[0].text;

    // The write result is also produced by the override `write` tool, where
    // the suffixed anchored names are deactivated — the guidance must be
    // mode-neutral and not steer the model toward deactivated tools.
    expect(text).toContain("Anchors are ready");
    expect(text).not.toContain("edit_anchored_range");
    expect(text).not.toContain("insert_at_anchor");
    expect(text).not.toContain("read_anchored");
    expect(text).toContain("the anchored edit tools can edit this file now");
  });

  it("strips a leading @ from the path like other tools", async () => {
    const cwd = await workspace();
    const tools = await loadTools();

    const result = await writeAnchored(tools, cwd, "@at-prefixed.txt", "hello\n");
    expect(result.content[0].text).toContain("Wrote at-prefixed.txt");
    await expect(readFile(join(cwd, "at-prefixed.txt"), "utf8")).resolves.toBe("hello\n");
  });
});

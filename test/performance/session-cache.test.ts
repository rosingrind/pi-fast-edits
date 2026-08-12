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
  return mkdtemp(join(tmpdir(), "pi-fast-edits-cache-"));
}

function anchoredLines(text: string): string[] {
  return text.split("\n").filter((l) => l.includes("§"));
}

describe("session cache + anchor stability", () => {
  it("returns byte-for-byte identical anchors on a second read in the same session", async () => {
    const cwd = await workspace();
    const file = join(cwd, "stable.txt");
    await writeFile(file, "alpha\nbeta\ngamma\ndelta\n", "utf8");
    const tools = await loadTools();

    const r1 = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "stable.txt" }, undefined, undefined, { cwd });
    const r2 = await tools
      .get("read_anchored_file")!
      .execute("2", { path: "stable.txt" }, undefined, undefined, { cwd });

    const text1 = r1.content[0].text as string;
    const text2 = r2.content[0].text as string;
    // Same anchors, same order, same rendering.
    expect(text1).toBe(text2);
    expect(anchoredLines(text1)).toEqual(anchoredLines(text2));

    // Same revision hash — the session state was reused, not re-derived.
    expect(r1.details.revision).toBe(r2.details.revision);
    expect(r1.details.revision).toMatch(/^[a-f0-9]{16}$/);
  });

  it("keeps anchors stable across reads when the file is unchanged on disk", async () => {
    const cwd = await workspace();
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);
    await writeFile(join(cwd, "stable-large.txt"), lines.join("\n") + "\n", "utf8");
    const tools = await loadTools();

    const r1 = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "stable-large.txt" }, undefined, undefined, { cwd });
    const r2 = await tools
      .get("read_anchored_file")!
      .execute("2", { path: "stable-large.txt" }, undefined, undefined, { cwd });

    const a1 = (r1.details.lines as Array<{ anchor: string; text: string }>).map((l) => l.anchor);
    const a2 = (r2.details.lines as Array<{ anchor: string; text: string }>).map((l) => l.anchor);
    expect(a1).toEqual(a2);
    // Suffixed anchors past the word pool are also stable across reads.
    expect(new Set(a1).size).toBe(300);
  });
});

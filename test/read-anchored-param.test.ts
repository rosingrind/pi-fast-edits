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
    on() {},
  };
  await piFastEdits(pi as any, overrides);
  return tools;
}

async function workspace() {
  return mkdtemp(join(tmpdir(), "pi-fast-edits-"));
}

describe("read_anchored anchored param", () => {
  it("anchored:false renders plain numbered lines without anchor prefixes or revision header", async () => {
    const cwd = await workspace();
    const file = join(cwd, "plain.txt");
    await writeFile(file, "alpha\nbeta\n", "utf8");
    const tools = await loadTools();
    const read = await tools
      .get("read_anchored")!
      .execute("1", { path: "plain.txt", anchored: false }, undefined, undefined, { cwd });
    const text = read.content[0].text as string;
    expect(text).toContain("1: alpha");
    expect(text).toContain("2: beta");
    expect(text).not.toMatch(/\w+§ /);
    expect(text).not.toContain("Revision:");
    // edit-readiness metadata still present for programmatic consumers
    expect(read.details.revision).toMatch(/^[a-f0-9]+$/);
    expect(read.details.lines).toHaveLength(2);
    expect(read.details.lines[0]).toMatchObject({
      anchor: expect.any(String),
      text: "alpha",
      lineNo: 1,
    });
  });

  it("read_anchored defaults to anchored output", async () => {
    const cwd = await workspace();
    const file = join(cwd, "plain.txt");
    await writeFile(file, "alpha\n", "utf8");
    const tools = await loadTools();
    const read = await tools
      .get("read_anchored")!
      .execute("1", { path: "plain.txt" }, undefined, undefined, { cwd });
    expect(read.content[0].text).toMatch(/\w+§ alpha/);
    expect(read.content[0].text).toContain("Revision:");
  });

  it("anchored:false range mode renders plain numbered lines", async () => {
    const cwd = await workspace();
    const file = join(cwd, "plain-range.txt");
    await writeFile(file, "alpha\nbeta\ngamma\ndelta\n", "utf8");
    const tools = await loadTools();
    const read = await tools
      .get("read_anchored")!
      .execute(
        "1",
        { path: "plain-range.txt", anchored: false, startLine: 2, endLine: 3 },
        undefined,
        undefined,
        { cwd },
      );
    const text = read.content[0].text as string;
    expect(text).toContain("Lines: 2-3 of 4");
    expect(text).toContain("2: beta");
    expect(text).toContain("3: gamma");
    expect(text).not.toContain("1: alpha");
    expect(text).not.toMatch(/\w+§ /);
    expect(text).not.toContain("Revision:");
    expect(read.details.lines).toHaveLength(2);
    expect(read.details.lines[0]).toMatchObject({ text: "beta", lineNo: 2 });
  });

  it("anchored:false full mode renders a plain line list", async () => {
    const cwd = await workspace();
    const file = join(cwd, "plain-skel.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
    const tools = await loadTools();
    const read = await tools
      .get("read_anchored")!
      .execute(
        "1",
        { path: "plain-skel.txt", anchored: false, mode: "full" },
        undefined,
        undefined,
        { cwd },
      );
    const text = read.content[0].text as string;
    expect(text).toContain("Lines: 3");
    expect(text).toContain("1: alpha");
    expect(text).not.toMatch(/\w+§ /);
    expect(text).not.toContain("Revision:");
    expect(text).not.toContain("    lines 1");
    expect(read.details.lines).toHaveLength(3);
  });

  it("anchored:false auto mode renders plain full content for large files", async () => {
    const cwd = await workspace();
    const file = join(cwd, "plain-large.txt");
    // Auto mode on an 85KB file — no skeleton anymore, full mode renders the whole line.
    await writeFile(file, "x".repeat(85 * 1024) + "\n", "utf8");
    const tools = await loadTools();
    const read = await tools
      .get("read_anchored")!
      .execute("1", { path: "plain-large.txt", anchored: false }, undefined, undefined, { cwd });
    const text = read.content[0].text as string;
    expect(read.details.mode).toBe("full");
    expect(text).not.toContain("Mode: skeleton");
    expect(text).not.toMatch(/\w+§ /);
    // The 85KB single line is display-truncated at the 300-char cap.
    expect(text).toMatch(/^1: x+\.\.\.$/m);
    expect(text.length).toBeLessThan(2000);
  });

  it("details from anchored:false read remain usable for anchored edits", async () => {
    const cwd = await workspace();
    const file = join(cwd, "plain-edit.txt");
    await writeFile(file, "alpha\nbeta\n", "utf8");
    const tools = await loadTools();
    const read = await tools
      .get("read_anchored")!
      .execute("1", { path: "plain-edit.txt", anchored: false }, undefined, undefined, { cwd });
    const { revision, lines } = read.details;

    await tools.get("edit_anchored")!.execute(
      "2",
      {
        edits: [
          {
            type: "replace",
            path: "plain-edit.txt",
            startAnchor: lines[0].anchor,
            startAnchorLine: lines[0].text,
            endAnchor: lines[0].anchor,
            endAnchorLine: lines[0].text,
            replacement: "ALPHA",
            expectedRevision: revision,
          },
        ],
      },
      undefined,
      undefined,
      { cwd },
    );

    await expect(readFile(file, "utf8")).resolves.toBe("ALPHA\nbeta\n");
  });
});

import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import piFastEdits from "../src/index.js";
import type { PiFastEditsConfig } from "../src/types.js";
import { anchorOf } from "./anchor-helpers.js";

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

/** Read a file with read_anchored and return its text, revision, and anchored lines. */
async function readAnchored(
  tools: Map<string, ToolDef>,
  cwd: string,
  path: string,
  toolCallId = "1",
) {
  const read = await tools
    .get("read_anchored")!
    .execute(toolCallId, { path }, undefined, undefined, { cwd });
  const details = (read as any).details as {
    revision: string;
    lines: Array<{ anchor: string; text: string }>;
  };
  return { text: read.content[0].text as string, revision: details.revision, lines: details.lines };
}

describe("anchored tools", () => {
  it("reads anchors and applies an expected-revision guarded replacement", async () => {
    const cwd = await workspace();
    const file = join(cwd, "sample.ts");
    await writeFile(file, "export function run() {\n  return 1;\n}\n", "utf8");
    const tools = await loadTools();

    const read = await tools
      .get("read_anchored")!
      .execute("1", { path: "sample.ts" }, undefined, undefined, { cwd });
    const text = read.content[0].text as string;
    expect(text).toContain(`${read.details.lines[0].anchor}§ export function run()`);
    expect(read.details.revision).toMatch(/^[a-f0-9]{16}$/);

    await tools.get("edit_anchored")!.execute(
      "2",
      {
        edits: [
          {
            type: "replace",
            path: "sample.ts",
            startAnchor: read.details.lines[0].anchor,
            startAnchorLine: read.details.lines[0].text,
            endAnchor: read.details.lines[2].anchor,
            endAnchorLine: read.details.lines[2].text,
            replacement: "export function run() {\n  return 2;\n}",
            expectedRevision: read.details.revision,
          },
        ],
      },
      undefined,
      undefined,
      { cwd },
    );

    await expect(readFile(file, "utf8")).resolves.toBe("export function run() {\n  return 2;\n}\n");
  });

  it("a failed stale edit does not poison the next attempt with fresh anchors", async () => {
    // dirac-parity: a rejected edit (file changed underneath) must leave the
    // session able to recover — the next read yields fresh anchors + revision
    // and the same logical edit then succeeds.
    const cwd = await workspace();
    const file = join(cwd, "sample.ts");
    await writeFile(file, "one\ntwo\nthree\n", "utf8");
    const tools = await loadTools();

    const read1 = await tools
      .get("read_anchored")!
      .execute("1", { path: "sample.ts" }, undefined, undefined, { cwd });
    const details1 = read1.details as {
      lines: Array<{ anchor: string; text: string }>;
      revision: string;
    };

    // External modification invalidates everything the model holds.
    await writeFile(file, "one\ntwo changed\nthree\nfour\n", "utf8");

    await expect(
      tools.get("edit_anchored")!.execute(
        "2",
        {
          edits: [
            {
              type: "replace",
              path: "sample.ts",
              startAnchor: details1.lines[1].anchor,
              endAnchor: details1.lines[1].anchor,
              replacement: "two edited",
              startAnchorLine: details1.lines[1].text,
              endAnchorLine: details1.lines[1].text,
              expectedRevision: details1.revision,
            },
          ],
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(/Revision mismatch/);

    // Recovery: re-read gives a fresh mapping and the edit goes through.
    const read2 = await tools
      .get("read_anchored")!
      .execute("3", { path: "sample.ts" }, undefined, undefined, { cwd });
    const details2 = read2.details as {
      lines: Array<{ anchor: string; text: string }>;
      revision: string;
    };
    const target = details2.lines.find((l) => l.text === "two changed")!;
    await tools.get("edit_anchored")!.execute(
      "4",
      {
        edits: [
          {
            type: "replace",
            path: "sample.ts",
            startAnchor: target.anchor,
            endAnchor: target.anchor,
            replacement: "two edited",
            startAnchorLine: target.text,
            endAnchorLine: target.text,
            expectedRevision: details2.revision,
          },
        ],
      },
      undefined,
      undefined,
      { cwd },
    );
    await expect(readFile(file, "utf8")).resolves.toBe("one\ntwo edited\nthree\nfour\n");
  });

  it("applies same-file batch edits even when paths use different spellings", async () => {
    const cwd = await workspace();
    const file = join(cwd, "sample.txt");
    await writeFile(file, "alpha\nbeta\ngamma\ndelta\n", "utf8");
    const tools = await loadTools();

    const { lines } = await readAnchored(tools, cwd, "sample.txt");

    await tools.get("edit_anchored")!.execute(
      "1",
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
            path: "./sample.txt",
            startAnchor: lines[2].anchor,
            startAnchorLine: lines[2].text,
            endAnchor: lines[2].anchor,
            endAnchorLine: lines[2].text,
            replacement: "GAMMA",
          },
        ],
      },
      undefined,
      undefined,
      { cwd },
    );

    await expect(readFile(file, "utf8")).resolves.toBe("ALPHA\nbeta\nGAMMA\ndelta\n");
  });

  it("blocks paths outside the workspace", async () => {
    const cwd = await workspace();
    const outside = join(await workspace(), "outside.txt");
    await writeFile(outside, "secret\n", "utf8");
    const tools = await loadTools();

    await expect(
      tools.get("read_anchored")!.execute("1", { path: outside }, undefined, undefined, { cwd }),
    ).rejects.toThrow(/outside workspace/);
  });

  it("teaches the skill-dirs escape on outside-workspace reads", async () => {
    const cwd = await workspace();
    const outside = join(await workspace(), "outside.txt");
    await writeFile(outside, "secret\n", "utf8");
    const tools = await loadTools();

    await expect(
      tools.get("read_anchored")!.execute("1", { path: outside }, undefined, undefined, { cwd }),
    ).rejects.toThrow(
      /Outside-workspace reads are limited to loaded skill directories and pi's docs/,
    );
  });
  it("rejects likely binary files", async () => {
    const cwd = await workspace();
    const file = join(cwd, "binary.dat");
    await writeFile(file, Buffer.from([0, 1, 2, 3]));
    const tools = await loadTools();

    await expect(
      tools
        .get("read_anchored")!
        .execute("1", { path: "binary.dat" }, undefined, undefined, { cwd }),
    ).rejects.toThrow(/binary file/);
  });

  it("auto mode returns full content for large files (skeleton removed)", async () => {
    const cwd = await workspace();
    const file = join(cwd, "large-bytes.txt");
    // Auto mode on an 85KB file — no skeleton anymore, full mode returns it all.
    const content = "x".repeat(85 * 1024) + "\n";
    await writeFile(file, content, "utf8");
    const tools = await loadTools();
    const result = await tools
      .get("read_anchored")!
      .execute("1", { path: "large-bytes.txt" }, undefined, undefined, { cwd });
    expect(result.details.mode).toBe("full");
    const text = result.content[0].text as string;
    expect(text).toContain("Lines: 1");
    expect(text).not.toContain("Mode: skeleton");
  });

  it("read_anchored range mode with clamping", async () => {
    const cwd = await workspace();
    const file = join(cwd, "sample.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
    const tools = await loadTools();

    const result = await tools
      .get("read_anchored")!
      .execute("1", { path: "sample.txt", startLine: 1, endLine: 2 }, undefined, undefined, {
        cwd,
      });

    const text = result.content[0].text as string;
    expect(text).toContain("Lines: 1-2");
    expect(text).toContain(`${anchorOf(text, "alpha")}§ alpha`);
    expect(text).toContain(`${anchorOf(text, "beta")}§ beta`);
  });

  it("applies mixed insert, delete, and replace edits", async () => {
    const cwd = await workspace();
    const file = join(cwd, "sample.txt");
    await writeFile(file, "alpha\nbeta\ngamma\ndelta\n", "utf8");
    const tools = await loadTools();

    const { lines } = await readAnchored(tools, cwd, "sample.txt");

    await tools.get("edit_anchored")!.execute(
      "1",
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
            type: "insert",
            path: "sample.txt",
            anchor: lines[3].anchor,
            anchorLine: lines[3].text,
            position: "before",
            content: "NEW_LINE",
          },
          {
            type: "delete",
            path: "sample.txt",
            startAnchor: lines[1].anchor,
            startAnchorLine: lines[1].text,
            endAnchor: lines[2].anchor,
            endAnchorLine: lines[2].text,
          },
        ],
      },
      undefined,
      undefined,
      { cwd },
    );

    await expect(readFile(file, "utf8")).resolves.toBe("ALPHA\nNEW_LINE\ndelta\n");
  });

  it("handles files with more lines than anchor words (suffixing)", async () => {
    const cwd = await workspace();
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`);
    const file = join(cwd, "large.txt");
    await writeFile(file, lines.join("\n") + "\n", "utf8");
    const tools = await loadTools();

    const result = await tools
      .get("read_anchored")!
      .execute("1", { path: "large.txt" }, undefined, undefined, { cwd });

    const text = result.content[0].text as string;
    expect(text).toContain(`${anchorOf(text, "line 1")}§ line 1`);
    expect(text).toContain(`${anchorOf(text, "line 201")}§ line 201`);
  });

  it("rejects overlapping edits in edit_anchored", async () => {
    const cwd = await workspace();
    const file = join(cwd, "sample.txt");
    await writeFile(file, "alpha\nbeta\ngamma\ndelta\n", "utf8");
    const tools = await loadTools();

    const { lines } = await readAnchored(tools, cwd, "sample.txt");

    await expect(
      tools.get("edit_anchored")!.execute(
        "1",
        {
          edits: [
            {
              type: "replace",
              path: "sample.txt",
              startAnchor: lines[0].anchor,
              startAnchorLine: lines[0].text,
              endAnchor: lines[2].anchor,
              endAnchorLine: lines[2].text,
              replacement: "X",
            },
            {
              type: "replace",
              path: "sample.txt",
              startAnchor: lines[1].anchor,
              startAnchorLine: lines[1].text,
              endAnchor: lines[3].anchor,
              endAnchorLine: lines[3].text,
              replacement: "Y",
            },
          ],
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(/Overlapping/);

    await expect(readFile(file, "utf8")).resolves.toBe("alpha\nbeta\ngamma\ndelta\n");
  });

  it("detects overlapping insert and replace regardless of order", async () => {
    const cwd = await workspace();
    const file = join(cwd, "overlap.txt");
    await writeFile(file, "INS\nREP\nother\n", "utf8");
    const tools = await loadTools();

    // Read to get the revision hash
    const readResult = await tools
      .get("read_anchored")!
      .execute("1", { path: "overlap.txt" }, undefined, undefined, { cwd });
    const revision = (readResult.details as any)?.revision;
    const lines = (readResult.details as any)?.lines as any[];

    // Anchored lines: 0 = INS, 1 = REP
    // Insert before INS + replace INS..REP
    // Order: insert first
    await expect(
      tools.get("edit_anchored")!.execute(
        "2",
        {
          edits: [
            {
              type: "insert" as const,
              path: "overlap.txt",
              anchor: lines[0].anchor,
              anchorLine: lines[0].text,
              position: "before",
              content: "NEW\n",
              expectedRevision: revision,
            },
            {
              type: "replace" as const,
              path: "overlap.txt",
              startAnchor: lines[0].anchor,
              startAnchorLine: lines[0].text,
              endAnchor: lines[1].anchor,
              endAnchorLine: lines[1].text,
              replacement: "REPLACED\n",
              expectedRevision: revision,
            },
          ],
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow("Overlapping edits");

    // Same edits in reverse order
    await expect(
      tools.get("edit_anchored")!.execute(
        "3",
        {
          edits: [
            {
              type: "replace" as const,
              path: "overlap.txt",
              startAnchor: lines[0].anchor,
              startAnchorLine: lines[0].text,
              endAnchor: lines[1].anchor,
              endAnchorLine: lines[1].text,
              replacement: "REPLACED\n",
              expectedRevision: revision,
            },
            {
              type: "insert" as const,
              path: "overlap.txt",
              anchor: lines[0].anchor,
              anchorLine: lines[0].text,
              position: "before",
              content: "NEW\n",
              expectedRevision: revision,
            },
          ],
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow("Overlapping edits");
  });

  it("applies edits across multiple files", async () => {
    const cwd = await workspace();
    const file1 = join(cwd, "a.txt");
    const file2 = join(cwd, "b.txt");
    await writeFile(file1, "alpha\nbeta\n", "utf8");
    await writeFile(file2, "gamma\ndelta\n", "utf8");
    const tools = await loadTools();

    const { lines: linesA } = await readAnchored(tools, cwd, "a.txt");
    const { lines: linesB } = await readAnchored(tools, cwd, "b.txt", "2");

    await tools.get("edit_anchored")!.execute(
      "1",
      {
        edits: [
          {
            type: "replace",
            path: "a.txt",
            startAnchor: linesA[0].anchor,
            startAnchorLine: linesA[0].text,
            endAnchor: linesA[0].anchor,
            endAnchorLine: linesA[0].text,
            replacement: "ALPHA",
          },
          {
            type: "replace",
            path: "b.txt",
            startAnchor: linesB[0].anchor,
            startAnchorLine: linesB[0].text,
            endAnchor: linesB[0].anchor,
            endAnchorLine: linesB[0].text,
            replacement: "GAMMA_NEW",
          },
        ],
      },
      undefined,
      undefined,
      { cwd },
    );

    await expect(readFile(file1, "utf8")).resolves.toBe("ALPHA\nbeta\n");
    await expect(readFile(file2, "utf8")).resolves.toBe("GAMMA_NEW\ndelta\n");
  });

  it("applies batch edits using anchor line args", async () => {
    const cwd = await workspace();
    const file = join(cwd, "sample.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
    const tools = await loadTools();

    const { lines } = await readAnchored(tools, cwd, "sample.txt");

    await tools.get("edit_anchored")!.execute(
      "1",
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
            type: "insert",
            path: "sample.txt",
            anchor: lines[1].anchor,
            anchorLine: lines[1].text,
            position: "before",
            content: "INSERTED",
          },
          {
            type: "delete",
            path: "sample.txt",
            startAnchor: lines[2].anchor,
            startAnchorLine: lines[2].text,
            endAnchor: lines[2].anchor,
            endAnchorLine: lines[2].text,
          },
        ],
      },
      undefined,
      undefined,
      { cwd },
    );

    await expect(readFile(file, "utf8")).resolves.toBe("ALPHA\nINSERTED\nbeta\n");
  });

  it("caps the batch result text at 100KB and notes that all edits were applied", async () => {
    const cwd = await workspace();
    // 350 lines x ~110 chars ≈ 40KB per file: the full read's 50KB budget
    // keeps every line in details, while the two whole-file diffs (~83KB
    // each) combine past the 100KB result cap.
    const big = (n: number) =>
      Array.from({ length: n }, (_, i) => `orig-${i}: ${"x".repeat(100)}`).join("\n");
    const fresh = (n: number) =>
      Array.from({ length: n }, (_, i) => `new-${i}: ${"y".repeat(100)}`).join("\n");
    await writeFile(join(cwd, "a.txt"), big(350), "utf8");
    await writeFile(join(cwd, "b.txt"), big(350), "utf8");
    const tools = await loadTools();
    const a = await readAnchored(tools, cwd, "a.txt");
    const b = await readAnchored(tools, cwd, "b.txt");

    const linesOf = (
      lines: Array<{ anchor: string; text: string }>,
      first: string,
      last: string,
    ) => {
      const firstLine = lines.find((l) => l.text.startsWith(first))!;
      const lastLine = lines.find((l) => l.text.startsWith(last))!;
      return { firstLine, lastLine };
    };
    const aLines = linesOf(a.lines, "orig-0", "orig-349");
    const bLines = linesOf(b.lines, "orig-0", "orig-349");

    const result = await tools.get("edit_anchored")!.execute(
      "1",
      {
        edits: [
          {
            type: "replace",
            path: "a.txt",
            startAnchor: aLines.firstLine.anchor,
            startAnchorLine: aLines.firstLine.text,
            endAnchor: aLines.lastLine.anchor,
            endAnchorLine: aLines.lastLine.text,
            replacement: fresh(600),
          },
          {
            type: "replace",
            path: "b.txt",
            startAnchor: bLines.firstLine.anchor,
            startAnchorLine: bLines.firstLine.text,
            endAnchor: bLines.lastLine.anchor,
            endAnchorLine: bLines.lastLine.text,
            replacement: fresh(600),
          },
        ],
      },
      undefined,
      undefined,
      { cwd },
    );

    const text = result.content[0].text as string;
    expect(text).toContain("result truncated at 100KB");
    expect(text).toContain("all edits were applied");
    expect(text.length).toBeLessThan(110_000);
    // Every edit really was applied, capped text notwithstanding.
    const aAfter = await readFile(join(cwd, "a.txt"), "utf8");
    const bAfter = await readFile(join(cwd, "b.txt"), "utf8");
    expect(aAfter).toContain("new-0:");
    expect(bAfter).toContain("new-349:");
  });

  it("inserts between adjacent lines with zero-width replace (both anchors excluded)", async () => {
    const cwd = await workspace();
    const file = join(cwd, "sample.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
    const tools = await loadTools();
    const { lines } = await readAnchored(tools, cwd, "sample.txt");

    await tools.get("edit_anchored")!.execute(
      "1",
      {
        edits: [
          {
            type: "replace",
            path: "sample.txt",
            startAnchor: lines[0].anchor,
            startAnchorLine: lines[0].text,
            endAnchor: lines[1].anchor,
            endAnchorLine: lines[1].text,
            includeStart: false,
            includeEnd: false,
            replacement: "INSERTED",
          },
        ],
      },
      undefined,
      undefined,
      { cwd },
    );

    await expect(readFile(file, "utf8")).resolves.toBe("alpha\nINSERTED\nbeta\ngamma\n");
  });
});

describe("error paths", () => {
  it("rejects a non-existent file", async () => {
    const cwd = await workspace();
    const tools = await loadTools();
    await expect(
      tools
        .get("read_anchored")!
        .execute("1", { path: "nonexistent.txt" }, undefined, undefined, { cwd }),
    ).rejects.toThrow(/ENOENT|no such file/i);
  });

  it("rejects a directory path", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, "subdir"), { recursive: true });
    const tools = await loadTools();
    await expect(
      tools.get("read_anchored")!.execute("1", { path: "subdir" }, undefined, undefined, { cwd }),
    ).rejects.toThrow(/not a regular file/);
  });

  it("rejects a broken symlink", async () => {
    const cwd = await workspace();
    await symlink("/nonexistent/path", join(cwd, "broken-link.txt"));
    const tools = await loadTools();
    await expect(
      tools
        .get("read_anchored")!
        .execute("1", { path: "broken-link.txt" }, undefined, undefined, { cwd }),
    ).rejects.toThrow();
  });

  it("edit_anchored rejects batch with invalid anchor", async () => {
    const cwd = await workspace();
    const file = join(cwd, "batch-invalid.txt");
    await writeFile(file, "alpha\nbeta\n", "utf8");
    const tools = await loadTools();
    await expect(
      tools.get("edit_anchored")!.execute(
        "1",
        {
          edits: [
            {
              type: "replace" as const,
              path: "batch-invalid.txt",
              startAnchor: "NonExistent",
              endAnchor: "NonExistent",
              replacement: "X",
            },
          ],
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(/Could not find start anchor/);
  });

  it("rejects binary content after 8KB sample window", async () => {
    const cwd = await workspace();
    const file = join(cwd, "binary-late.txt");
    // Valid ASCII for 8KB, then invalid UTF-8 bytes
    const valid = "x".repeat(8192);
    const invalid = Buffer.from([0xff, 0xfe]); // invalid UTF-8
    await writeFile(file, valid + invalid.toString("utf8"), "utf8");
    const tools = await loadTools();
    await expect(
      tools
        .get("read_anchored")!
        .execute("1", { path: "binary-late.txt" }, undefined, undefined, { cwd }),
    ).rejects.toThrow("binary");
  });

  it("two edits to empty file rejected as overlapping", async () => {
    const cwd = await workspace();
    const file = join(cwd, "double-empty.txt");
    await writeFile(file, "", "utf8");
    const tools = await loadTools();

    await expect(
      tools.get("edit_anchored")!.execute(
        "1",
        {
          edits: [
            {
              type: "replace" as const,
              path: "double-empty.txt",
              startAnchor: "first",
              endAnchor: "first",
              replacement: "line1\n",
            },
            {
              type: "replace" as const,
              path: "double-empty.txt",
              startAnchor: "second",
              endAnchor: "second",
              replacement: "line2\n",
            },
          ],
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow("Overlapping edits");
  });

  it("batch confirmation on protected path without UI cancels", async () => {
    const cwd = await workspace();
    const file = join(cwd, ".env");
    await writeFile(file, "SECRET=1\n", "utf8");
    const tools = await loadTools();
    const readResult = await tools
      .get("read_anchored")!
      .execute("1", { path: ".env" }, undefined, undefined, { cwd });
    const revision = (readResult.details as any)?.revision;

    // Default config (confirmation: "protected-paths") on a protected path with
    // no confirmation UI available cancels the whole batch without writing.
    const result = await tools.get("edit_anchored")!.execute(
      "2",
      {
        edits: [
          {
            type: "replace" as const,
            path: ".env",
            startAnchor: (readResult.details as any)?.lines[0].anchor,
            startAnchorLine: (readResult.details as any)?.lines[0].text,
            endAnchor: (readResult.details as any)?.lines[0].anchor,
            endAnchorLine: (readResult.details as any)?.lines[0].text,
            replacement: "SECRET=2\n",
            expectedRevision: revision,
          },
        ],
      },
      undefined,
      undefined,
      { cwd },
    );

    expect(result.content[0].text).toContain("Edit cancelled");
    const content = await readFile(file, "utf8");
    expect(content).toBe("SECRET=1\n");
  });

  it("batch confirmation cancelled via UI returns the exact cancellation text", async () => {
    const cwd = await workspace();
    const file = join(cwd, "cancel-ui.txt");
    await writeFile(file, "alpha\n", "utf8");
    const tools = await loadTools({ confirmation: "always" });
    const readResult = await tools
      .get("read_anchored")!
      .execute("1", { path: "cancel-ui.txt" }, undefined, undefined, { cwd });
    const revision = (readResult.details as any)?.revision;

    // A confirmation UI that declines must cancel the batch without writing and
    // return the exact cancellation message (pinned for the renderer contract).
    const confirm = vi.fn(async () => false);
    const result = await tools.get("edit_anchored")!.execute(
      "2",
      {
        edits: [
          {
            type: "replace" as const,
            path: "cancel-ui.txt",
            startAnchor: (readResult.details as any)?.lines[0].anchor,
            startAnchorLine: (readResult.details as any)?.lines[0].text,
            endAnchor: (readResult.details as any)?.lines[0].anchor,
            endAnchorLine: (readResult.details as any)?.lines[0].text,
            replacement: "beta\n",
            expectedRevision: revision,
          },
        ],
      },
      undefined,
      undefined,
      { cwd, ui: { confirm } },
    );

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toBe("Edit cancelled. No files were changed.");
    const content = await readFile(file, "utf8");
    expect(content).toBe("alpha\n");
  });

  it("single insert into empty file in batch succeeds", async () => {
    const cwd = await workspace();
    const file = join(cwd, "batch-empty.txt");
    await writeFile(file, "", "utf8");
    const tools = await loadTools();

    const result = await tools.get("edit_anchored")!.execute(
      "1",
      {
        edits: [
          {
            type: "insert" as const,
            path: "batch-empty.txt",
            anchor: "first",
            position: "before",
            content: "hello\n",
          },
        ],
      },
      undefined,
      undefined,
      { cwd },
    );

    expect(result.content[0].text).toMatch(/^[+-]/m);
    const content = await readFile(file, "utf8");
    expect(content).toBe("hello\n");
  });

  it("edit_anchored rejects a mismatched anchorLine before writing", async () => {
    const cwd = await workspace();
    const file = join(cwd, "batch-coord.txt");
    await writeFile(file, "alpha\nbeta\n", "utf8");
    const tools = await loadTools();

    const { lines } = await readAnchored(tools, cwd, "batch-coord.txt");

    await expect(
      tools.get("edit_anchored")!.execute(
        "1",
        {
          edits: [
            {
              type: "replace" as const,
              path: "batch-coord.txt",
              startAnchor: lines[0].anchor,
              startAnchorLine: lines[0].text,
              endAnchor: lines[0].anchor,
              endAnchorLine: lines[0].text,
              replacement: "ALPHA",
            },
            {
              type: "replace" as const,
              path: "batch-coord.txt",
              startAnchor: lines[1].anchor,
              startAnchorLine: "wrong text",
              endAnchor: lines[1].anchor,
              endAnchorLine: "wrong text",
              replacement: "BETA",
            },
          ],
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(/startAnchorLine mismatch/);

    // The batch must not write anything when an anchor line mismatches.
    await expect(readFile(file, "utf8")).resolves.toBe("alpha\nbeta\n");
  });
});

describe("edge cases", () => {
  it("anchors whitespace-only lines", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "whitespace.txt"), "   \n  \n\n", "utf8");
    const tools = await loadTools();
    const result = await tools
      .get("read_anchored")!
      .execute("1", { path: "whitespace.txt" }, undefined, undefined, { cwd });
    const text = result.content[0].text as string;
    const anchored = text.split("\n").filter((l) => l.includes("§"));
    expect(anchored).toHaveLength(3);
  });

  it("handles unicode content correctly", async () => {
    const cwd = await workspace();
    const file = join(cwd, "unicode.txt");
    await writeFile(file, "café\nnaïve\n日本語\n", "utf8");
    const tools = await loadTools();
    const read = await tools
      .get("read_anchored")!
      .execute("1", { path: "unicode.txt" }, undefined, undefined, { cwd });
    const text = read.content[0].text as string;
    const anchored = text.split("\n").filter((l) => l.includes("§"));
    expect(anchored).toHaveLength(3);

    const revision = (read as any).details.revision as string;
    const lines = (read as any).details.lines as any[];
    const result = await tools.get("edit_anchored")!.execute(
      "1",
      {
        edits: [
          {
            type: "replace",
            path: "unicode.txt",
            startAnchor: lines[0].anchor,
            startAnchorLine: lines[0].text,
            endAnchor: lines[0].anchor,
            endAnchorLine: lines[0].text,
            replacement: "café",
            expectedRevision: revision,
          },
        ],
      },
      undefined,
      undefined,
      { cwd },
    );
    // Replacing a line with identical content yields no diff.
    expect(result.content[0].text).toContain("No changes");
  });
});

describe("integration chains", () => {
  it("read → edit → read reconciles anchors", async () => {
    const cwd = await workspace();
    const file = join(cwd, "chain.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
    const tools = await loadTools();

    const r1 = await tools
      .get("read_anchored")!
      .execute("1", { path: "chain.txt" }, undefined, undefined, { cwd });
    const revision = (r1 as any).details.revision as string;
    const lines = (r1 as any).details.lines as any[];

    // Remove the middle line (beta).
    await tools.get("edit_anchored")!.execute(
      "1",
      {
        edits: [
          {
            type: "replace",
            path: "chain.txt",
            startAnchor: lines[1].anchor,
            startAnchorLine: lines[1].text,
            endAnchor: lines[1].anchor,
            endAnchorLine: lines[1].text,
            replacement: "",
            expectedRevision: revision,
          },
        ],
      },
      undefined,
      undefined,
      { cwd },
    );

    const r2 = await tools
      .get("read_anchored")!
      .execute("2", { path: "chain.txt" }, undefined, undefined, { cwd });
    const text = r2.content[0].text as string;
    const anchored = text.split("\n").filter((l) => l.includes("§"));
    expect(anchored).toHaveLength(2);
    expect(text).not.toContain("beta");
  });

  it("rejects a revision reused across a chain", async () => {
    const cwd = await workspace();
    const file = join(cwd, "chain2.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
    const tools = await loadTools();

    const r1 = await tools
      .get("read_anchored")!
      .execute("1", { path: "chain2.txt" }, undefined, undefined, { cwd });
    const revision = (r1 as any).details.revision as string;
    const lines = (r1 as any).details.lines as any[];

    await tools.get("edit_anchored")!.execute(
      "1",
      {
        edits: [
          {
            type: "replace",
            path: "chain2.txt",
            startAnchor: lines[0].anchor,
            startAnchorLine: lines[0].text,
            endAnchor: lines[0].anchor,
            endAnchorLine: lines[0].text,
            replacement: "X",
            expectedRevision: revision,
          },
        ],
      },
      undefined,
      undefined,
      { cwd },
    );

    // Reusing the same (now stale) revision must fail.
    await expect(
      tools.get("edit_anchored")!.execute(
        "2",
        {
          edits: [
            {
              type: "replace",
              path: "chain2.txt",
              startAnchor: lines[2].anchor,
              startAnchorLine: lines[2].text,
              endAnchor: lines[2].anchor,
              endAnchorLine: lines[2].text,
              replacement: "Y",
              expectedRevision: revision,
            },
          ],
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(/Revision mismatch/);
  });

  it("applies sequential edits with refreshed revisions", async () => {
    const cwd = await workspace();
    const file = join(cwd, "seq.txt");
    await writeFile(file, "a\nb\nc\n", "utf8");
    const tools = await loadTools();

    let r = await tools
      .get("read_anchored")!
      .execute("1", { path: "seq.txt" }, undefined, undefined, { cwd });
    const lines0 = (r as any).details.lines as any[];
    await tools.get("edit_anchored")!.execute(
      "1",
      {
        edits: [
          {
            type: "replace",
            path: "seq.txt",
            startAnchor: lines0[0].anchor,
            startAnchorLine: lines0[0].text,
            endAnchor: lines0[0].anchor,
            endAnchorLine: lines0[0].text,
            replacement: "A",
            expectedRevision: (r as any).details.revision,
          },
        ],
      },
      undefined,
      undefined,
      { cwd },
    );

    // Re-read to obtain a fresh revision for the next edit.
    r = await tools
      .get("read_anchored")!
      .execute("2", { path: "seq.txt" }, undefined, undefined, { cwd });
    const lines1 = (r as any).details.lines as any[];
    await tools.get("edit_anchored")!.execute(
      "2",
      {
        edits: [
          {
            type: "replace",
            path: "seq.txt",
            startAnchor: lines1[2].anchor,
            startAnchorLine: lines1[2].text,
            endAnchor: lines1[2].anchor,
            endAnchorLine: lines1[2].text,
            replacement: "C",
            expectedRevision: (r as any).details.revision,
          },
        ],
      },
      undefined,
      undefined,
      { cwd },
    );

    await expect(readFile(file, "utf8")).resolves.toBe("A\nb\nC\n");
  });

  it("insert-after adjacent to delete is (conservatively) rejected as overlapping", async () => {
    const cwd = await workspace();
    const file = join(cwd, "adjacent.txt");
    await writeFile(file, "a\nb\nc\n", "utf8");
    const tools = await loadTools();

    const readResult = await tools
      .get("read_anchored")!
      .execute("1", { path: "adjacent.txt" }, undefined, undefined, { cwd });
    const lines = (readResult.details as any)?.lines as any[];
    const revision = (readResult.details as any)?.revision;

    // Insert after "a" + delete "b" — these are adjacent, not truly conflicting,
    // but the current overlap detector treats them as overlapping.
    await expect(
      tools.get("edit_anchored")!.execute(
        "2",
        {
          edits: [
            {
              type: "insert" as const,
              path: "adjacent.txt",
              anchor: lines[0].anchor, // Apple (line 1, "a")
              anchorLine: lines[0].text,
              position: "after",
              content: "B\n",
              expectedRevision: revision,
            },
            {
              type: "delete" as const,
              path: "adjacent.txt",
              startAnchor: lines[1].anchor, // Brave (line 2, "b")
              startAnchorLine: lines[1].text,
              endAnchor: lines[1].anchor,
              endAnchorLine: lines[1].text,
              expectedRevision: revision,
            },
          ],
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow("Overlapping edits");
    // This documents the current (conservative) overlap behavior for insert
    // positioning that touches the same line as a delete.
  });
});

describe("batch integrity", () => {
  it("batch with stale revision aborts ALL writes", async () => {
    const cwd = await workspace();
    const fileA = join(cwd, "batch-a.txt");
    const fileB = join(cwd, "batch-b.txt");
    await writeFile(fileA, "alpha\n", "utf8");
    await writeFile(fileB, "beta\n", "utf8");
    const tools = await loadTools();

    const rA = await tools
      .get("read_anchored")!
      .execute("1", { path: "batch-a.txt" }, undefined, undefined, { cwd });
    const rB = await tools
      .get("read_anchored")!
      .execute("2", { path: "batch-b.txt" }, undefined, undefined, { cwd });
    const revA = (rA as any).details?.revision;
    const revB = (rB as any).details?.revision;
    const linesA = (rA as any).details?.lines as any[];
    const linesB = (rB as any).details?.lines as any[];

    // Stale the revision of file B by writing to it directly.
    await writeFile(fileB, "beta-changed\n", "utf8");

    await expect(
      tools.get("edit_anchored")!.execute(
        "3",
        {
          edits: [
            {
              type: "replace" as const,
              path: "batch-a.txt",
              startAnchor: linesA[0].anchor,
              startAnchorLine: linesA[0].text,
              endAnchor: linesA[0].anchor,
              endAnchorLine: linesA[0].text,
              replacement: "ALPHA\n",
              expectedRevision: revA,
            },
            {
              type: "replace" as const,
              path: "batch-b.txt",
              startAnchor: linesB[0].anchor,
              startAnchorLine: linesB[0].text,
              endAnchor: linesB[0].anchor,
              endAnchorLine: linesB[0].text,
              replacement: "BETA\n",
              expectedRevision: revB, // stale
            },
          ],
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow("Revision mismatch");

    // File A must be unchanged — the whole batch is all-or-nothing.
    await expect(readFile(fileA, "utf8")).resolves.toBe("alpha\n");
  });
});

describe("override", () => {
  it("falls back to interception with a warning when the safety check fails", async () => {
    let toolCallHandler:
      | ((
          event: { toolName?: string },
          ctx: unknown,
        ) => Promise<{ block?: boolean; reason?: string } | undefined> | undefined)
      | undefined;
    let sessionStartHandler:
      ((event?: unknown, ctx?: any) => Promise<unknown> | undefined) | undefined;
    const notifications: Array<{ message: string; type?: string }> = [];
    const pi = {
      registerTool() {},
      registerCommand() {},
      // Built-in write is missing parameters.properties.content, so the
      // override fingerprint fails and interception installs as fallback.
      getAllTools: () => [
        { name: "read", parameters: { properties: { path: {} } } },
        { name: "edit", parameters: { properties: { edits: {} } } },
        { name: "write", parameters: { properties: { path: {} } } },
        { name: "grep", parameters: { properties: { pattern: {} } } },
      ],
      getActiveTools: () => [],
      setActiveTools() {},
      on(event: string, handler: any) {
        if (event === "tool_call") toolCallHandler = handler;
        if (event === "session_start") sessionStartHandler = handler;
      },
    };
    await piFastEdits(pi as any, { overrideBuiltInEditTools: true });
    await sessionStartHandler!(
      {},
      {
        ui: {
          notify: (message: string, type?: string) => notifications.push({ message, type }),
        },
      },
    );

    expect(toolCallHandler).toBeDefined();
    const write = await toolCallHandler!({ toolName: "write" }, {});
    expect(write?.block).toBe(true);
    expect(write?.reason).toContain("pi-fast-edits override");

    const edit = await toolCallHandler!({ toolName: "edit" }, {});
    expect(edit?.block).toBe(true);

    const read = await toolCallHandler!({ toolName: "read_anchored" }, {});
    expect(read).toBeUndefined();

    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe("warning");
  });

  it("disabled (default): restores the suffixed tools, installs nothing else", async () => {
    let toolCallHandler:
      ((event: { toolName?: string }, ctx: unknown) => Promise<unknown> | undefined) | undefined;
    const pi = {
      registerTool() {},
      registerCommand() {},
      getAllTools: () => [],
      getActiveTools: () => [],
      setActiveTools() {},
      on(event: string, handler: typeof toolCallHandler) {
        if (event === "tool_call") toolCallHandler = handler;
      },
    };
    await piFastEdits(pi as any);
    expect(toolCallHandler).toBeUndefined();
  });
});

describe("anchored read range modes", () => {
  it("range mode rejects start > end", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "range-edge.txt"), "a\nb\nc\n", "utf8");
    const tools = await loadTools();
    await expect(
      tools
        .get("read_anchored")!
        .execute("1", { path: "range-edge.txt", startLine: 5, endLine: 2 }, undefined, undefined, {
          cwd,
        }),
    ).rejects.toThrow(/Invalid range/);
  });

  it("range mode with startLine only uses a default end", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "range-start.txt"), "a\nb\nc\nd\ne\n", "utf8");
    const tools = await loadTools();
    const result = await tools
      .get("read_anchored")!
      .execute("1", { path: "range-start.txt", startLine: 2 }, undefined, undefined, { cwd });
    const text = result.content[0].text as string;
    expect(text).toContain("Lines: 2-5 of 5");
    expect(text).toContain(`${anchorOf(text, "b")}§ b`);
    expect(text).toContain(`${anchorOf(text, "c")}§ c`);
  });

  it("range mode with endLine only uses start=1", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "range-end.txt"), "a\nb\nc\nd\ne\n", "utf8");
    const tools = await loadTools();
    const result = await tools
      .get("read_anchored")!
      .execute("1", { path: "range-end.txt", endLine: 2 }, undefined, undefined, { cwd });
    const text = result.content[0].text as string;
    expect(text).toContain("Lines: 1-2 of 5");
    expect(text).toContain(`${anchorOf(text, "a")}§ a`);
    expect(text).toContain(`${anchorOf(text, "b")}§ b`);
  });

  it("range mode clamps out-of-bounds to an invalid range", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "range-clamp.txt"), "a\nb\n", "utf8");
    const tools = await loadTools();
    await expect(
      tools
        .get("read_anchored")!
        .execute(
          "1",
          { path: "range-clamp.txt", startLine: 10, endLine: 20 },
          undefined,
          undefined,
          {
            cwd,
          },
        ),
    ).rejects.toThrow(/Invalid range/);
  });

  it("auto mode returns full content for large files regardless of line count", async () => {
    const cwd = await workspace();
    const lines = Array.from({ length: 1600 }, (_, i) => `line ${i + 1}`);
    const file = join(cwd, "large-lines.txt");
    await writeFile(file, lines.join("\n") + "\n", "utf8");
    const tools = await loadTools();
    const result = await tools
      .get("read_anchored")!
      .execute("1", { path: "large-lines.txt" }, undefined, undefined, { cwd });
    expect(result.details.mode).toBe("full");
    expect(result.content[0].text).toContain("line 1600");
    expect(result.content[0].text).not.toContain("Mode: skeleton");
  });
});

describe("read empty file", () => {
  it("reads an empty file with Lines: 0 and no anchors", async () => {
    const cwd = await workspace();
    const file = join(cwd, "empty-read.txt");
    await writeFile(file, "", "utf8");
    const tools = await loadTools();
    const result = await tools
      .get("read_anchored")!
      .execute("1", { path: "empty-read.txt" }, undefined, undefined, { cwd });
    const text = result.content[0].text as string;
    expect(text).toContain("Lines: 0");
    expect(text).not.toContain("§");
  });
});

describe("revision mismatch fresh-coordinates recovery", () => {
  async function staleEdit(
    tools: Map<string, ToolDef>,
    cwd: string,
    edits: Record<string, unknown>[],
  ): Promise<Error> {
    let caught: Error | undefined;
    try {
      await tools.get("edit_anchored")!.execute("1", { edits }, undefined, undefined, { cwd });
    } catch (error) {
      caught = error as Error;
    }
    if (!caught) throw new Error("expected a revision mismatch");
    return caught;
  }

  it("carries fresh coordinates and retries in one turn after an external append", async () => {
    const cwd = await workspace();
    const file = join(cwd, "rev.txt");
    await writeFile(file, "alpha\nbeta\ngamma\ndelta\n", "utf8");
    const tools = await loadTools();
    const first = await readAnchored(tools, cwd, "rev.txt");
    const gamma = first.lines.find((l) => l.text === "gamma")!;
    const delta = first.lines.find((l) => l.text === "delta")!;

    // External append after the read — the read's revision is now stale.
    await writeFile(file, "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\n", "utf8");

    const staleEdits = [
      {
        type: "replace",
        path: "rev.txt",
        startAnchor: gamma.anchor,
        startAnchorLine: gamma.text,
        endAnchor: delta.anchor,
        endAnchorLine: delta.text,
        replacement: "GAMMA\nDELTA",
        expectedRevision: first.revision,
      },
    ];
    const error = await staleEdit(tools, cwd, staleEdits);

    expect(error.message).toContain("Revision mismatch");
    expect(error.message).toContain("Fresh coordinates in the current file");
    expect(error.message).toContain("(content unchanged)");
    expect(error.message).toMatch(/Then retry this batch with expectedRevision [a-f0-9]{16}\./);

    // One-turn retry: same anchors, same lines, fresh revision.
    const fresh = /expectedRevision ([a-f0-9]{16})\./.exec(error.message)![1];
    const retryEdits = staleEdits.map((e) => ({ ...e, expectedRevision: fresh }));
    await tools.get("edit_anchored")!.execute("2", { edits: retryEdits }, undefined, undefined, {
      cwd,
    });
    expect(await readFile(file, "utf8")).toBe("alpha\nbeta\nGAMMA\nDELTA\nepsilon\nzeta\neta\n");
  });

  it("shows shifted line numbers when the external change inserts at the top", async () => {
    const cwd = await workspace();
    const file = join(cwd, "rev.txt");
    await writeFile(file, "one\ntwo\n", "utf8");
    const tools = await loadTools();
    const first = await readAnchored(tools, cwd, "rev.txt");
    const one = first.lines.find((l) => l.text === "one")!;

    // External change inserts a line at the top — "one" shifts to line 2.
    await writeFile(file, "zero\none\ntwo\n", "utf8");

    const error = await staleEdit(tools, cwd, [
      {
        type: "replace",
        path: "rev.txt",
        startAnchor: one.anchor,
        startAnchorLine: one.text,
        endAnchor: one.anchor,
        endAnchorLine: one.text,
        replacement: "ONE",
        expectedRevision: first.revision,
      },
    ]);

    expect(error.message).toContain("Fresh coordinates in the current file");
    expect(error.message).toContain(`${one.anchor}§ one    line 2 (content unchanged)`);
  });

  it("reports named anchors that no longer exist instead of inventing coordinates", async () => {
    const cwd = await workspace();
    const file = join(cwd, "rev.txt");
    await writeFile(file, "keep\ntarget\n", "utf8");
    const tools = await loadTools();
    const first = await readAnchored(tools, cwd, "rev.txt");
    const target = first.lines.find((l) => l.text === "target")!;

    // External change deletes the target line entirely.
    await writeFile(file, "keep\n", "utf8");

    const error = await staleEdit(tools, cwd, [
      {
        type: "replace",
        path: "rev.txt",
        startAnchor: target.anchor,
        startAnchorLine: target.text,
        endAnchor: target.anchor,
        endAnchorLine: target.text,
        replacement: "X",
        expectedRevision: first.revision,
      },
    ]);

    expect(error.message).toContain("no longer exist");
    expect(error.message).not.toContain("Fresh coordinates in the current file");
  });

  it("caps the fresh-coordinate block at 8 rows", async () => {
    const cwd = await workspace();
    const file = join(cwd, "rev.txt");
    const lineCount = 12;
    await writeFile(
      file,
      Array.from({ length: lineCount }, (_, i) => `L${i + 1}`).join("\n") + "\n",
      "utf8",
    );
    const tools = await loadTools();
    const first = await readAnchored(tools, cwd, "rev.txt");
    const edits = first.lines.map((l, i) => ({
      type: "replace" as const,
      path: "rev.txt",
      startAnchor: l.anchor,
      startAnchorLine: l.text,
      endAnchor: l.anchor,
      endAnchorLine: l.text,
      replacement: `N${i + 1}`,
      expectedRevision: "0123456789abcdef", // deliberately wrong → guaranteed mismatch
    }));

    const error = await staleEdit(tools, cwd, edits);

    expect(error.message).toContain("Fresh coordinates in the current file");
    expect(error.message).toContain("4 more named anchors omitted");
    expect(error.message.match(/line \d+/g)?.length).toBe(8);
  });
});

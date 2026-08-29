import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
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
    on() {},
  };
  await piFastEdits(pi as any, overrides);
  return tools;
}

async function workspace() {
  return mkdtemp(join(tmpdir(), "pi-fast-edits-"));
}

/** Read a file with read_anchored_file and return its text, revision, and anchored lines. */
async function readAnchored(
  tools: Map<string, ToolDef>,
  cwd: string,
  path: string,
  toolCallId = "1",
) {
  const read = await tools
    .get("read_anchored_file")!
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
      .get("read_anchored_file")!
      .execute("1", { path: "sample.ts" }, undefined, undefined, { cwd });
    const text = read.content[0].text as string;
    expect(text).toContain(`${read.details.lines[0].anchor}§ export function run()`);
    expect(read.details.revision).toMatch(/^[a-f0-9]{16}$/);

    await tools.get("edit_anchored_range")!.execute(
      "2",
      {
        path: "sample.ts",
        startAnchor: read.details.lines[0].anchor,
        startAnchorLine: read.details.lines[0].text,
        endAnchor: read.details.lines[2].anchor,
        endAnchorLine: read.details.lines[2].text,
        replacement: "export function run() {\n  return 2;\n}",
        expectedRevision: read.details.revision,
      },
      undefined,
      undefined,
      { cwd },
    );

    await expect(readFile(file, "utf8")).resolves.toBe("export function run() {\n  return 2;\n}\n");
  });

  it("rejects stale expected revisions without changing the file", async () => {
    const cwd = await workspace();
    const file = join(cwd, "sample.ts");
    await writeFile(file, "one\ntwo\nthree\n", "utf8");
    const tools = await loadTools();

    await expect(
      tools.get("delete_anchor_range")!.execute(
        "1",
        {
          path: "sample.ts",
          startAnchor: "Apple",
          endAnchor: "Apple",
          expectedRevision: "stale",
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(/Revision mismatch/);

    await expect(readFile(file, "utf8")).resolves.toBe("one\ntwo\nthree\n");
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
      .get("read_anchored_file")!
      .execute("1", { path: "sample.ts" }, undefined, undefined, { cwd });
    const details1 = read1.details as {
      lines: Array<{ anchor: string; text: string }>;
      revision: string;
    };

    // External modification invalidates everything the model holds.
    await writeFile(file, "one\ntwo changed\nthree\nfour\n", "utf8");

    await expect(
      tools.get("edit_anchored_range")!.execute(
        "2",
        {
          path: "sample.ts",
          startAnchor: details1.lines[1].anchor,
          endAnchor: details1.lines[1].anchor,
          replacement: "two edited",
          startAnchorLine: details1.lines[1].text,
          endAnchorLine: details1.lines[1].text,
          expectedRevision: details1.revision,
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(/Revision mismatch/);

    // Recovery: re-read gives a fresh mapping and the edit goes through.
    const read2 = await tools
      .get("read_anchored_file")!
      .execute("3", { path: "sample.ts" }, undefined, undefined, { cwd });
    const details2 = read2.details as {
      lines: Array<{ anchor: string; text: string }>;
      revision: string;
    };
    const target = details2.lines.find((l) => l.text === "two changed")!;
    await tools.get("edit_anchored_range")!.execute(
      "4",
      {
        path: "sample.ts",
        startAnchor: target.anchor,
        endAnchor: target.anchor,
        replacement: "two edited",
        startAnchorLine: target.text,
        endAnchorLine: target.text,
        expectedRevision: details2.revision,
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

    await tools.get("apply_anchored_edits")!.execute(
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

  it("preserves CRLF and final-newline style", async () => {
    const cwd = await workspace();
    const file = join(cwd, "sample.txt");
    await writeFile(file, "one\r\ntwo\r\nthree\r\n", "utf8");
    const tools = await loadTools();

    const { lines } = await readAnchored(tools, cwd, "sample.txt");

    await tools.get("edit_anchored_range")!.execute(
      "1",
      {
        path: "sample.txt",
        startAnchor: lines[1].anchor,
        startAnchorLine: lines[1].text,
        endAnchor: lines[1].anchor,
        endAnchorLine: lines[1].text,
        replacement: "TWO",
      },
      undefined,
      undefined,
      { cwd },
    );

    await expect(readFile(file, "utf8")).resolves.toBe("one\r\nTWO\r\nthree\r\n");
  });

  it("cancels protected-path edits when no confirmation UI is available", async () => {
    const cwd = await workspace();
    const file = join(cwd, "package-lock.json");
    await writeFile(file, '{\n  "lockfileVersion": 3\n}\n', "utf8");
    const tools = await loadTools();

    const { lines } = await readAnchored(tools, cwd, "package-lock.json");

    const result = await tools.get("edit_anchored_range")!.execute(
      "1",
      {
        path: "package-lock.json",
        startAnchor: lines[1].anchor,
        startAnchorLine: lines[1].text,
        endAnchor: lines[1].anchor,
        endAnchorLine: lines[1].text,
        replacement: '  "lockfileVersion": 4',
      },
      undefined,
      undefined,
      { cwd },
    );

    expect(result.content[0].text).toContain("Edit cancelled");
    await expect(readFile(file, "utf8")).resolves.toBe('{\n  "lockfileVersion": 3\n}\n');
  });

  it("blocks paths outside the workspace", async () => {
    const cwd = await workspace();
    const outside = join(await workspace(), "outside.txt");
    await writeFile(outside, "secret\n", "utf8");
    const tools = await loadTools();

    await expect(
      tools
        .get("read_anchored_file")!
        .execute("1", { path: outside }, undefined, undefined, { cwd }),
    ).rejects.toThrow(/outside workspace/);
  });

  it("rejects likely binary files", async () => {
    const cwd = await workspace();
    const file = join(cwd, "binary.dat");
    await writeFile(file, Buffer.from([0, 1, 2, 3]));
    const tools = await loadTools();

    await expect(
      tools
        .get("read_anchored_file")!
        .execute("1", { path: "binary.dat" }, undefined, undefined, { cwd }),
    ).rejects.toThrow(/binary file/);
  });

  it("inserts content before and after anchors", async () => {
    const cwd = await workspace();
    const file = join(cwd, "sample.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
    const tools = await loadTools();

    const { lines } = await readAnchored(tools, cwd, "sample.txt");

    await tools.get("insert_at_anchor")!.execute(
      "1",
      {
        path: "sample.txt",
        anchor: lines[0].anchor,
        anchorLine: lines[0].text,
        position: "after",
        content: "ALPHA_INSERTED",
      },
      undefined,
      undefined,
      { cwd },
    );

    await expect(readFile(file, "utf8")).resolves.toBe("alpha\nALPHA_INSERTED\nbeta\ngamma\n");
  });

  it("deletes a range of lines between anchors", async () => {
    const cwd = await workspace();
    const file = join(cwd, "sample.txt");
    await writeFile(file, "alpha\nbeta\ngamma\ndelta\n", "utf8");
    const tools = await loadTools();

    const { lines } = await readAnchored(tools, cwd, "sample.txt");

    await tools.get("delete_anchor_range")!.execute(
      "1",
      {
        path: "sample.txt",
        startAnchor: lines[0].anchor,
        startAnchorLine: lines[0].text,
        endAnchor: lines[2].anchor,
        endAnchorLine: lines[2].text,
      },
      undefined,
      undefined,
      { cwd },
    );

    await expect(readFile(file, "utf8")).resolves.toBe("delta\n");
  });

  it("preview_anchored_edit shows diff without writing", async () => {
    const cwd = await workspace();
    const file = join(cwd, "sample.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
    const tools = await loadTools();

    const { lines } = await readAnchored(tools, cwd, "sample.txt");

    const result = await tools.get("preview_anchored_edit")!.execute(
      "1",
      {
        path: "sample.txt",
        startAnchor: lines[0].anchor,
        startAnchorLine: lines[0].text,
        endAnchor: lines[1].anchor,
        endAnchorLine: lines[1].text,
        replacement: "ALPHA_NEW",
      },
      undefined,
      undefined,
      { cwd },
    );

    expect(result.content[0].text).toContain("ALPHA_NEW");
    expect(result.content[0].text).toContain("-1 alpha");
    // File should be unchanged
    await expect(readFile(file, "utf8")).resolves.toBe("alpha\nbeta\ngamma\n");
  });

  it("read_anchored_file skeleton mode for large files", async () => {
    const cwd = await workspace();
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    const file = join(cwd, "large.txt");
    await writeFile(file, lines.join("\n") + "\n", "utf8");
    const tools = await loadTools();

    const result = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "large.txt", mode: "skeleton" }, undefined, undefined, { cwd });

    const text = result.content[0].text as string;
    expect(text).toContain("Mode: skeleton");
    expect(text).toContain(`${anchorOf(text, "line 1")}§ line 1`);
  });

  it("auto mode selects skeleton for large files (by byte threshold)", async () => {
    const cwd = await workspace();
    const file = join(cwd, "large-bytes.txt");
    // Exceed DEFAULT_CONFIG.maxFullReadBytes (80KB) so auto mode picks skeleton.
    const content = "x".repeat(85 * 1024) + "\n";
    await writeFile(file, content, "utf8");
    const tools = await loadTools();
    const result = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "large-bytes.txt" }, undefined, undefined, { cwd });
    const text = result.content[0].text as string;
    expect(text).toContain("Mode: skeleton");
  });

  it("read_anchored_file range mode with clamping", async () => {
    const cwd = await workspace();
    const file = join(cwd, "sample.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
    const tools = await loadTools();

    const result = await tools
      .get("read_anchored_file")!
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

    await tools.get("apply_anchored_edits")!.execute(
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
      .get("read_anchored_file")!
      .execute("1", { path: "large.txt" }, undefined, undefined, { cwd });

    const text = result.content[0].text as string;
    expect(text).toContain(`${anchorOf(text, "line 1")}§ line 1`);
    expect(text).toContain(`${anchorOf(text, "line 201")}§ line 201`);
  });

  it("insert_at_anchor preserves CRLF line endings", async () => {
    const cwd = await workspace();
    const file = join(cwd, "sample.txt");
    await writeFile(file, "one\r\ntwo\r\nthree\r\n", "utf8");
    const tools = await loadTools();

    const { lines } = await readAnchored(tools, cwd, "sample.txt");

    await tools.get("insert_at_anchor")!.execute(
      "1",
      {
        path: "sample.txt",
        anchor: lines[0].anchor,
        anchorLine: lines[0].text,
        position: "after",
        content: "INSERTED",
      },
      undefined,
      undefined,
      { cwd },
    );

    const content = await readFile(file, "utf8");
    expect(content).toContain("\r\n");
    expect(content).toContain("INSERTED");
  });

  it("rejects overlapping edits in apply_anchored_edits", async () => {
    const cwd = await workspace();
    const file = join(cwd, "sample.txt");
    await writeFile(file, "alpha\nbeta\ngamma\ndelta\n", "utf8");
    const tools = await loadTools();

    const { lines } = await readAnchored(tools, cwd, "sample.txt");

    await expect(
      tools.get("apply_anchored_edits")!.execute(
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
      .get("read_anchored_file")!
      .execute("1", { path: "overlap.txt" }, undefined, undefined, { cwd });
    const revision = (readResult.details as any)?.revision;
    const lines = (readResult.details as any)?.lines as any[];

    // Anchored lines: 0 = INS, 1 = REP
    // Insert before INS + replace INS..REP
    // Order: insert first
    await expect(
      tools.get("apply_anchored_edits")!.execute(
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
      tools.get("apply_anchored_edits")!.execute(
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

    await tools.get("apply_anchored_edits")!.execute(
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

  it("verifies anchor line content via startAnchorLine and rejects mismatches", async () => {
    const cwd = await workspace();
    const file = join(cwd, "sample.ts");
    const source = "export function run() {\n  return 1;\n}\n";
    await writeFile(file, source, "utf8");
    const tools = await loadTools();
    const read = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "sample.ts" }, undefined, undefined, { cwd });
    const line1 = (read.details.lines as Array<{ anchor: string; text: string }>)[0];
    // Correct line content succeeds:
    await expect(
      tools.get("edit_anchored_range")!.execute(
        "2",
        {
          path: "sample.ts",
          startAnchor: line1.anchor,
          startAnchorLine: line1.text,
          endAnchor: line1.anchor,
          endAnchorLine: line1.text,
          replacement: "export function run() {\n  return 2;\n}",
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).resolves.toBeTruthy();
    // Full coordinate with WRONG line content is rejected with a corrective message:
    await expect(
      tools.get("edit_anchored_range")!.execute(
        "3",
        {
          path: "sample.ts",
          startAnchor: line1.anchor,
          startAnchorLine: "totally different",
          endAnchor: line1.anchor,
          endAnchorLine: "totally different",
          replacement: "x",
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(/startAnchorLine mismatch/);
  });

  it("applies batch edits using anchor line args", async () => {
    const cwd = await workspace();
    const file = join(cwd, "sample.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
    const tools = await loadTools();

    const { lines } = await readAnchored(tools, cwd, "sample.txt");

    await tools.get("apply_anchored_edits")!.execute(
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
});

describe("error paths", () => {
  it("rejects a non-existent file", async () => {
    const cwd = await workspace();
    const tools = await loadTools();
    await expect(
      tools
        .get("read_anchored_file")!
        .execute("1", { path: "nonexistent.txt" }, undefined, undefined, { cwd }),
    ).rejects.toThrow(/ENOENT|no such file/i);
  });

  it("rejects a directory path", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, "subdir"), { recursive: true });
    const tools = await loadTools();
    await expect(
      tools
        .get("read_anchored_file")!
        .execute("1", { path: "subdir" }, undefined, undefined, { cwd }),
    ).rejects.toThrow(/not a regular file/);
  });

  it("rejects an invalid start anchor", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "sample.txt"), "alpha\nbeta\n", "utf8");
    const tools = await loadTools();
    await expect(
      tools.get("edit_anchored_range")!.execute(
        "1",
        {
          path: "sample.txt",
          startAnchor: "NonExistent",
          endAnchor: "NonExistent",
          replacement: "X",
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(/Could not find start anchor/);
  });

  it("rejects an edit when the file changed after the read", async () => {
    const cwd = await workspace();
    const file = join(cwd, "sample.txt");
    await writeFile(file, "alpha\nbeta\n", "utf8");
    const tools = await loadTools();

    const read = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "sample.txt" }, undefined, undefined, { cwd });
    const revision = (read as any).details.revision as string;

    // Change the file externally so the read revision is now stale.
    await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");

    await expect(
      tools.get("edit_anchored_range")!.execute(
        "1",
        {
          path: "sample.txt",
          startAnchor: "Apple",
          endAnchor: "Apple",
          replacement: "X",
          expectedRevision: revision,
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(/Revision mismatch/);

    // The file must be untouched by the rejected edit.
    await expect(readFile(file, "utf8")).resolves.toBe("alpha\nbeta\ngamma\n");
  });

  it("rejects a broken symlink", async () => {
    const cwd = await workspace();
    await symlink("/nonexistent/path", join(cwd, "broken-link.txt"));
    const tools = await loadTools();
    await expect(
      tools
        .get("read_anchored_file")!
        .execute("1", { path: "broken-link.txt" }, undefined, undefined, { cwd }),
    ).rejects.toThrow();
  });

  it("preview_anchored_edit rejects a stale revision", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "preview.txt"), "alpha\nbeta\n", "utf8");
    const tools = await loadTools();
    await expect(
      tools.get("preview_anchored_edit")!.execute(
        "1",
        {
          path: "preview.txt",
          startAnchor: "Apple",
          endAnchor: "Apple",
          replacement: "X",
          expectedRevision: "stale-revision",
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(/Revision mismatch/);
  });

  it("preview_anchored_edit rejects an invalid anchor", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "preview2.txt"), "alpha\nbeta\n", "utf8");
    const tools = await loadTools();
    await expect(
      tools.get("preview_anchored_edit")!.execute(
        "1",
        {
          path: "preview2.txt",
          startAnchor: "NonExistent",
          endAnchor: "NonExistent",
          replacement: "X",
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(/Could not find start anchor/);
  });

  it("apply_anchored_edits rejects batch with invalid anchor", async () => {
    const cwd = await workspace();
    const file = join(cwd, "batch-invalid.txt");
    await writeFile(file, "alpha\nbeta\n", "utf8");
    const tools = await loadTools();
    await expect(
      tools.get("apply_anchored_edits")!.execute(
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

  it("insert_at_anchor rejects invalid anchor", async () => {
    const cwd = await workspace();
    const file = join(cwd, "insert-invalid.txt");
    await writeFile(file, "alpha\nbeta\n", "utf8");
    const tools = await loadTools();
    await expect(
      tools
        .get("insert_at_anchor")!
        .execute(
          "1",
          { path: "insert-invalid.txt", anchor: "NonExistent", content: "X\n", position: "before" },
          undefined,
          undefined,
          { cwd },
        ),
    ).rejects.toThrow(/Could not find anchor/);
  });

  it("stale revision rejected even when file became empty externally", async () => {
    const cwd = await workspace();
    const file = join(cwd, "empty-stale.txt");
    await writeFile(file, "alpha\nbeta\n", "utf8");
    const tools = await loadTools();

    // Read to get revision
    const readResult = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "empty-stale.txt" }, undefined, undefined, { cwd });
    const revision = (readResult.details as any)?.revision;

    // Externally truncate to empty
    await writeFile(file, "", "utf8");

    // Edit with original revision — should fail
    await expect(
      tools.get("edit_anchored_range")!.execute(
        "2",
        {
          path: "empty-stale.txt",
          startAnchor: "Apple",
          endAnchor: "Apple",
          replacement: "NEW\n",
          expectedRevision: revision,
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow("Revision mismatch");

    // File must still be empty
    const content = await readFile(file, "utf8");
    expect(content).toBe("");
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
        .get("read_anchored_file")!
        .execute("1", { path: "binary-late.txt" }, undefined, undefined, { cwd }),
    ).rejects.toThrow("binary");
  });

  it("two edits to empty file rejected as overlapping", async () => {
    const cwd = await workspace();
    const file = join(cwd, "double-empty.txt");
    await writeFile(file, "", "utf8");
    const tools = await loadTools();

    await expect(
      tools.get("apply_anchored_edits")!.execute(
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
      .get("read_anchored_file")!
      .execute("1", { path: ".env" }, undefined, undefined, { cwd });
    const revision = (readResult.details as any)?.revision;

    // Default config (confirmation: "protected-paths") on a protected path with
    // no confirmation UI available cancels the whole batch without writing.
    const result = await tools.get("apply_anchored_edits")!.execute(
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

  it("includeStart=false + includeEnd=true replaces lines after start", async () => {
    const cwd = await workspace();
    const file = join(cwd, "asymmetric.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
    const tools = await loadTools();
    const readResult = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "asymmetric.txt" }, undefined, undefined, { cwd });
    const lines = (readResult.details as any)?.lines as any[];
    const revision = (readResult.details as any)?.revision;

    // Replace from after Apple through Cider (keeps alpha, replaces beta + gamma).
    await tools.get("edit_anchored_range")!.execute(
      "2",
      {
        path: "asymmetric.txt",
        startAnchor: lines[0].anchor, // Apple
        startAnchorLine: lines[0].text,
        endAnchor: lines[2].anchor, // Cider
        endAnchorLine: lines[2].text,
        includeStart: false,
        includeEnd: true,
        replacement: "NEW\n",
        expectedRevision: revision,
      },
      undefined,
      undefined,
      { cwd },
    );

    const content = await readFile(file, "utf8");
    expect(content).toBe("alpha\nNEW\n");
  });

  it("includeStart=true + includeEnd=false replaces lines up to end", async () => {
    const cwd = await workspace();
    const file = join(cwd, "asymmetric2.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
    const tools = await loadTools();
    const readResult = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "asymmetric2.txt" }, undefined, undefined, { cwd });
    const lines = (readResult.details as any)?.lines as any[];
    const revision = (readResult.details as any)?.revision;

    // Replace from Apple through before Cider (replaces alpha + beta, keeps gamma).
    await tools.get("edit_anchored_range")!.execute(
      "2",
      {
        path: "asymmetric2.txt",
        startAnchor: lines[0].anchor, // Apple
        startAnchorLine: lines[0].text,
        endAnchor: lines[2].anchor, // Cider
        endAnchorLine: lines[2].text,
        includeStart: true,
        includeEnd: false,
        replacement: "NEW\n",
        expectedRevision: revision,
      },
      undefined,
      undefined,
      { cwd },
    );

    const content = await readFile(file, "utf8");
    expect(content).toBe("NEW\ngamma\n");
  });

  it("single insert into empty file in batch succeeds", async () => {
    const cwd = await workspace();
    const file = join(cwd, "batch-empty.txt");
    await writeFile(file, "", "utf8");
    const tools = await loadTools();

    const result = await tools.get("apply_anchored_edits")!.execute(
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

  it("insert_at_anchor rejects a mismatched anchorLine", async () => {
    const cwd = await workspace();
    const file = join(cwd, "insert-coord.txt");
    await writeFile(file, "alpha\nbeta\n", "utf8");
    const tools = await loadTools();

    const { lines } = await readAnchored(tools, cwd, "insert-coord.txt");

    await expect(
      tools.get("insert_at_anchor")!.execute(
        "1",
        {
          path: "insert-coord.txt",
          anchor: lines[0].anchor,
          anchorLine: "wrong text",
          content: "X\n",
          position: "before",
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(/anchorLine mismatch/);

    await expect(readFile(file, "utf8")).resolves.toBe("alpha\nbeta\n");
  });

  it("delete_anchor_range rejects a mismatched anchorLine", async () => {
    const cwd = await workspace();
    const file = join(cwd, "delete-coord.txt");
    await writeFile(file, "alpha\nbeta\n", "utf8");
    const tools = await loadTools();

    const { lines } = await readAnchored(tools, cwd, "delete-coord.txt");

    await expect(
      tools.get("delete_anchor_range")!.execute(
        "1",
        {
          path: "delete-coord.txt",
          startAnchor: lines[0].anchor,
          startAnchorLine: "wrong text",
          endAnchor: lines[1].anchor,
          endAnchorLine: lines[1].text,
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(/startAnchorLine mismatch/);

    await expect(readFile(file, "utf8")).resolves.toBe("alpha\nbeta\n");
  });

  it("preview_anchored_edit rejects a mismatched anchorLine", async () => {
    const cwd = await workspace();
    const file = join(cwd, "preview-coord.txt");
    await writeFile(file, "alpha\nbeta\n", "utf8");
    const tools = await loadTools();

    const { lines } = await readAnchored(tools, cwd, "preview-coord.txt");

    await expect(
      tools.get("preview_anchored_edit")!.execute(
        "1",
        {
          path: "preview-coord.txt",
          startAnchor: lines[0].anchor,
          startAnchorLine: "wrong text",
          endAnchor: lines[1].anchor,
          endAnchorLine: lines[1].text,
          replacement: "X",
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(/startAnchorLine mismatch/);

    await expect(readFile(file, "utf8")).resolves.toBe("alpha\nbeta\n");
  });

  it("apply_anchored_edits rejects a mismatched anchorLine before writing", async () => {
    const cwd = await workspace();
    const file = join(cwd, "batch-coord.txt");
    await writeFile(file, "alpha\nbeta\n", "utf8");
    const tools = await loadTools();

    const { lines } = await readAnchored(tools, cwd, "batch-coord.txt");

    await expect(
      tools.get("apply_anchored_edits")!.execute(
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
  it("preview_anchored_edit with includeStart=false works", async () => {
    const cwd = await workspace();
    const file = join(cwd, "preview-asym.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
    const tools = await loadTools();
    const readResult = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "preview-asym.txt" }, undefined, undefined, { cwd });
    const lines = (readResult.details as any)?.lines as any[];

    const result = await tools.get("preview_anchored_edit")!.execute(
      "2",
      {
        path: "preview-asym.txt",
        startAnchor: lines[0].anchor,
        startAnchorLine: lines[0].text,
        endAnchor: lines[1].anchor,
        endAnchorLine: lines[1].text,
        includeStart: false,
        includeEnd: true,
        replacement: "NEW\n",
      },
      undefined,
      undefined,
      { cwd },
    );

    expect(result.content[0].text).toContain("+");
    expect(result.content[0].text).toContain("-");
  });

  it("insert after last anchor appends to file", async () => {
    const cwd = await workspace();
    const file = join(cwd, "append.txt");
    await writeFile(file, "alpha\nbeta\n", "utf8");
    const tools = await loadTools();
    const readResult = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "append.txt" }, undefined, undefined, { cwd });
    const lines = (readResult.details as any)?.lines as any[];
    const revision = (readResult.details as any)?.revision;

    // Insert after the last anchor (Brave, line 2).
    await tools.get("insert_at_anchor")!.execute(
      "2",
      {
        path: "append.txt",
        anchor: lines[1].anchor,
        anchorLine: lines[1].text,
        position: "after",
        content: "gamma\n",
        expectedRevision: revision,
      },
      undefined,
      undefined,
      { cwd },
    );

    const content = await readFile(file, "utf8");
    expect(content).toBe("alpha\nbeta\ngamma\n");
  });

  it("anchor with trailing | delimiter is normalized", async () => {
    const cwd = await workspace();
    const file = join(cwd, "pipe-del.txt");
    await writeFile(file, "alpha\n", "utf8");
    const tools = await loadTools();
    const readResult = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "pipe-del.txt" }, undefined, undefined, { cwd });
    const revision = (readResult.details as any)?.revision;
    const line1Anchor = (readResult.details as any)?.lines[0].anchor as string;
    const line1Text = (readResult.details as any)?.lines[0].text as string;

    // Use anchor with trailing | — should work (normalizeAnchor strips it).
    const result = await tools.get("edit_anchored_range")!.execute(
      "2",
      {
        path: "pipe-del.txt",
        startAnchor: `${line1Anchor}|`,
        startAnchorLine: line1Text,
        endAnchor: `${line1Anchor}|`,
        endAnchorLine: line1Text,
        replacement: "ALPHA\n",
        expectedRevision: revision,
      },
      undefined,
      undefined,
      { cwd },
    );
    expect(result.content[0].text).toMatch(/^[+-]/m);
    await expect(readFile(file, "utf8")).resolves.toBe("ALPHA\n");
  });

  it("inserts into an empty file to create content", async () => {
    const cwd = await workspace();
    const file = join(cwd, "empty.txt");
    await writeFile(file, "", "utf8");
    const tools = await loadTools();
    const result = await tools
      .get("insert_at_anchor")!
      .execute(
        "1",
        { path: "empty.txt", anchor: "first", content: "hello\n", position: "before" },
        undefined,
        undefined,
        { cwd },
      );
    expect(result.content[0].text).toMatch(/^[+-]/m);
    await expect(readFile(file, "utf8")).resolves.toBe("hello\n");
  });

  it("deleting the entire file leaves an empty file", async () => {
    const cwd = await workspace();
    const file = join(cwd, "sample.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
    const tools = await loadTools();
    const read = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "sample.txt" }, undefined, undefined, { cwd });
    const revision = (read as any).details.revision as string;
    const lines = (read as any).details.lines as any[];

    const result = await tools.get("delete_anchor_range")!.execute(
      "1",
      {
        path: "sample.txt",
        startAnchor: lines[0].anchor,
        startAnchorLine: lines[0].text,
        endAnchor: lines[2].anchor,
        endAnchorLine: lines[2].text,
        expectedRevision: revision,
      },
      undefined,
      undefined,
      { cwd },
    );
    expect(result.content[0].text).toMatch(/^[+-]/m);
    await expect(readFile(file, "utf8")).resolves.toBe("");
  });

  it("zero-width replace between adjacent anchors inserts", async () => {
    const cwd = await workspace();
    const file = join(cwd, "sample.txt");
    await writeFile(file, "alpha\nbeta\n", "utf8");
    const tools = await loadTools();
    const read = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "sample.txt" }, undefined, undefined, { cwd });
    const revision = (read as any).details.revision as string;
    const lines = (read as any).details.lines as any[];

    const result = await tools.get("edit_anchored_range")!.execute(
      "1",
      {
        path: "sample.txt",
        startAnchor: lines[0].anchor,
        startAnchorLine: lines[0].text,
        endAnchor: lines[1].anchor,
        endAnchorLine: lines[1].text,
        includeStart: false,
        includeEnd: false,
        replacement: "X",
        expectedRevision: revision,
      },
      undefined,
      undefined,
      { cwd },
    );
    expect(result.content[0].text).toMatch(/^[+-]/m);
    await expect(readFile(file, "utf8")).resolves.toContain("X");
  });

  it("includeStart=true + includeEnd=false on a single anchor line is a zero-width insert", async () => {
    const cwd = await workspace();
    const file = join(cwd, "single-asym.txt");
    await writeFile(file, "alpha\n", "utf8");
    const tools = await loadTools();
    const read = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "single-asym.txt" }, undefined, undefined, { cwd });
    const revision = (read as any).details.revision as string;
    const lines = (read as any).details.lines as any[];

    // start === end with includeStart=true + includeEnd=false yields start = end - 1,
    // a zero-width splice at the anchor index: content is inserted immediately
    // before the anchor line (neither start nor end line is replaced).
    const result = await tools.get("edit_anchored_range")!.execute(
      "2",
      {
        path: "single-asym.txt",
        startAnchor: lines[0].anchor,
        startAnchorLine: lines[0].text,
        endAnchor: lines[0].anchor,
        endAnchorLine: lines[0].text,
        includeStart: true,
        includeEnd: false,
        replacement: "X",
        expectedRevision: revision,
      },
      undefined,
      undefined,
      { cwd },
    );
    expect(result.content[0].text).toMatch(/^[+-]/m);
    await expect(readFile(file, "utf8")).resolves.toBe("X\nalpha\n");
  });

  it("edits a single-line file", async () => {
    const cwd = await workspace();
    const file = join(cwd, "single.txt");
    await writeFile(file, "only line\n", "utf8");
    const tools = await loadTools();
    const read = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "single.txt" }, undefined, undefined, { cwd });
    const revision = (read as any).details.revision as string;
    const lines = (read as any).details.lines as any[];

    const result = await tools.get("edit_anchored_range")!.execute(
      "1",
      {
        path: "single.txt",
        startAnchor: lines[0].anchor,
        startAnchorLine: lines[0].text,
        endAnchor: lines[0].anchor,
        endAnchorLine: lines[0].text,
        replacement: "changed",
        expectedRevision: revision,
      },
      undefined,
      undefined,
      { cwd },
    );
    expect(result.content[0].text).toMatch(/^[+-]/m);
    await expect(readFile(file, "utf8")).resolves.toBe("changed\n");
  });

  it("anchors whitespace-only lines", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "whitespace.txt"), "   \n  \n\n", "utf8");
    const tools = await loadTools();
    const result = await tools
      .get("read_anchored_file")!
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
      .get("read_anchored_file")!
      .execute("1", { path: "unicode.txt" }, undefined, undefined, { cwd });
    const text = read.content[0].text as string;
    const anchored = text.split("\n").filter((l) => l.includes("§"));
    expect(anchored).toHaveLength(3);

    const revision = (read as any).details.revision as string;
    const lines = (read as any).details.lines as any[];
    const result = await tools.get("edit_anchored_range")!.execute(
      "1",
      {
        path: "unicode.txt",
        startAnchor: lines[0].anchor,
        startAnchorLine: lines[0].text,
        endAnchor: lines[0].anchor,
        endAnchorLine: lines[0].text,
        replacement: "café",
        expectedRevision: revision,
      },
      undefined,
      undefined,
      { cwd },
    );
    // Replacing a line with identical content yields no diff.
    expect(result.content[0].text).toContain("No changes");
  });

  it("preview_anchored_edit on empty file succeeds", async () => {
    const cwd = await workspace();
    const file = join(cwd, "preview-empty.txt");
    await writeFile(file, "", "utf8");
    const tools = await loadTools();
    const result = await tools.get("preview_anchored_edit")!.execute(
      "1",
      {
        path: "preview-empty.txt",
        startAnchor: "first",
        endAnchor: "first",
        replacement: "hello\n",
      },
      undefined,
      undefined,
      { cwd },
    );
    // Preview returns the would-be diff without touching the file.
    expect(result.content[0].text).toContain("+1 hello");
    const content = await readFile(file, "utf8");
    expect(content).toBe("");
  });

  it("delete_anchor_range on empty file is a no-op", async () => {
    const cwd = await workspace();
    const file = join(cwd, "empty-delete.txt");
    await writeFile(file, "", "utf8");
    const tools = await loadTools();
    const result = await tools.get("delete_anchor_range")!.execute(
      "1",
      {
        path: "empty-delete.txt",
        startAnchor: "first",
        endAnchor: "first",
      },
      undefined,
      undefined,
      { cwd },
    );
    // Nothing to delete: the unified diff reports no changes.
    expect(result.content[0].text).toContain("No changes");
    const content = await readFile(file, "utf8");
    expect(content).toBe("");
  });

  it("edit_anchored_range on empty file creates content", async () => {
    const cwd = await workspace();
    const file = join(cwd, "empty-edit.txt");
    await writeFile(file, "", "utf8");
    const tools = await loadTools();
    const result = await tools.get("edit_anchored_range")!.execute(
      "1",
      {
        path: "empty-edit.txt",
        startAnchor: "first",
        endAnchor: "first",
        replacement: "new content\n",
      },
      undefined,
      undefined,
      { cwd },
    );
    expect(result.content[0].text).toMatch(/^[+-]/m);
    const content = await readFile(file, "utf8");
    expect(content).toBe("new content\n");
  });

  it("preserves majority line ending on edit", async () => {
    const cwd = await workspace();
    const file = join(cwd, "mixed-eol.txt");
    // 2 CRLF vs 1 LF → majority is CRLF
    await writeFile(file, "alpha\r\nbeta\r\ngamma\n", "utf8");
    const tools = await loadTools();
    const readResult = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "mixed-eol.txt" }, undefined, undefined, { cwd });
    const lines = (readResult.details as any)?.lines as any[];
    const revision = (readResult.details as any)?.revision;

    await tools.get("edit_anchored_range")!.execute(
      "2",
      {
        path: "mixed-eol.txt",
        startAnchor: lines[0].anchor,
        startAnchorLine: lines[0].text,
        endAnchor: lines[0].anchor,
        endAnchorLine: lines[0].text,
        replacement: "ALPHA\r\n",
        expectedRevision: revision,
      },
      undefined,
      undefined,
      { cwd },
    );

    const content = await readFile(file, "utf8");
    // Majority line ending should be preserved
    expect(content).toContain("\r\n");
  });

  it("BOM-prefixed file edited on line 1 preserves BOM", async () => {
    const cwd = await workspace();
    const file = join(cwd, "bom.txt");
    // UTF-8 BOM + content
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    await writeFile(file, bom.toString("utf8") + "alpha\n", "utf8");
    const tools = await loadTools();
    const readResult = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "bom.txt" }, undefined, undefined, { cwd });
    const lines = (readResult.details as any)?.lines as any[];
    const revision = (readResult.details as any)?.revision;

    await tools.get("edit_anchored_range")!.execute(
      "2",
      {
        path: "bom.txt",
        startAnchor: lines[0].anchor,
        startAnchorLine: lines[0].text,
        endAnchor: lines[0].anchor,
        endAnchorLine: lines[0].text,
        replacement: "ALPHA\n",
        expectedRevision: revision,
      },
      undefined,
      undefined,
      { cwd },
    );

    const content = await readFile(file, "utf8");
    // BOM should be preserved (first 3 bytes)
    expect(content.startsWith("\uFEFF")).toBe(true);
  });

  it("creating content on empty file preserves trailing-newline intent", async () => {
    const cwd = await workspace();
    const file = join(cwd, "empty-create.txt");
    await writeFile(file, "", "utf8");
    const tools = await loadTools();

    // Insert content with trailing newline
    const result1 = await tools.get("edit_anchored_range")!.execute(
      "1",
      {
        path: "empty-create.txt",
        startAnchor: "first",
        endAnchor: "first",
        replacement: "hello\n",
      },
      undefined,
      undefined,
      { cwd },
    );
    expect(result1.content[0].text).toMatch(/^[+-]/m);
    let content = await readFile(file, "utf8");
    expect(content).toBe("hello\n");

    // Insert content without trailing newline
    const file2 = join(cwd, "empty-create2.txt");
    await writeFile(file2, "", "utf8");
    const result2 = await tools.get("edit_anchored_range")!.execute(
      "2",
      {
        path: "empty-create2.txt",
        startAnchor: "first",
        endAnchor: "first",
        replacement: "hello",
      },
      undefined,
      undefined,
      { cwd },
    );
    expect(result2.content[0].text).toMatch(/^[+-]/m);
    content = await readFile(file2, "utf8");
    // Empty line create forces trailing newline (current behavior)
    expect(content).toBe("hello\n");
  });
});

describe("integration chains", () => {
  it("read → edit → read reconciles anchors", async () => {
    const cwd = await workspace();
    const file = join(cwd, "chain.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
    const tools = await loadTools();

    const r1 = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "chain.txt" }, undefined, undefined, { cwd });
    const revision = (r1 as any).details.revision as string;
    const lines = (r1 as any).details.lines as any[];

    // Remove the middle line (beta).
    await tools.get("edit_anchored_range")!.execute(
      "1",
      {
        path: "chain.txt",
        startAnchor: lines[1].anchor,
        startAnchorLine: lines[1].text,
        endAnchor: lines[1].anchor,
        endAnchorLine: lines[1].text,
        replacement: "",
        expectedRevision: revision,
      },
      undefined,
      undefined,
      { cwd },
    );

    const r2 = await tools
      .get("read_anchored_file")!
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
      .get("read_anchored_file")!
      .execute("1", { path: "chain2.txt" }, undefined, undefined, { cwd });
    const revision = (r1 as any).details.revision as string;
    const lines = (r1 as any).details.lines as any[];

    await tools.get("edit_anchored_range")!.execute(
      "1",
      {
        path: "chain2.txt",
        startAnchor: lines[0].anchor,
        startAnchorLine: lines[0].text,
        endAnchor: lines[0].anchor,
        endAnchorLine: lines[0].text,
        replacement: "X",
        expectedRevision: revision,
      },
      undefined,
      undefined,
      { cwd },
    );

    // Reusing the same (now stale) revision must fail.
    await expect(
      tools.get("edit_anchored_range")!.execute(
        "2",
        {
          path: "chain2.txt",
          startAnchor: lines[2].anchor,
          startAnchorLine: lines[2].text,
          endAnchor: lines[2].anchor,
          endAnchorLine: lines[2].text,
          replacement: "Y",
          expectedRevision: revision,
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
      .get("read_anchored_file")!
      .execute("1", { path: "seq.txt" }, undefined, undefined, { cwd });
    const lines0 = (r as any).details.lines as any[];
    await tools.get("edit_anchored_range")!.execute(
      "1",
      {
        path: "seq.txt",
        startAnchor: lines0[0].anchor,
        startAnchorLine: lines0[0].text,
        endAnchor: lines0[0].anchor,
        endAnchorLine: lines0[0].text,
        replacement: "A",
        expectedRevision: (r as any).details.revision,
      },
      undefined,
      undefined,
      { cwd },
    );

    // Re-read to obtain a fresh revision for the next edit.
    r = await tools
      .get("read_anchored_file")!
      .execute("2", { path: "seq.txt" }, undefined, undefined, { cwd });
    const lines1 = (r as any).details.lines as any[];
    await tools.get("edit_anchored_range")!.execute(
      "2",
      {
        path: "seq.txt",
        startAnchor: lines1[2].anchor,
        startAnchorLine: lines1[2].text,
        endAnchor: lines1[2].anchor,
        endAnchorLine: lines1[2].text,
        replacement: "C",
        expectedRevision: (r as any).details.revision,
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
      .get("read_anchored_file")!
      .execute("1", { path: "adjacent.txt" }, undefined, undefined, { cwd });
    const lines = (readResult.details as any)?.lines as any[];
    const revision = (readResult.details as any)?.revision;

    // Insert after "a" + delete "b" — these are adjacent, not truly conflicting,
    // but the current overlap detector treats them as overlapping.
    await expect(
      tools.get("apply_anchored_edits")!.execute(
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
      .get("read_anchored_file")!
      .execute("1", { path: "batch-a.txt" }, undefined, undefined, { cwd });
    const rB = await tools
      .get("read_anchored_file")!
      .execute("2", { path: "batch-b.txt" }, undefined, undefined, { cwd });
    const revA = (rA as any).details?.revision;
    const revB = (rB as any).details?.revision;
    const linesA = (rA as any).details?.lines as any[];
    const linesB = (rB as any).details?.lines as any[];

    // Stale the revision of file B by writing to it directly.
    await writeFile(fileB, "beta-changed\n", "utf8");

    await expect(
      tools.get("apply_anchored_edits")!.execute(
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

describe("confirmation flow", () => {
  it("confirmation 'always' with UI confirm true proceeds", async () => {
    const cwd = await workspace();
    const file = join(cwd, "confirm-true.txt");
    await writeFile(file, "alpha\n", "utf8");
    const tools = await loadTools({ confirmation: "always" });
    const readResult = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "confirm-true.txt" }, undefined, undefined, { cwd });
    const revision = (readResult as any).details.revision;

    const result = await tools.get("edit_anchored_range")!.execute(
      "2",
      {
        path: "confirm-true.txt",
        startAnchor: (readResult as any).details.lines[0].anchor,
        startAnchorLine: (readResult as any).details.lines[0].text,
        endAnchor: (readResult as any).details.lines[0].anchor,
        endAnchorLine: (readResult as any).details.lines[0].text,
        replacement: "ALPHA\n",
        expectedRevision: revision,
      },
      undefined,
      undefined,
      { cwd, ui: { confirm: async () => true } },
    );

    expect(result.content[0].text).toMatch(/^[+-]/m);
    await expect(readFile(file, "utf8")).resolves.toBe("ALPHA\n");
  });

  it("confirmation 'always' with UI confirm false cancels", async () => {
    const cwd = await workspace();
    const file = join(cwd, "confirm-false.txt");
    await writeFile(file, "alpha\n", "utf8");
    const tools = await loadTools({ confirmation: "always" });
    const readResult = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "confirm-false.txt" }, undefined, undefined, { cwd });
    const revision = (readResult as any).details.revision;

    const result = await tools.get("edit_anchored_range")!.execute(
      "2",
      {
        path: "confirm-false.txt",
        startAnchor: (readResult as any).details.lines[0].anchor,
        startAnchorLine: (readResult as any).details.lines[0].text,
        endAnchor: (readResult as any).details.lines[0].anchor,
        endAnchorLine: (readResult as any).details.lines[0].text,
        replacement: "ALPHA\n",
        expectedRevision: revision,
      },
      undefined,
      undefined,
      { cwd, ui: { confirm: async () => false } },
    );

    expect(result.content[0].text).toContain("Edit cancelled");
    await expect(readFile(file, "utf8")).resolves.toBe("alpha\n");
  });

  it("confirmation 'never' on protected path proceeds without UI", async () => {
    const cwd = await workspace();
    const file = join(cwd, ".env");
    await writeFile(file, "SECRET=1\n", "utf8");
    const tools = await loadTools({ confirmation: "never" });
    const readResult = await tools
      .get("read_anchored_file")!
      .execute("1", { path: ".env" }, undefined, undefined, { cwd });
    const revision = (readResult as any).details.revision;

    const result = await tools.get("edit_anchored_range")!.execute(
      "2",
      {
        path: ".env",
        startAnchor: (readResult as any).details.lines[0].anchor,
        startAnchorLine: (readResult as any).details.lines[0].text,
        endAnchor: (readResult as any).details.lines[0].anchor,
        endAnchorLine: (readResult as any).details.lines[0].text,
        replacement: "SECRET=2\n",
        expectedRevision: revision,
      },
      undefined,
      undefined,
      { cwd },
    );

    expect(result.content[0].text).toMatch(/^[+-]/m);
    await expect(readFile(file, "utf8")).resolves.toBe("SECRET=2\n");
  });
});

describe("override", () => {
  it("blocks built-in write and edit tools when enabled", async () => {
    let toolCallHandler:
      | ((
          event: { toolName?: string },
          ctx: unknown,
        ) => Promise<{ block?: boolean; reason?: string } | undefined>)
      | undefined;
    const pi = {
      registerTool() {},
      registerCommand() {},
      on(event: string, handler: typeof toolCallHandler) {
        if (event === "tool_call") toolCallHandler = handler;
      },
    };
    await piFastEdits(pi as any, { overrideBuiltInEditTools: true });

    expect(toolCallHandler).toBeDefined();
    const write = await toolCallHandler!({ toolName: "write" }, {});
    expect(write?.block).toBe(true);
    expect(write?.reason).toContain("pi-fast-edits override");

    const edit = await toolCallHandler!({ toolName: "edit" }, {});
    expect(edit?.block).toBe(true);

    const read = await toolCallHandler!({ toolName: "read_anchored_file" }, {});
    expect(read).toBeUndefined();
  });

  it("does not block when override is disabled (default)", async () => {
    let toolCallHandler:
      ((event: { toolName?: string }, ctx: unknown) => Promise<unknown>) | undefined;
    const pi = {
      registerTool() {},
      registerCommand() {},
      on(_event: string, handler: typeof toolCallHandler) {
        toolCallHandler = handler;
      },
    };
    await piFastEdits(pi as any);
    const result = await toolCallHandler!({ toolName: "edit" }, {});
    expect(result).toBeUndefined();
  });
});

describe("anchored read range modes", () => {
  it("range mode rejects start > end", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "range-edge.txt"), "a\nb\nc\n", "utf8");
    const tools = await loadTools();
    await expect(
      tools
        .get("read_anchored_file")!
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
      .get("read_anchored_file")!
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
      .get("read_anchored_file")!
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
        .get("read_anchored_file")!
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

  it("auto mode selects skeleton for large files by line count", async () => {
    const cwd = await workspace();
    const lines = Array.from({ length: 1600 }, (_, i) => `line ${i + 1}`);
    const file = join(cwd, "large-lines.txt");
    await writeFile(file, lines.join("\n") + "\n", "utf8");
    const tools = await loadTools();
    const result = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "large-lines.txt" }, undefined, undefined, { cwd });
    expect(result.content[0].text).toContain("Mode: skeleton");
  });
});

describe("anchor range validation", () => {
  it("rejects reversed anchor range in edit_anchored_range", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "reversed.txt"), "alpha\nbeta\ngamma\n", "utf8");
    const tools = await loadTools();
    const { lines } = await readAnchored(tools, cwd, "reversed.txt");
    await expect(
      tools.get("edit_anchored_range")!.execute(
        "1",
        {
          path: "reversed.txt",
          startAnchor: lines[2].anchor,
          startAnchorLine: lines[2].text,
          endAnchor: lines[0].anchor,
          endAnchorLine: lines[0].text,
          replacement: "X",
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow("Invalid anchor range");
  });

  it("rejects reversed anchor range in delete_anchor_range", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "reversed-del.txt"), "alpha\nbeta\ngamma\n", "utf8");
    const tools = await loadTools();
    const { lines } = await readAnchored(tools, cwd, "reversed-del.txt");
    await expect(
      tools.get("delete_anchor_range")!.execute(
        "1",
        {
          path: "reversed-del.txt",
          startAnchor: lines[2].anchor,
          startAnchorLine: lines[2].text,
          endAnchor: lines[0].anchor,
          endAnchorLine: lines[0].text,
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow("Invalid delete range");
  });

  it("rejects includeStart=false + includeEnd=false on a single line", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "single-exclude.txt"), "alpha\n", "utf8");
    const tools = await loadTools();
    const { lines } = await readAnchored(tools, cwd, "single-exclude.txt");
    await expect(
      tools.get("edit_anchored_range")!.execute(
        "2",
        {
          path: "single-exclude.txt",
          startAnchor: lines[0].anchor,
          startAnchorLine: lines[0].text,
          endAnchor: lines[0].anchor,
          endAnchorLine: lines[0].text,
          includeStart: false,
          includeEnd: false,
          replacement: "X",
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow("Invalid anchor range");
  });
});

describe("additional edge cases", () => {
  it("editing through a symlink preserves the link and edits the target", async () => {
    const cwd = await workspace();
    const real = join(cwd, "real.txt");
    const link = join(cwd, "link.txt");
    await writeFile(real, "original\n", "utf8");
    await symlink(real, link);

    const tools = await loadTools();
    const readResult = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "link.txt" }, undefined, undefined, { cwd });
    const revision = (readResult as any).details.revision;
    const line1Anchor = (readResult as any).details.lines[0].anchor as string;
    const line1Text = (readResult as any).details.lines[0].text as string;

    await tools.get("edit_anchored_range")!.execute(
      "2",
      {
        path: "link.txt",
        startAnchor: line1Anchor,
        startAnchorLine: line1Text,
        endAnchor: line1Anchor,
        endAnchorLine: line1Text,
        replacement: "modified\n",
        expectedRevision: revision,
      },
      undefined,
      undefined,
      { cwd },
    );

    await expect(readFile(real, "utf8")).resolves.toBe("modified\n");
    const lst = await lstat(link);
    expect(lst.isSymbolicLink()).toBe(true);
  });

  it("editing a file without trailing newline preserves the absence", async () => {
    const cwd = await workspace();
    const file = join(cwd, "no-eol.txt");
    await writeFile(file, "alpha\nbeta", "utf8");
    const tools = await loadTools();
    const readResult = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "no-eol.txt" }, undefined, undefined, { cwd });
    const revision = (readResult as any).details.revision;
    const line1Anchor = (readResult as any).details.lines[0].anchor as string;
    const line1Text = (readResult as any).details.lines[0].text as string;

    await tools.get("edit_anchored_range")!.execute(
      "2",
      {
        path: "no-eol.txt",
        startAnchor: line1Anchor,
        startAnchorLine: line1Text,
        endAnchor: line1Anchor,
        endAnchorLine: line1Text,
        replacement: "ALPHA\n",
        expectedRevision: revision,
      },
      undefined,
      undefined,
      { cwd },
    );

    await expect(readFile(file, "utf8")).resolves.toBe("ALPHA\nbeta");
  });

  it("anchor with trailing § delimiter is normalized", async () => {
    const cwd = await workspace();
    const file = join(cwd, "normalize.txt");
    await writeFile(file, "alpha\n", "utf8");
    const tools = await loadTools();
    const readResult = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "normalize.txt" }, undefined, undefined, { cwd });
    const revision = (readResult as any).details.revision;
    const line1Anchor = (readResult as any).details.lines[0].anchor as string;
    const line1Text = (readResult as any).details.lines[0].text as string;

    const result = await tools.get("edit_anchored_range")!.execute(
      "2",
      {
        path: "normalize.txt",
        startAnchor: `${line1Anchor}§`,
        startAnchorLine: line1Text,
        endAnchor: `${line1Anchor}§`,
        endAnchorLine: line1Text,
        replacement: "ALPHA\n",
        expectedRevision: revision,
      },
      undefined,
      undefined,
      { cwd },
    );
    expect(result.content[0].text).toMatch(/^[+-]/m);
    await expect(readFile(file, "utf8")).resolves.toBe("ALPHA\n");
  });
});

describe("protected-path safety", () => {
  it("does not bypass protection via a symlink alias to a protected target", async () => {
    const cwd = await workspace();
    const real = join(cwd, ".env");
    const alias = join(cwd, ".env-alias");
    await writeFile(real, "SECRET=1\n", "utf8");
    await symlink(real, alias);
    const tools = await loadTools();

    // Read through the alias to get a revision.
    const readResult = await tools
      .get("read_anchored_file")!
      .execute("1", { path: ".env-alias" }, undefined, undefined, { cwd });
    const revision = (readResult.details as any)?.revision;

    // The alias resolves to .env, which is protected, so the edit requires
    // confirmation. With no confirmation UI available the edit is cancelled.
    const result = await tools.get("edit_anchored_range")!.execute(
      "2",
      {
        path: ".env-alias",
        startAnchor: (readResult.details as any)?.lines[0].anchor,
        startAnchorLine: (readResult.details as any)?.lines[0].text,
        endAnchor: (readResult.details as any)?.lines[0].anchor,
        endAnchorLine: (readResult.details as any)?.lines[0].text,
        replacement: "SECRET=2\n",
        expectedRevision: revision,
      },
      undefined,
      undefined,
      { cwd },
    );
    expect(result.content[0].text).toContain("Edit cancelled");
    await expect(readFile(real, "utf8")).resolves.toBe("SECRET=1\n");
  });
});

describe("read empty file", () => {
  it("reads an empty file with Lines: 0 and no anchors", async () => {
    const cwd = await workspace();
    const file = join(cwd, "empty-read.txt");
    await writeFile(file, "", "utf8");
    const tools = await loadTools();
    const result = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "empty-read.txt" }, undefined, undefined, { cwd });
    const text = result.content[0].text as string;
    expect(text).toContain("Lines: 0");
    expect(text).not.toContain("§");
  });
});

describe("line-ending and BOM preservation", () => {
  it("CR-only file is rewritten with LF on edit (current behavior)", async () => {
    const cwd = await workspace();
    const file = join(cwd, "cr-only.txt");
    // Classic Mac line endings (CR only).
    await writeFile(file, "a\rb\rc", "utf8");
    const tools = await loadTools();
    const readResult = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "cr-only.txt" }, undefined, undefined, { cwd });
    const lines = (readResult.details as any)?.lines as any[];
    const revision = (readResult.details as any)?.revision;

    await tools.get("edit_anchored_range")!.execute(
      "2",
      {
        path: "cr-only.txt",
        startAnchor: lines[0].anchor,
        startAnchorLine: lines[0].text,
        endAnchor: lines[0].anchor,
        endAnchorLine: lines[0].text,
        replacement: "A\r\n",
        expectedRevision: revision,
      },
      undefined,
      undefined,
      { cwd },
    );

    const content = await readFile(file, "utf8");
    // CR-only files are parsed as a single line, then written with LF. This
    // documents the current behavior (the CR-only style is not preserved).
    expect(content).toContain("A");
  });

  it("BOM removal externally is invisible to the revision guard", async () => {
    const cwd = await workspace();
    const file = join(cwd, "bom-remove.txt");
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    await writeFile(file, bom.toString("utf8") + "alpha\n", "utf8");
    const tools = await loadTools();

    const readResult = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "bom-remove.txt" }, undefined, undefined, { cwd });
    const revision = (readResult.details as any)?.revision;

    // Externally remove the BOM (same logical text, no BOM).
    await writeFile(file, "alpha\n", "utf8");

    // Edit with the original revision — succeeds because the BOM is stripped
    // before hashing, so the revision is unchanged.
    const result = await tools.get("edit_anchored_range")!.execute(
      "2",
      {
        path: "bom-remove.txt",
        startAnchor: (readResult.details as any)?.lines[0].anchor,
        startAnchorLine: (readResult.details as any)?.lines[0].text,
        endAnchor: (readResult.details as any)?.lines[0].anchor,
        endAnchorLine: (readResult.details as any)?.lines[0].text,
        replacement: "ALPHA\n",
        expectedRevision: revision,
      },
      undefined,
      undefined,
      { cwd },
    );
    expect(result.content[0].text).toMatch(/^[+-]/m);

    // Because removing the BOM leaves the revision hash unchanged, the session's
    // stale hadBom flag is never reconciled, so the BOM is re-added on write.
    const content = await readFile(file, "utf8");
    expect(content.startsWith("\uFEFF")).toBe(true);
  });

  it("empty-file create forces a trailing newline (current behavior)", async () => {
    const cwd = await workspace();
    const file = join(cwd, "empty-force.txt");
    await writeFile(file, "", "utf8");
    const tools = await loadTools();

    // Replace with content that has NO trailing newline.
    await tools.get("edit_anchored_range")!.execute(
      "1",
      {
        path: "empty-force.txt",
        startAnchor: "first",
        endAnchor: "first",
        replacement: "no-newline",
      },
      undefined,
      undefined,
      { cwd },
    );

    const content = await readFile(file, "utf8");
    // Creating content in an empty file forces a trailing newline.
    expect(content).toBe("no-newline\n");
  });
});

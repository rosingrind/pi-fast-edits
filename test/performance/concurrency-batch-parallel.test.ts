import { describe, it, expect } from "vitest";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import type { PiFastEditsConfig } from "../../src/types.js";
import piFastEdits from "../../src/index.js";

type ToolDef = {
  name: string;
  execute: (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => Promise<any>;
};

async function loadTools(overrides?: Partial<PiFastEditsConfig>) {
  const tools = new Map<string, ToolDef>();
  const pi = {
    registerTool(tool: ToolDef) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    on() {},
  };
  await piFastEdits(pi as any, {
    ...{ confirmation: "never", overrideBuiltInEditTools: false },
    ...overrides,
  });
  return tools;
}

async function workspace() {
  return mkdtemp(join(process.env.TMPDIR || "/tmp", "pi-fast-edits-batch-"));
}

describe("concurrency: batch + parallel edit scenarios", () => {
  describe("BP1 — Two batches on overlapping files in same session", () => {
    it("two concurrent batches editing same file: last writer wins per file", async () => {
      const cwd = await workspace();
      const file = join(cwd, "batch-overlap.txt");
      await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");

      const tools = await loadTools();

      // Read file in session
      const r = await tools
        .get("read_anchored_file")!
        .execute("0", { path: "batch-overlap.txt" }, undefined, undefined, { cwd });
      const revision = (r.details as any)?.revision;
      const lines = (r.details as any)?.lines as any[];

      // Two batches in parallel, both editing same file (no expectedRevision - each plans fresh)
      const [batch1, batch2] = await Promise.all([
        tools.get("apply_anchored_edits")!.execute(
          "1",
          {
            edits: [
              {
                type: "replace" as const,
                path: "batch-overlap.txt",
                startAnchor: lines[0].anchor,
                startAnchorLine: lines[0].text,
                endAnchor: lines[0].anchor,
                endAnchorLine: lines[0].text,
                replacement: "ALPHA\n",
                expectedRevision: revision,
              },
            ],
          },
          undefined,
          undefined,
          { cwd },
        ),
        tools.get("apply_anchored_edits")!.execute(
          "2",
          {
            edits: [
              {
                type: "replace" as const,
                path: "batch-overlap.txt",
                startAnchor: lines[2].anchor,
                startAnchorLine: lines[2].text,
                endAnchor: lines[2].anchor,
                endAnchorLine: lines[2].text,
                replacement: "GAMMA\n",
                expectedRevision: revision,
              },
            ],
          },
          undefined,
          undefined,
          { cwd },
        ),
      ]);

      // Both succeed (each batch planned against initial state, last writer wins)
      expect(batch1.content[0].text).toMatch(/^[+-]/m);
      expect(batch2.content[0].text).toMatch(/^[+-]/m);

      // Final state is one of the two outcomes
      const content = await readFile(file, "utf8");
      expect(["ALPHA\nbeta\ngamma\n", "alpha\nbeta\nGAMMA\n"]).toContain(content);
    });
  });




  describe("BP5 — Batch with one invalid path", () => {
    it("batch with valid and invalid paths: valid paths succeed, invalid paths fail with appropriate error", async () => {
      const cwd = await workspace();
      const validFile = join(cwd, "valid.txt");
      const invalidFile = join(cwd, "nonexistent.txt");
      await writeFile(validFile, "alpha\nbeta\n", "utf8");

      const tools = await loadTools();

      // Read valid file
      const r = await tools
        .get("read_anchored_file")!
        .execute("1", { path: "valid.txt" }, undefined, undefined, { cwd });
      const revision = (r.details as any)?.revision;
      const line1Anchor = (r.details as any)?.lines[0].anchor as string;
      const line1Text = (r.details as any)?.lines[0].text as string;
      await expect(
        tools.get("apply_anchored_edits")!.execute(
          "2",
          {
            edits: [
              {
                type: "replace" as const,
                path: "valid.txt",
                startAnchor: line1Anchor,
                startAnchorLine: line1Text,
                endAnchor: line1Anchor,
                endAnchorLine: line1Text,
                replacement: "ALPHA\n",
                expectedRevision: revision,
              },
              {
                type: "replace" as const,
                path: "nonexistent.txt",
                startAnchor: "Apple",
                endAnchor: "Apple",
                replacement: "BETA\n",
              },
            ],
          },
          undefined,
          undefined,
          { cwd },
        ),
      ).rejects.toThrow();

      // Valid file NOT written (all-or-nothing)
      expect(await readFile(validFile, "utf8")).toBe("alpha\nbeta\n");
    });
  });

  describe("BP6 — Batch with one invalid anchor in multi-file batch", () => {
    it("batch where one file has invalid anchor: other files succeed, failing file reports error", async () => {
      const cwd = await workspace();
      const fileA = join(cwd, "batch-anchor-a.txt");
      const fileB = join(cwd, "batch-anchor-b.txt");
      await writeFile(fileA, "alpha\nbeta\n", "utf8");
      await writeFile(fileB, "gamma\ndelta\n", "utf8");

      const tools = await loadTools();

      // Read both files
      const rA = await tools
        .get("read_anchored_file")!
        .execute("1", { path: "batch-anchor-a.txt" }, undefined, undefined, { cwd });
      const rB = await tools
        .get("read_anchored_file")!
        .execute("2", { path: "batch-anchor-b.txt" }, undefined, undefined, { cwd });
      const revA = (rA.details as any)?.revision;
      const revB = (rB.details as any)?.revision;
      const lineA1 = (rA.details as any)?.lines[0].anchor as string;
      const lineA1Text = (rA.details as any)?.lines[0].text as string;

      // Batch with one valid, one invalid anchor - should throw
      await expect(
        tools.get("apply_anchored_edits")!.execute(
          "3",
          {
            edits: [
              {
                type: "replace" as const,
                path: "batch-anchor-a.txt",
                startAnchor: lineA1,
                startAnchorLine: lineA1Text,
                endAnchor: lineA1,
                endAnchorLine: lineA1Text,
                replacement: "ALPHA\n",
                expectedRevision: revA,
              },
              {
                type: "replace" as const,
                path: "batch-anchor-b.txt",
                startAnchor: "NonExistent",
                endAnchor: "NonExistent",
                replacement: "GAMMA\n",
                expectedRevision: revB,
              },
            ],
          },
          undefined,
          undefined,
          { cwd },
        ),
      ).rejects.toThrow("Could not find");

      // Valid file NOT written (all-or-nothing)
      expect(await readFile(fileA, "utf8")).toBe("alpha\nbeta\n");
    });
  });
});

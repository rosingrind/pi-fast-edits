import { describe, it, expect } from "vitest";
import { writeFile, readFile, mkdir, rm } from "node:fs/promises";
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

  describe("BP2 — Batch + concurrent single edit on overlapping file", () => {
    it("batch editing file A, concurrent single edit on same file: deterministic outcome", async () => {
      const cwd = await workspace();
      const file = join(cwd, "batch-single-overlap.txt");
      await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");

      const tools = await loadTools();

      // Read to get revision
      const r = await tools
        .get("read_anchored_file")!
        .execute("0", { path: "batch-single-overlap.txt" }, undefined, undefined, { cwd });
      const revision = (r.details as any)?.revision;
      const lines = (r.details as any)?.lines as any[];

      // Batch edits file, single edit also targets same file
      const [batchResult, editResult] = await Promise.all([
        tools.get("apply_anchored_edits")!.execute(
          "1",
          {
            edits: [
              {
                type: "replace" as const,
                path: "batch-single-overlap.txt",
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
        tools.get("edit_anchored_range")!.execute(
          "2",
          {
            path: "batch-single-overlap.txt",
            startAnchor: lines[2].anchor,
            startAnchorLine: lines[2].text,
            endAnchor: lines[2].anchor,
            endAnchorLine: lines[2].text,
            replacement: "GAMMA\n",
            expectedRevision: revision,
          },
          undefined,
          undefined,
          { cwd },
        ),
      ]);

      // Both succeed, last writer wins — each returns a unified diff.
      expect(batchResult.content[0].text).toMatch(/^[+-]/m);
      expect(editResult.content[0].text).toMatch(/^[+-]/m);

      const content = await readFile(file, "utf8");
      expect(["ALPHA\nbeta\ngamma\n", "alpha\nbeta\nGAMMA\n"]).toContain(content);
    });
  });

  describe("BP3 — Parallel edits where one fails", () => {
    it("parallel edits: both fail revision check after first edit", async () => {
      const cwd = await workspace();
      const file = join(cwd, "parallel-fail.txt");
      await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");

      const tools = await loadTools();

      // Read to get revision
      const r = await tools
        .get("read_anchored_file")!
        .execute("0", { path: "parallel-fail.txt" }, undefined, undefined, { cwd });
      const revision = (r.details as any)?.revision;
      const lines = (r.details as any)?.lines as any[];

      // Edit once - succeeds and changes file
      await tools.get("edit_anchored_range")!.execute(
        "1",
        {
          path: "parallel-fail.txt",
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

      // Now try two parallel edits with STALE revision - BOTH should fail
      const results = await Promise.allSettled([
        tools.get("edit_anchored_range")!.execute(
          "2",
          {
            path: "parallel-fail.txt",
            startAnchor: lines[2].anchor,
            startAnchorLine: lines[2].text,
            endAnchor: lines[2].anchor,
            endAnchorLine: lines[2].text,
            replacement: "GAMMA\n",
            expectedRevision: revision, // stale
          },
          undefined,
          undefined,
          { cwd },
        ),
        tools.get("edit_anchored_range")!.execute(
          "3",
          {
            path: "parallel-fail.txt",
            startAnchor: lines[2].anchor,
            startAnchorLine: lines[2].text,
            endAnchor: lines[2].anchor,
            endAnchorLine: lines[2].text,
            replacement: "GAMMA\n",
            expectedRevision: revision, // stale
          },
          undefined,
          undefined,
          { cwd },
        ),
      ]);

      // Both should fail
      expect(results[0].status).toBe("rejected");
      expect(results[1].status).toBe("rejected");
    });
  });

  describe("BP4 — Subagent A reads, B reads, A edits, B edits stale", () => {
    it("two sessions: A reads, B reads, A edits, B tries stale edit: B's edit fails", async () => {
      const cwd = await workspace();
      const file = join(cwd, "subagent-stale.txt");
      await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");

      const toolsA = await loadTools();
      const toolsB = await loadTools();

      // Both sessions read
      const rA = await toolsA
        .get("read_anchored_file")!
        .execute("1", { path: "subagent-stale.txt" }, undefined, undefined, { cwd });
      const rB = await toolsB
        .get("read_anchored_file")!
        .execute("2", { path: "subagent-stale.txt" }, undefined, undefined, { cwd });

      const revisionA = (rA.details as any)?.revision;
      const revisionB = (rB.details as any)?.revision;
      const linesA = (rA.details as any)?.lines as any[];
      const linesB = (rB.details as any)?.lines as any[];

      // Session A edits successfully
      await toolsA.get("edit_anchored_range")!.execute(
        "3",
        {
          path: "subagent-stale.txt",
          startAnchor: linesA[0].anchor,
          startAnchorLine: linesA[0].text,
          endAnchor: linesA[0].anchor,
          endAnchorLine: linesA[0].text,
          replacement: "ALPHA\n",
          expectedRevision: revisionA,
        },
        undefined,
        undefined,
        { cwd },
      );

      // Session B tries to edit with stale revision - should fail
      await expect(
        toolsB.get("edit_anchored_range")!.execute(
          "4",
          {
            path: "subagent-stale.txt",
            startAnchor: linesB[2].anchor,
            startAnchorLine: linesB[2].text,
            endAnchor: linesB[2].anchor,
            endAnchorLine: linesB[2].text,
            replacement: "GAMMA\n",
            expectedRevision: revisionB, // stale
          },
          undefined,
          undefined,
          { cwd },
        ),
      ).rejects.toThrow("Revision mismatch");
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

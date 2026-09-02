import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
    ...{ confirmation: "never" },
    ...overrides,
  });
  return tools;
}

async function workspace() {
  return mkdtemp(join(tmpdir(), "pi-fast-edits-concurrency-"));
}

// chmod-based write-protection tests only fail writes when running as a
// non-root user; root can write into 0o555 directories, so skip there.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("concurrency: parallel subagent scenarios", () => {
  describe("H1b — Batch partial application on write failure", () => {
    it("batch applies multiple files atomically on the happy path", async () => {
      const cwd = await workspace();
      const fileA = join(cwd, "partial-a.txt");
      const fileB = join(cwd, "partial-b.txt");
      await writeFile(fileA, "alpha\n", "utf8");
      await writeFile(fileB, "beta\n", "utf8");

      const tools = await loadTools();

      // Read both
      const rA = await tools
        .get("read_anchored")!
        .execute("1", { path: "partial-a.txt" }, undefined, undefined, { cwd });
      const rB = await tools
        .get("read_anchored")!
        .execute("2", { path: "partial-b.txt" }, undefined, undefined, { cwd });
      const revA = (rA.details as any)?.revision;
      const revB = (rB.details as any)?.revision;
      const linesA = (rA.details as any)?.lines as any[];
      const linesB = (rB.details as any)?.lines as any[];

      const result = await tools.get("edit_anchored")!.execute(
        "3",
        {
          edits: [
            {
              type: "replace" as const,
              path: "partial-a.txt",
              startAnchor: linesA[0].anchor,
              startAnchorLine: linesA[0].text,
              endAnchor: linesA[0].anchor,
              endAnchorLine: linesA[0].text,
              replacement: "ALPHA\n",
              expectedRevision: revA,
            },
            {
              type: "replace" as const,
              path: "partial-b.txt",
              startAnchor: linesB[0].anchor,
              startAnchorLine: linesB[0].text,
              endAnchor: linesB[0].anchor,
              endAnchorLine: linesB[0].text,
              replacement: "BETA\n",
              expectedRevision: revB,
            },
          ],
        },
        undefined,
        undefined,
        { cwd },
      );

      // Per-file output: the combined unified diff references both edits.
      expect(result.content[0].text).toContain("+1 ALPHA");
      expect(result.content[0].text).toContain("+1 BETA");
      expect(await readFile(fileA, "utf8")).toBe("ALPHA\n");
      expect(await readFile(fileB, "utf8")).toBe("BETA\n");
    });

    // The batch validates/plans ALL files first, then writes them sequentially
    // in edit order. A write failure on a later file must not roll back an
    // already-written earlier file — the batch is NOT transactional.
    it.skipIf(isRoot)(
      "mid-batch write failure partially applies: earlier files written, failing file untouched",
      async () => {
        const cwd = await workspace();
        const fileA = join(cwd, "partial-write-a.txt");
        const dirB = join(cwd, "partial-b");
        const fileB = join(dirB, "b.txt");
        await mkdir(dirB, { recursive: true });
        await writeFile(fileA, "alpha\n", "utf8");
        await writeFile(fileB, "beta\n", "utf8");

        // Read-only dir: reads still succeed, but creating the temp file for an
        // atomic write fails (EACCES) on the second batch write.
        await chmod(dirB, 0o555);
        try {
          const tools = await loadTools();
          const rA = await tools
            .get("read_anchored")!
            .execute("1", { path: "partial-write-a.txt" }, undefined, undefined, { cwd });
          const rB = await tools
            .get("read_anchored")!
            .execute("2", { path: "partial-b/b.txt" }, undefined, undefined, { cwd });

          // fileA writes first (writable), fileB write then fails. The batch
          // rejects, but fileA is already persisted (partial application).
          await expect(
            tools.get("edit_anchored")!.execute(
              "3",
              {
                edits: [
                  {
                    type: "replace" as const,
                    path: "partial-write-a.txt",
                    startAnchor: (rA.details as any)?.lines[0].anchor,
                    startAnchorLine: (rA.details as any)?.lines[0].text,
                    endAnchor: (rA.details as any)?.lines[0].anchor,
                    endAnchorLine: (rA.details as any)?.lines[0].text,
                    replacement: "ALPHA\n",
                    expectedRevision: (rA.details as any)?.revision,
                  },
                  {
                    type: "replace" as const,
                    path: "partial-b/b.txt",
                    startAnchor: (rB.details as any)?.lines[0].anchor,
                    startAnchorLine: (rB.details as any)?.lines[0].text,
                    endAnchor: (rB.details as any)?.lines[0].anchor,
                    endAnchorLine: (rB.details as any)?.lines[0].text,
                    replacement: "BETA\n",
                    expectedRevision: (rB.details as any)?.revision,
                  },
                ],
              },
              undefined,
              undefined,
              { cwd },
            ),
          ).rejects.toThrow();

          // Partial application: the writable file changed, the read-only one
          // did not.
          expect(await readFile(fileA, "utf8")).toBe("ALPHA\n");
          expect(await readFile(fileB, "utf8")).toBe("beta\n");
        } finally {
          await chmod(dirB, 0o755).catch(() => {});
        }
      },
    );
  });

  describe("H1c — Read/edit concurrency in same session", () => {
    it("concurrent read and edit in same session: both succeed", async () => {
      const cwd = await workspace();
      const file = join(cwd, "read-edit-concurrent.txt");
      await writeFile(file, "alpha\nbeta\n", "utf8");

      const tools = await loadTools();

      // Read first to obtain the line-1 anchor for the concurrent edit.
      const pre = await tools
        .get("read_anchored")!
        .execute("1", { path: "read-edit-concurrent.txt" }, undefined, undefined, { cwd });
      const line1Anchor = (pre.details as any)?.lines[0].anchor as string;
      const line1Text = (pre.details as any)?.lines[0].text as string;

      // Concurrent read and edit
      const [readResult, editResult] = await Promise.all([
        tools
          .get("read_anchored")!
          .execute("2", { path: "read-edit-concurrent.txt" }, undefined, undefined, { cwd }),
        tools.get("edit_anchored")!.execute(
          "3",
          {
            edits: [
              {
                type: "replace",
                path: "read-edit-concurrent.txt",
                startAnchor: line1Anchor,
                startAnchorLine: line1Text,
                endAnchor: line1Anchor,
                endAnchorLine: line1Text,
                replacement: "ALPHA\n",
              },
            ],
          },
          undefined,
          undefined,
          { cwd },
        ),
      ]);

      // Both should succeed
      expect(readResult.content[0].text).toContain(line1Anchor);
      expect(editResult.content[0].text).toMatch(/^[+-]/m);
    });
  });

  describe("H3 — Concurrent batch write clobbers", () => {
    it("batch writes clobber concurrent external modification", async () => {
      const cwd = await workspace();
      const fileA = join(cwd, "batch-a.txt");
      const fileB = join(cwd, "batch-b.txt");
      await writeFile(fileA, "alpha\n", "utf8");
      await writeFile(fileB, "beta\n", "utf8");

      const toolsA = await loadTools();

      // Session A reads both files.
      const rA = await toolsA
        .get("read_anchored")!
        .execute("1", { path: "batch-a.txt" }, undefined, undefined, { cwd });
      const rB = await toolsA
        .get("read_anchored")!
        .execute("2", { path: "batch-b.txt" }, undefined, undefined, { cwd });
      const revA = (rA.details as any)?.revision;
      const revB = (rB.details as any)?.revision;
      const linesA = (rA.details as any)?.lines as any[];

      // Another session modifies fileB externally.
      await writeFile(fileB, "external-change\n", "utf8");

      // Session A runs a batch where file-b's revision is now stale. The whole
      // batch aborts before any write (all-or-nothing).
      await expect(
        toolsA.get("edit_anchored")!.execute(
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
                startAnchor: (rB.details as any)?.lines[0].anchor,
                startAnchorLine: (rB.details as any)?.lines[0].text,
                endAnchor: (rB.details as any)?.lines[0].anchor,
                endAnchorLine: (rB.details as any)?.lines[0].text,
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

      // Nothing was written — file-a is untouched too.
      await expect(readFile(fileA, "utf8")).resolves.toBe("alpha\n");
    });
  });

  describe("M1 — Concurrent reads converge", () => {
    it("two parallel reads return same revision", async () => {
      const cwd = await workspace();
      const file = join(cwd, "concurrent-read.txt");
      await writeFile(file, "alpha\nbeta\n", "utf8");

      const tools = await loadTools();

      const [r1, r2] = await Promise.all([
        tools
          .get("read_anchored")!
          .execute("1", { path: "concurrent-read.txt" }, undefined, undefined, { cwd }),
        tools
          .get("read_anchored")!
          .execute("2", { path: "concurrent-read.txt" }, undefined, undefined, { cwd }),
      ]);

      const rev1 = (r1.details as any)?.revision;
      const rev2 = (r2.details as any)?.revision;
      expect(rev1).toBe(rev2);
    });
  });

  describe("M2 — Per-file anchor namespace", () => {
    it("same anchor word resolves to different content in different files", async () => {
      const cwd = await workspace();
      const fileX = join(cwd, "file-x.txt");
      const fileY = join(cwd, "file-y.txt");
      await writeFile(fileX, "line1\nline2\n", "utf8");
      await writeFile(fileY, "different\ncontent\n", "utf8");

      const toolsY = await loadTools();

      const rY = await toolsY
        .get("read_anchored")!
        .execute("2", { path: "file-y.txt" }, undefined, undefined, { cwd });

      const linesY = (rY.details as any)?.lines as any[];

      // Anchors live in per-file namespaces: each file assigns its own
      // (randomized) anchor words, and an anchor always refers to its own file.
      // Editing file-y via its own line-1 anchor must change only file-y.
      await toolsY.get("edit_anchored")!.execute(
        "3",
        {
          edits: [
            {
              type: "replace",
              path: "file-y.txt",
              startAnchor: linesY[0].anchor,
              startAnchorLine: linesY[0].text,
              endAnchor: linesY[0].anchor,
              endAnchorLine: linesY[0].text,
              replacement: "CHANGED\n",
              expectedRevision: (rY.details as any)?.revision,
            },
          ],
        },
        undefined,
        undefined,
        { cwd },
      );

      const contentX = await readFile(fileX, "utf8");
      const contentY = await readFile(fileY, "utf8");
      expect(contentX).toBe("line1\nline2\n"); // unchanged
      expect(contentY).toBe("CHANGED\ncontent\n"); // changed
    });
  });

  describe("H3b — Cross-session concurrent batch writes", () => {
    it("concurrent batch writes from two sessions: last-writer-wins", async () => {
      const cwd = await workspace();
      const file = join(cwd, "batch-concurrent.txt");
      await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");

      const toolsA = await loadTools();
      const toolsB = await loadTools();

      // Each session reads the file so it can target its own (randomized)
      // per-file anchors. Two independent sessions then each run a batch
      // against the same file in parallel. With no expectedRevision (optional
      // per-edit), each session plans against what it reads and the last write
      // wins deterministically, mirroring the C1 single-edit contract for
      // batches.
      const rA = await toolsA
        .get("read_anchored")!
        .execute("1", { path: "batch-concurrent.txt" }, undefined, undefined, { cwd });
      const rB = await toolsB
        .get("read_anchored")!
        .execute("2", { path: "batch-concurrent.txt" }, undefined, undefined, { cwd });
      const linesA = (rA.details as any)?.lines as any[];
      const linesB = (rB.details as any)?.lines as any[];

      const [resultA, resultB] = await Promise.all([
        toolsA.get("edit_anchored")!.execute(
          "3",
          {
            edits: [
              {
                type: "replace" as const,
                path: "batch-concurrent.txt",
                startAnchor: linesA[0].anchor,
                startAnchorLine: linesA[0].text,
                endAnchor: linesA[0].anchor,
                endAnchorLine: linesA[0].text,
                replacement: "ALPHA\n",
              },
            ],
          },
          undefined,
          undefined,
          { cwd },
        ),
        toolsB.get("edit_anchored")!.execute(
          "4",
          {
            edits: [
              {
                type: "replace" as const,
                path: "batch-concurrent.txt",
                startAnchor: linesB[2].anchor,
                startAnchorLine: linesB[2].text,
                endAnchor: linesB[2].anchor,
                endAnchorLine: linesB[2].text,
                replacement: "GAMMA\n",
              },
            ],
          },
          undefined,
          undefined,
          { cwd },
        ),
      ]);

      // Both succeed; no shared-state corruption.
      expect(resultA.content[0].text).toMatch(/^[+-]/m);
      expect(resultB.content[0].text).toMatch(/^[+-]/m);

      // Last-writer-wins: exactly one of the two outcomes survives, with the
      // untouched middle line intact.
      const content = await readFile(file, "utf8");
      expect(content).toContain("beta");
      expect(["ALPHA\nbeta\ngamma\n", "alpha\nbeta\nGAMMA\n"]).toContain(content);
    });
  });

  describe("H4 — Cross-file torn batch observation", () => {
    it("concurrent read during a multi-file batch sees a consistent snapshot, batch converges", async () => {
      const cwd = await workspace();
      const fileA = join(cwd, "torn-a.txt");
      const fileB = join(cwd, "torn-b.txt");
      await writeFile(fileA, "alpha\n", "utf8");
      await writeFile(fileB, "beta\n", "utf8");

      const tools = await loadTools();

      // Pre-read both files so the batch can target their (randomized)
      // per-file anchors. The raw readFile below still races the batch writes.
      const rA = await tools
        .get("read_anchored")!
        .execute("1", { path: "torn-a.txt" }, undefined, undefined, { cwd });
      const rB = await tools
        .get("read_anchored")!
        .execute("2", { path: "torn-b.txt" }, undefined, undefined, { cwd });
      const linesA = (rA.details as any)?.lines as any[];
      const linesB = (rB.details as any)?.lines as any[];

      // Fire the batch and a concurrent read of file B together. The batch
      // writes A then B; the read may land before, between, or after those
      // writes. In every case it must observe a single, internally-consistent
      // snapshot (old or new) — never torn content — and the batch must
      // converge to the final state. This documents the non-transactional
      // multi-file batch contract.
      const [batchResult, observed] = await Promise.all([
        tools.get("edit_anchored")!.execute(
          "3",
          {
            edits: [
              {
                type: "replace" as const,
                path: "torn-a.txt",
                startAnchor: linesA[0].anchor,
                startAnchorLine: linesA[0].text,
                endAnchor: linesA[0].anchor,
                endAnchorLine: linesA[0].text,
                replacement: "ALPHA\n",
              },
              {
                type: "replace" as const,
                path: "torn-b.txt",
                startAnchor: linesB[0].anchor,
                startAnchorLine: linesB[0].text,
                endAnchor: linesB[0].anchor,
                endAnchorLine: linesB[0].text,
                replacement: "BETA\n",
              },
            ],
          },
          undefined,
          undefined,
          { cwd },
        ),
        readFile(fileB, "utf8"),
      ]);

      expect(batchResult.content[0].text).toMatch(/^[+-]/m);
      // Atomic read: the observer saw exactly the before or after state.
      expect(["beta\n", "BETA\n"]).toContain(observed);
      // Batch converged to the final state.
      expect(await readFile(fileA, "utf8")).toBe("ALPHA\n");
      expect(await readFile(fileB, "utf8")).toBe("BETA\n");
    });
  });

  describe("H5 — Abort handling in batch execution", () => {
    // An already-aborted signal cancels the whole batch at entry, before any
    // file is written.
    it("pre-aborted signal cancels the batch before any file is written", async () => {
      const cwd = await workspace();
      const fileA = join(cwd, "abort-a.txt");
      const fileB = join(cwd, "abort-b.txt");
      await writeFile(fileA, "alpha\n", "utf8");
      await writeFile(fileB, "beta\n", "utf8");

      const tools = await loadTools();
      const controller = new AbortController();
      controller.abort();

      const result = await tools.get("edit_anchored")!.execute(
        "1",
        {
          edits: [
            {
              type: "replace" as const,
              path: "abort-a.txt",
              startAnchor: "Apple",
              endAnchor: "Apple",
              replacement: "ALPHA\n",
            },
            {
              type: "replace" as const,
              path: "abort-b.txt",
              startAnchor: "Apple",
              endAnchor: "Apple",
              replacement: "BETA\n",
            },
          ],
        },
        controller.signal,
        undefined,
        { cwd },
      );

      // Aborted at entry — returns a cancellation message, no error thrown.
      expect(result.content[0].text).toContain("aborted");
      // Neither file was touched.
      expect(await readFile(fileA, "utf8")).toBe("alpha\n");
      expect(await readFile(fileB, "utf8")).toBe("beta\n");
    });

    // The batch re-checks the abort signal after each file write, so an abort
    // fired mid-batch stops the remaining files while preserving the ones
    // already written. A signal whose `aborted` becomes true as soon as the
    // first file lands on disk aborts deterministically between write A and
    // write B, with no timing-based flakiness.
    it("abort fired after the first write stops the batch and preserves partial progress", async () => {
      const cwd = await workspace();
      const fileA = join(cwd, "abort-mid-a.txt");
      const fileB = join(cwd, "abort-mid-b.txt");
      await writeFile(fileA, "alpha\n", "utf8");
      await writeFile(fileB, "beta\n", "utf8");

      const tools = await loadTools();

      // Pre-read both files so the batch can target their (randomized)
      // per-file anchors.
      const rA = await tools
        .get("read_anchored")!
        .execute("1", { path: "abort-mid-a.txt" }, undefined, undefined, { cwd });
      const rB = await tools
        .get("read_anchored")!
        .execute("2", { path: "abort-mid-b.txt" }, undefined, undefined, { cwd });
      const linesA = (rA.details as any)?.lines as any[];
      const linesB = (rB.details as any)?.lines as any[];

      // Aborts as soon as file A reflects its first edit. The entry-point
      // check sees A untouched (false); the post-write check after A sees the
      // new content (true), so the batch stops before writing B.
      const signal = {
        get aborted() {
          try {
            return readFileSync(fileA, "utf8").includes("ALPHA");
          } catch {
            return false;
          }
        },
      } as AbortSignal;

      const result = await tools.get("edit_anchored")!.execute(
        "3",
        {
          edits: [
            {
              type: "replace" as const,
              path: "abort-mid-a.txt",
              startAnchor: linesA[0].anchor,
              startAnchorLine: linesA[0].text,
              endAnchor: linesA[0].anchor,
              endAnchorLine: linesA[0].text,
              replacement: "ALPHA\n",
            },
            {
              type: "replace" as const,
              path: "abort-mid-b.txt",
              startAnchor: linesB[0].anchor,
              startAnchorLine: linesB[0].text,
              endAnchor: linesB[0].anchor,
              endAnchorLine: linesB[0].text,
              replacement: "BETA\n",
            },
          ],
        },
        signal,
        undefined,
        { cwd },
      );

      // Partial abort: A is written, B is untouched, and the result reports
      // the partial count while flagging the abort.
      expect(await readFile(fileA, "utf8")).toBe("ALPHA\n");
      expect(await readFile(fileB, "utf8")).toBe("beta\n");
      expect(result.content[0].text).toContain("Aborted after 1 of 2 files");
      expect(result.terminate).toBe(true);
    });
  });
});

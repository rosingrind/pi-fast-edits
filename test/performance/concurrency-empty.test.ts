import { describe, it, expect } from "vitest";
import { writeFile, readFile, mkdir, chmod } from "node:fs/promises";
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
  return mkdtemp(join(process.env.TMPDIR || "/tmp", "pi-fast-edits-empty-"));
}

// chmod-based write-protection only blocks writes for non-root users; root can
// write into 0o555 directories, so those tests are skipped when running as root.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("concurrency: empty-file and session-map stress scenarios", () => {
  describe("E1 — Edit operations on an empty (no-anchor) file", () => {
    it("read_anchored_file on an empty file reports zero lines and a revision", async () => {
      const cwd = await workspace();
      const file = join(cwd, "empty-read.txt");
      await writeFile(file, "", "utf8");
      const tools = await loadTools();

      const read = await tools
        .get("read_anchored_file")!
        .execute("0", { path: "empty-read.txt" }, undefined, undefined, { cwd });

      expect(read.details.mode).toBe("full");
      expect(read.details.lines).toEqual([]);
      expect(typeof read.details.revision).toBe("string");
      expect(read.content[0].text).toContain("Lines: 0");
    });

    it("insert_at_anchor on an empty file creates content from scratch", async () => {
      const cwd = await workspace();
      const file = join(cwd, "empty-insert.txt");
      await writeFile(file, "", "utf8");
      const tools = await loadTools();

      const result = await tools
        .get("insert_at_anchor")!
        .execute(
          "0",
          { path: "empty-insert.txt", anchor: "Apple", position: "after", content: "hello\n" },
          undefined,
          undefined,
          { cwd },
        );

      // Empty files have no anchors, but the plan treats them as a create-from-
      // scratch edit: content is written rather than erroring on a missing anchor.
      expect(result.content[0].text).toMatch(/^[+-]/m);
      expect(await readFile(file, "utf8")).toBe("hello\n");
    });

    it("edit_anchored_range on an empty file creates content from scratch", async () => {
      const cwd = await workspace();
      const file = join(cwd, "empty-replace.txt");
      await writeFile(file, "", "utf8");
      const tools = await loadTools();

      const result = await tools.get("edit_anchored_range")!.execute(
        "0",
        {
          path: "empty-replace.txt",
          startAnchor: "Apple",
          endAnchor: "Cider",
          replacement: "X\nY\n",
        },
        undefined,
        undefined,
        { cwd },
      );

      expect(result.content[0].text).toMatch(/^[+-]/m);
      expect(await readFile(file, "utf8")).toBe("X\nY\n");
    });

    it("delete_anchor_range on an empty file is a no-op", async () => {
      const cwd = await workspace();
      const file = join(cwd, "empty-delete.txt");
      await writeFile(file, "", "utf8");
      const tools = await loadTools();

      const result = await tools
        .get("delete_anchor_range")!
        .execute(
          "0",
          { path: "empty-delete.txt", startAnchor: "Apple", endAnchor: "Cider" },
          undefined,
          undefined,
          { cwd },
        );

      // Nothing to delete: the unified diff reports no changes and the file
      // stays empty.
      expect(result.content[0].text).toContain("No changes");
      expect(await readFile(file, "utf8")).toBe("");
    });
  });

  describe("E2 — Delete a single-anchor range on a one-line file", () => {
    it("delete_anchor_range with start==end deletes the file's only line", async () => {
      const cwd = await workspace();
      const file = join(cwd, "single.txt");
      await writeFile(file, "only\n", "utf8");
      const tools = await loadTools();

      const read = await tools
        .get("read_anchored_file")!
        .execute("0", { path: "single.txt" }, undefined, undefined, { cwd });
      const anchor = (read.details.lines as Array<{ anchor: string; text: string }>)[0].anchor;
      const lineText = (read.details.lines as Array<{ anchor: string; text: string }>)[0].text;

      const result = await tools
        .get("delete_anchor_range")!
        .execute(
          "1",
          {
            path: "single.txt",
            startAnchor: anchor,
            startAnchorLine: lineText,
            endAnchor: anchor,
            endAnchorLine: lineText,
          },
          undefined,
          undefined,
          { cwd },
        );

      expect(result.content[0].text).toMatch(/^[+-]/m);
      expect(await readFile(file, "utf8")).toBe("");
    });
  });

  describe("E3 — Batch partial application on a mid-batch I/O failure", () => {
    it.skipIf(isRoot)(
      "fileA is written before fileB fails; batch rejects with a partial result",
      async () => {
        const cwd = await workspace();
        const writableDir = cwd;
        const readonlyDir = join(cwd, "readonly-dir");
        await mkdir(readonlyDir, { recursive: true });
        const fileA = join(writableDir, "a.txt");
        const fileB = join(readonlyDir, "b.txt");
        await writeFile(fileA, "alpha\nbeta\ngamma\n", "utf8");
        await writeFile(fileB, "one\ntwo\nthree\n", "utf8");

        const tools = await loadTools();

        const rA = await tools
          .get("read_anchored_file")!
          .execute("1", { path: "a.txt" }, undefined, undefined, { cwd });
        const rB = await tools
          .get("read_anchored_file")!
          .execute("2", { path: "readonly-dir/b.txt" }, undefined, undefined, { cwd });
        const revA = rA.details.revision as string;
        const revB = rB.details.revision as string;
        const lineA1 = (rA.details.lines as Array<{ anchor: string; text: string }>)[0].anchor;
        const lineB1 = (rB.details.lines as Array<{ anchor: string; text: string }>)[0].anchor;
        const lineA1Text = (rA.details.lines as Array<{ anchor: string; text: string }>)[0].text;
        const lineB1Text = (rB.details.lines as Array<{ anchor: string; text: string }>)[0].text;

        await chmod(readonlyDir, 0o555);
        try {
          // fileA's edit comes first so it is planned and written before fileB.
          await expect(
            tools.get("apply_anchored_edits")!.execute(
              "3",
              {
                edits: [
                  {
                    type: "replace" as const,
                    path: "a.txt",
                    startAnchor: lineA1,
                    startAnchorLine: lineA1Text,
                    endAnchor: lineA1,
                    endAnchorLine: lineA1Text,
                    replacement: "ALPHA\n",
                    expectedRevision: revA,
                  },
                  {
                    type: "replace" as const,
                    path: "readonly-dir/b.txt",
                    startAnchor: lineB1,
                    startAnchorLine: lineB1Text,
                    endAnchor: lineB1,
                    endAnchorLine: lineB1Text,
                    replacement: "ONE\n",
                    expectedRevision: revB,
                  },
                ],
              },
              undefined,
              undefined,
              { cwd },
            ),
          ).rejects.toThrow();

          // fileA was already persisted (batch is not transactional).
          expect(await readFile(fileA, "utf8")).toBe("ALPHA\nbeta\ngamma\n");
          // fileB was never written because its write failed.
          expect(await readFile(fileB, "utf8")).toBe("one\ntwo\nthree\n");
        } finally {
          await chmod(readonlyDir, 0o755).catch(() => {});
        }
      },
    );
  });

  describe("E4 — Concurrent edits to distinct files stress the session map", () => {
    it("all concurrent single-file edits succeed with correct per-file content", async () => {
      const cwd = await workspace();
      // 100 files deliberately exceeds the session cache's capacity (LRUMap
      // default maxSize 50): an evicted state is rebuilt from disk on the next
      // access, and since pools are seeded per file path, the re-derived
      // anchors are identical to the ones from the earlier read.
      const count = 100;
      const files = Array.from({ length: count }, (_, i) => ({
        rel: `file-${i}.txt`,
        abs: join(cwd, `file-${i}.txt`),
      }));
      for (const f of files) {
        await writeFile(f.abs, "alpha\nbeta\ngamma\n", "utf8");
      }

      const tools = await loadTools();

      const reads = await Promise.all(
        files.map((f, i) =>
          tools
            .get("read_anchored_file")!
            .execute(String(i), { path: f.rel }, undefined, undefined, { cwd }),
        ),
      );
      const revisions = reads.map((r) => r.details.revision as string);
      const anchors = reads.map(
        (r) => (r.details.lines as Array<{ anchor: string; text: string }>)[0].anchor as string,
      );
      const anchorTexts = reads.map(
        (r) => (r.details.lines as Array<{ anchor: string; text: string }>)[0].text as string,
      );

      // Fire 100 concurrent edits, each targeting a distinct file.
      const results = await Promise.all(
        files.map((f, i) =>
          tools.get("edit_anchored_range")!.execute(
            String(1000 + i),
            {
              path: f.rel,
              startAnchor: anchors[i],
              startAnchorLine: anchorTexts[i],
              endAnchor: anchors[i],
              endAnchorLine: anchorTexts[i],
              replacement: `EDITED_${i}\n`,
              expectedRevision: revisions[i],
            },
            undefined,
            undefined,
            { cwd },
          ),
        ),
      );

      results.forEach((r, i) => {
        expect(r.content[0].text).toMatch(/^[+-]/m);
        expect(r.details.anchorChanges.removed).toContain(anchors[i]);
      });

      // Every file has its own deterministic, correct content.
      for (let i = 0; i < count; i++) {
        expect(await readFile(files[i].abs, "utf8")).toBe(`EDITED_${i}\nbeta\ngamma\n`);
      }
    });
  });
});

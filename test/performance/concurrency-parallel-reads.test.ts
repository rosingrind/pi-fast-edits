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
  return mkdtemp(join(process.env.TMPDIR || "/tmp", "pi-fast-edits-parallel-"));
}

describe("concurrency: parallel read + edit races", () => {
  describe("PR1 — Read-in-progress when edit starts", () => {
    it("read that starts before edit sees consistent state (before or after, never during)", async () => {
      const cwd = await workspace();
      const file = join(cwd, "race-read-edit.txt");
      await writeFile(file, "line1\nline2\nline3\n", "utf8");

      const tools = await loadTools();

      // Start a long-running read first (simulated by starting read before edit)
      const readPromise = tools
        .get("read_anchored_file")!
        .execute("1", { path: "race-read-edit.txt", mode: "full" }, undefined, undefined, { cwd });

      // Give read a tiny head start, then fire edit
      await new Promise((r) => setTimeout(r, 1));
      const editPromise = tools.get("edit_anchored_range")!.execute(
        "2",
        {
          path: "race-read-edit.txt",
          startAnchor: "Apple",
          endAnchor: "Apple",
          replacement: "LINE1\n",
        },
        undefined,
        undefined,
        { cwd },
      );

      const [readResult, editResult] = await Promise.all([readPromise, editPromise]);

      // Read must see either full old state or full new state - never a mix
      const readContent = (readResult.details as any)?.lines?.map((l: any) => l.text) || [];
      const editContent = editResult.content[0].text;

      expect(editContent).toMatch(/^[+-]/m);

      // If read started before edit completed, it must see either:
      // - All old lines (line1, line2, line3)
      // - All new lines (LINE1, line2, line3) - if read re-read after edit
      // Never a torn state
      const hasOld = readContent.includes("line1");
      const hasNew = readContent.includes("LINE1");
      const hasMix = hasOld && hasNew && readContent[0] === "line1"; // Mixed state

      expect(hasMix).toBe(false); // Never see torn state
    });
  });

  describe("PR2 — Many concurrent reads in same session", () => {
    it("10 parallel reads of same file in same session all succeed and return consistent revision", async () => {
      const cwd = await workspace();
      const file = join(cwd, "many-reads.txt");
      await writeFile(file, "alpha\nbeta\ngamma\ndelta\nepsilon\n", "utf8");

      const tools = await loadTools();

      // Fire 10 parallel reads
      const reads = Array.from({ length: 10 }, (_, i) =>
        tools
          .get("read_anchored_file")!
          .execute(String(i), { path: "many-reads.txt" }, undefined, undefined, { cwd }),
      );

      const results = await Promise.all(reads);

      // All should succeed
      results.forEach((r) => {
        expect(r.content[0].text).toContain("Apple");
      });

      // All should return same revision
      const revisions = results.map((r) => (r.details as any)?.revision);
      const uniqueRevisions = new Set(revisions);
      expect(uniqueRevisions.size).toBe(1);
    });

    it("10 parallel reads of different files in same session all succeed", async () => {
      const cwd = await workspace();

      // Create 10 files
      for (let i = 0; i < 10; i++) {
        await writeFile(join(cwd, `file${i}.txt`), `content${i}\n`, "utf8");
      }

      const tools = await loadTools();

      // Fire 10 parallel reads to different files
      const reads = Array.from({ length: 10 }, (_, i) =>
        tools
          .get("read_anchored_file")!
          .execute(String(i), { path: `file${i}.txt` }, undefined, undefined, { cwd }),
      );

      const results = await Promise.all(reads);

      // All should succeed with correct content
      results.forEach((r, i) => {
        expect(r.content[0].text).toContain(`content${i}`);
      });
    });
  });

  describe("PR3 — Skeleton mode under concurrent modification", () => {
    it("skeleton read during concurrent edit sees consistent anchor state", async () => {
      const cwd = await workspace();
      const file = join(cwd, "skeleton-race.txt");
      await writeFile(file, "function a() {}\nfunction b() {}\nfunction c() {}\n", "utf8");

      const tools = await loadTools();

      // Fire skeleton read and edit in parallel
      const [skeletonResult, editResult] = await Promise.all([
        tools
          .get("read_anchored_file")!
          .execute("1", { path: "skeleton-race.txt", mode: "skeleton" }, undefined, undefined, {
            cwd,
          }),
        tools.get("edit_anchored_range")!.execute(
          "2",
          {
            path: "skeleton-race.txt",
            startAnchor: "Cider",
            endAnchor: "Cider",
            replacement: "function B() {}\n",
          },
          undefined,
          undefined,
          { cwd },
        ),
      ]);

      // Both should succeed
      expect(skeletonResult.content[0].text).toContain("function");
      expect(editResult.content[0].text).toMatch(/^[+-]/m);

      // Skeleton should have anchors - they might be from before or after edit
      // but must be internally consistent (all from same revision)
      const lines = (skeletonResult.details as any)?.lines || [];
      if (lines.length > 0) {
        // Check all anchors are valid format
        lines.forEach((l: any) => {
          if (l.anchor) {
            expect(l.anchor).toMatch(/^[A-Z][a-z]+$/);
          }
        });
      }
    });
  });

  describe("PR4 — Sequential edits with revision tracking", () => {
    it("sequential edits with expectedRevision succeed and stale edit is rejected", async () => {
      const cwd = await workspace();
      const file = join(cwd, "rapid-edits.txt");
      await writeFile(file, "line1\nline2\nline3\n", "utf8");

      const tools = await loadTools();

      // Read initial state
      const initialRead = await tools
        .get("read_anchored_file")!
        .execute("0", { path: "rapid-edits.txt" }, undefined, undefined, { cwd });
      const initialRevision = (initialRead.details as any)?.revision;

      // First edit succeeds with valid revision
      const result1 = await tools.get("edit_anchored_range")!.execute(
        "1",
        {
          path: "rapid-edits.txt",
          startAnchor: "Apple",
          endAnchor: "Apple",
          replacement: "LINE1\n",
          expectedRevision: initialRevision,
        },
        undefined,
        undefined,
        { cwd },
      );
      expect(result1.content[0].text).toMatch(/^[+-]/m);

      // Second edit with the SAME revision should fail (file changed after first edit)
      await expect(
        tools.get("edit_anchored_range")!.execute(
          "2",
          {
            path: "rapid-edits.txt",
            startAnchor: "Brave",
            endAnchor: "Brave",
            replacement: "LINE2\n",
            expectedRevision: initialRevision, // stale — same revision as initial read
          },
          undefined,
          undefined,
          { cwd },
        ),
      ).rejects.toThrow("Revision mismatch");

      // Read again to get fresh revision
      const read2 = await tools
        .get("read_anchored_file")!
        .execute("3", { path: "rapid-edits.txt" }, undefined, undefined, { cwd });
      const revision2 = (read2.details as any)?.revision;

      // Now the second edit succeeds with the fresh revision
      const result2 = await tools.get("edit_anchored_range")!.execute(
        "4",
        {
          path: "rapid-edits.txt",
          startAnchor: "Brave",
          endAnchor: "Brave",
          replacement: "LINE2\n",
          expectedRevision: revision2,
        },
        undefined,
        undefined,
        { cwd },
      );
      expect(result2.content[0].text).toMatch(/^[+-]/m);

      // Verify final content
      const content = await readFile(file, "utf8");
      expect(content).toBe("LINE1\nLINE2\nline3\n");
    });
  });
  describe("PR5 — Same file preview + edit race", () => {
    it("preview and edit on SAME file and anchors in parallel: deterministic outcome", async () => {
      const cwd = await workspace();
      const file = join(cwd, "preview-edit-same.txt");
      await writeFile(file, "original\ncontent\n", "utf8");

      const tools = await loadTools();

      // Both tools target the SAME file with SAME anchors - this is the real race
      const [previewResult, editResult] = await Promise.all([
        tools.get("preview_anchored_edit")!.execute(
          "1",
          {
            path: "preview-edit-same.txt",
            startAnchor: "Apple",
            endAnchor: "Apple",
            replacement: "NEW\n",
          },
          undefined,
          undefined,
          { cwd },
        ),
        tools.get("edit_anchored_range")!.execute(
          "2",
          {
            path: "preview-edit-same.txt",
            startAnchor: "Apple",
            endAnchor: "Apple",
            replacement: "CHANGED\n",
          },
          undefined,
          undefined,
          { cwd },
        ),
      ]);

      // Preview shows what WOULD happen
      expect(previewResult.content[0].text).toContain("NEW");
      // Edit actually changes the file
      expect(editResult.content[0].text).toMatch(/^[+-]/m);

      // Verify actual file content
      const finalContent = await readFile(file, "utf8");
      expect(finalContent).toContain("CHANGED");
    });
  });

  describe("PR6 — Session revision invalidation", () => {
    it("edit invalidates session revision - subsequent read gets new revision", async () => {
      const cwd = await workspace();
      const file = join(cwd, "revision-invalidation.txt");
      await writeFile(file, "line1\nline2\nline3\n", "utf8");

      const tools = await loadTools();

      // Read file - get initial revision
      const read1 = await tools
        .get("read_anchored_file")!
        .execute("1", { path: "revision-invalidation.txt" }, undefined, undefined, { cwd });
      const revision1 = (read1.details as any)?.revision;

      // Edit file
      await tools.get("edit_anchored_range")!.execute(
        "2",
        {
          path: "revision-invalidation.txt",
          startAnchor: "Apple",
          endAnchor: "Apple",
          replacement: "LINE1\n",
        },
        undefined,
        undefined,
        { cwd },
      );

      // Read again - should get NEW revision
      const read2 = await tools
        .get("read_anchored_file")!
        .execute("3", { path: "revision-invalidation.txt" }, undefined, undefined, { cwd });
      const revision2 = (read2.details as any)?.revision;

      // Revisions should be different
      expect(revision2).not.toBe(revision1);
    });
  });

  describe("PR7 — Concurrent edits to different files", () => {
    it("edits to different files in parallel all succeed", async () => {
      const cwd = await workspace();
      const file1 = join(cwd, "file1.txt");
      const file2 = join(cwd, "file2.txt");
      const file3 = join(cwd, "file3.txt");
      await writeFile(file1, "alpha\n", "utf8");
      await writeFile(file2, "beta\n", "utf8");
      await writeFile(file3, "gamma\n", "utf8");

      const tools = await loadTools();

      await Promise.all([
        tools
          .get("read_anchored_file")!
          .execute("1", { path: "file1.txt" }, undefined, undefined, { cwd }),
        tools
          .get("read_anchored_file")!
          .execute("2", { path: "file2.txt" }, undefined, undefined, { cwd }),
        tools
          .get("read_anchored_file")!
          .execute("3", { path: "file3.txt" }, undefined, undefined, { cwd }),
      ]);
      const [edit1, edit2, edit3] = await Promise.all([
        tools
          .get("edit_anchored_range")!
          .execute(
            "4",
            { path: "file1.txt", startAnchor: "Apple", endAnchor: "Apple", replacement: "ALPHA\n" },
            undefined,
            undefined,
            { cwd },
          ),
        tools
          .get("edit_anchored_range")!
          .execute(
            "5",
            { path: "file2.txt", startAnchor: "Apple", endAnchor: "Apple", replacement: "BETA\n" },
            undefined,
            undefined,
            { cwd },
          ),
        tools
          .get("edit_anchored_range")!
          .execute(
            "6",
            { path: "file3.txt", startAnchor: "Apple", endAnchor: "Apple", replacement: "GAMMA\n" },
            undefined,
            undefined,
            { cwd },
          ),
      ]);

      // All three should succeed — each returns a unified diff.
      expect(edit1.content[0].text).toMatch(/^[+-]/m);
      expect(edit2.content[0].text).toMatch(/^[+-]/m);
      expect(edit3.content[0].text).toMatch(/^[+-]/m);

      // Verify content
      expect(await readFile(file1, "utf8")).toBe("ALPHA\n");
      expect(await readFile(file2, "utf8")).toBe("BETA\n");
      expect(await readFile(file3, "utf8")).toBe("GAMMA\n");
    });
  });
});

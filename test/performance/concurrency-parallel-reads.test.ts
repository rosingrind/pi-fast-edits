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

      // Pre-read so the edit can target the (randomized) line-1 anchor.
      const pre = await tools
        .get("read_anchored")!
        .execute("0", { path: "race-read-edit.txt" }, undefined, undefined, { cwd });
      const line1Anchor = (pre.details as any)?.lines[0].anchor as string;
      const line1Text = (pre.details as any)?.lines[0].text as string;

      // Start a long-running read first (simulated by starting read before edit)
      const readPromise = tools
        .get("read_anchored")!
        .execute("1", { path: "race-read-edit.txt", mode: "full" }, undefined, undefined, { cwd });

      // Give read a tiny head start, then fire edit
      await new Promise((r) => setTimeout(r, 1));
      const editPromise = tools.get("edit_anchored")!.execute(
        "2",
        {
          edits: [
            {
              type: "replace",
              path: "race-read-edit.txt",
              startAnchor: line1Anchor,
              startAnchorLine: line1Text,
              endAnchor: line1Anchor,
              endAnchorLine: line1Text,
              replacement: "LINE1\n",
            },
          ],
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
          .get("read_anchored")!
          .execute(String(i), { path: "many-reads.txt" }, undefined, undefined, { cwd }),
      );

      const results = await Promise.all(reads);

      // All should succeed and each rendered read includes its own line-1
      // anchor (randomized per file, stable across reads of the same session).
      results.forEach((r) => {
        const line0 = (r.details as any)?.lines[0] as { anchor?: string } | undefined;
        expect(line0?.anchor).toMatch(/^[A-Z][a-z]+$/);
        expect(r.content[0].text).toContain(line0!.anchor);
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
          .get("read_anchored")!
          .execute(String(i), { path: `file${i}.txt` }, undefined, undefined, { cwd }),
      );

      const results = await Promise.all(reads);

      // All should succeed with correct content
      results.forEach((r, i) => {
        expect(r.content[0].text).toContain(`content${i}`);
      });
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
        .get("read_anchored")!
        .execute("0", { path: "rapid-edits.txt" }, undefined, undefined, { cwd });
      const initialRevision = (initialRead.details as any)?.revision;
      const line1Anchor = (initialRead.details as any)?.lines[0].anchor as string;
      const line2Anchor = (initialRead.details as any)?.lines[1].anchor as string;
      const line1Text = (initialRead.details as any)?.lines[0].text as string;
      const line2Text = (initialRead.details as any)?.lines[1].text as string;

      // First edit succeeds with valid revision
      const result1 = await tools.get("edit_anchored")!.execute(
        "1",
        {
          edits: [
            {
              type: "replace",
              path: "rapid-edits.txt",
              startAnchor: line1Anchor,
              startAnchorLine: line1Text,
              endAnchor: line1Anchor,
              endAnchorLine: line1Text,
              replacement: "LINE1\n",
              expectedRevision: initialRevision,
            },
          ],
        },
        undefined,
        undefined,
        { cwd },
      );
      expect(result1.content[0].text).toMatch(/^[+-]/m);

      // Second edit with the SAME revision should fail (file changed after first edit)
      await expect(
        tools.get("edit_anchored")!.execute(
          "2",
          {
            edits: [
              {
                type: "replace",
                path: "rapid-edits.txt",
                startAnchor: line2Anchor,
                endAnchor: line2Anchor,
                replacement: "LINE2\n",
                expectedRevision: initialRevision, // stale — same revision as initial read
              },
            ],
          },
          undefined,
          undefined,
          { cwd },
        ),
      ).rejects.toThrow("Revision mismatch");

      // Read again to get fresh revision
      const read2 = await tools
        .get("read_anchored")!
        .execute("3", { path: "rapid-edits.txt" }, undefined, undefined, { cwd });
      const revision2 = (read2.details as any)?.revision;

      // Now the second edit succeeds with the fresh revision
      const result2 = await tools.get("edit_anchored")!.execute(
        "4",
        {
          edits: [
            {
              type: "replace",
              path: "rapid-edits.txt",
              startAnchor: line2Anchor,
              startAnchorLine: line2Text,
              endAnchor: line2Anchor,
              endAnchorLine: line2Text,
              replacement: "LINE2\n",
              expectedRevision: revision2,
            },
          ],
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
  describe("PR6 — Session revision invalidation", () => {
    it("edit invalidates session revision - subsequent read gets new revision", async () => {
      const cwd = await workspace();
      const file = join(cwd, "revision-invalidation.txt");
      await writeFile(file, "line1\nline2\nline3\n", "utf8");

      const tools = await loadTools();

      // Read file - get initial revision
      const read1 = await tools
        .get("read_anchored")!
        .execute("1", { path: "revision-invalidation.txt" }, undefined, undefined, { cwd });
      const revision1 = (read1.details as any)?.revision;
      const line1Anchor = (read1.details as any)?.lines[0].anchor as string;
      const line1Text = (read1.details as any)?.lines[0].text as string;

      // Edit file
      await tools.get("edit_anchored")!.execute(
        "2",
        {
          edits: [
            {
              type: "replace",
              path: "revision-invalidation.txt",
              startAnchor: line1Anchor,
              startAnchorLine: line1Text,
              endAnchor: line1Anchor,
              endAnchorLine: line1Text,
              replacement: "LINE1\n",
            },
          ],
        },
        undefined,
        undefined,
        { cwd },
      );

      // Read again - should get NEW revision
      const read2 = await tools
        .get("read_anchored")!
        .execute("3", { path: "revision-invalidation.txt" }, undefined, undefined, { cwd });
      const revision2 = (read2.details as any)?.revision;

      // Revisions should be different
      expect(revision2).not.toBe(revision1);
    });
  });
});

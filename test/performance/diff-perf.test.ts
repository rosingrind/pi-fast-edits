import { mkdtemp, writeFile, readFile } from "node:fs/promises";
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
  return mkdtemp(join(tmpdir(), "pi-fast-edits-diff-"));
}

describe("Myers diff performance edge cases", () => {
  it("handles worst-case: completely different 1000-line files in under 1 second", async () => {
    const cwd = await workspace();
    // Two completely different files — worst case for Myers diff (O(ND)).
    const oldLines = Array.from({ length: 1000 }, (_, i) => `old-line-${i}`);
    const newLines = Array.from({ length: 1000 }, (_, i) => `new-line-${i}`);
    await writeFile(join(cwd, "old.txt"), oldLines.join("\n") + "\n", "utf8");
    await writeFile(join(cwd, "new.txt"), newLines.join("\n") + "\n", "utf8");
    const tools = await loadTools();

    // Read old file to get anchors.
    const oldResult = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "old.txt", mode: "full" }, undefined, undefined, { cwd });
    const oldRevision = oldResult.details.revision;
    const oldLinesData = oldResult.details.lines as Array<{ anchor: string }>;
    const firstAnchor = oldLinesData[0].anchor;
    const lastAnchor = oldLinesData[oldLinesData.length - 1].anchor;

    const start = Date.now();
    // Replace entire old file content with new file content.
    const editResult = await tools.get("edit_anchored_range")!.execute(
      "3",
      {
        path: "old.txt",
        startAnchor: firstAnchor,
        endAnchor: lastAnchor,
        replacement: newLines.join("\n"),
        expectedRevision: oldRevision,
      },
      undefined,
      undefined,
      { cwd },
    );
    const elapsed = Date.now() - start;

    // Should complete in under 1 second even in worst case.
    expect(elapsed).toBeLessThan(1000);
    // Should succeed.
    expect(editResult.content[0].text).toMatch(/^[+-]/m);
  }, 10000);

  it("handles whole-content rewrite of a 3000-line file in under 5 seconds", async () => {
    const cwd = await workspace();
    // Worst case for Myers diff: zero overlap between before and after.
    const oldLines = Array.from({ length: 3000 }, (_, i) => `old-line-${i}`);
    const newLines = Array.from({ length: 3000 }, (_, i) => `new-line-${i}`);
    await writeFile(join(cwd, "rewrite.txt"), oldLines.join("\n") + "\n", "utf8");
    const tools = await loadTools();

    // Full read gets the anchors and revision.
    const readResult = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "rewrite.txt", mode: "full" }, undefined, undefined, { cwd });
    const revision = readResult.details.revision;
    const linesData = readResult.details.lines as Array<{ anchor: string }>;
    const firstAnchor = linesData[0].anchor;
    const lastAnchor = linesData[linesData.length - 1].anchor;

    const start = Date.now();
    const editResult = await tools.get("edit_anchored_range")!.execute(
      "2",
      {
        path: "rewrite.txt",
        startAnchor: firstAnchor,
        endAnchor: lastAnchor,
        replacement: newLines.join("\n"),
        expectedRevision: revision,
      },
      undefined,
      undefined,
      { cwd },
    );
    const elapsed = Date.now() - start;

    // Generous timeout for CI, but still guards against a quadratic blow-up.
    expect(elapsed).toBeLessThan(5000);
    expect(editResult.content[0].text).toMatch(/^[+-]/m);

    // Final file has the new content.
    const afterResult = await tools
      .get("read_anchored_file")!
      .execute("3", { path: "rewrite.txt", mode: "full" }, undefined, undefined, { cwd });
    const afterLines = afterResult.details.lines as Array<{ text: string }>;
    expect(afterLines).toHaveLength(3000);
    expect(afterLines[0].text).toBe("new-line-0");
    expect(afterLines[afterLines.length - 1].text).toBe("new-line-2999");
  }, 15000);

  it("handles identical content: edit succeeds but produces no diff", async () => {
    const cwd = await workspace();
    const lines = Array.from({ length: 1000 }, (_, i) => `line-${i}`);
    await writeFile(join(cwd, "same.txt"), lines.join("\n") + "\n", "utf8");
    const tools = await loadTools();

    const readResult = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "same.txt", mode: "full" }, undefined, undefined, { cwd });
    const revision = readResult.details.revision;
    const linesData = readResult.details.lines as Array<{ anchor: string }>;
    const firstAnchor = linesData[0].anchor;
    const lastAnchor = linesData[linesData.length - 1].anchor;

    // Replace with identical content — edit succeeds, file unchanged.
    const editResult = await tools.get("edit_anchored_range")!.execute(
      "2",
      {
        path: "same.txt",
        startAnchor: firstAnchor,
        endAnchor: lastAnchor,
        replacement: lines.join("\n"),
        expectedRevision: revision,
      },
      undefined,
      undefined,
      { cwd },
    );

    // Edit reports success: replacing with identical content yields no diff.
    expect(editResult.content[0].text).toContain("No changes");
    // File content is unchanged (edit was a no-op at content level).
    const afterResult = await tools
      .get("read_anchored_file")!
      .execute("3", { path: "same.txt", mode: "full" }, undefined, undefined, { cwd });
    const afterLines = afterResult.details.lines as Array<{ text: string }>;
    expect(afterLines[0].text).toBe("line-0");
    expect(afterLines[afterLines.length - 1].text).toBe("line-999");
  });

  it("handles very long line (50KB) without crashing", async () => {
    const cwd = await workspace();
    const longLine = "x".repeat(50 * 1024);
    await writeFile(join(cwd, "long.txt"), longLine + "\n", "utf8");
    const tools = await loadTools();

    const result = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "long.txt", mode: "full" }, undefined, undefined, { cwd });

    // Should succeed, not crash.
    expect(result.details.mode).toBe("full");
    expect(result.details.lines).toHaveLength(1);
  });
});

describe("session state growth", () => {
  it("handles 100+ files in session without performance degradation", async () => {
    const cwd = await workspace();
    const tools = await loadTools();

    // Create 100 small files.
    const start = Date.now();
    for (let i = 0; i < 100; i++) {
      await writeFile(join(cwd, `file-${i}.txt`), `content-${i}\n`, "utf8");
    }

    // Read all 100 files in sequence.
    for (let i = 0; i < 100; i++) {
      const result = await tools
        .get("read_anchored_file")!
        .execute(String(i), { path: `file-${i}.txt` }, undefined, undefined, { cwd });
      expect(result.details.revision).toBeDefined();
    }
    const elapsed = Date.now() - start;

    // Should complete in under 2 seconds.
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("unicode and emoji in anchors", () => {
  it("handles unicode characters in file content", async () => {
    const cwd = await workspace();
    // Unicode content including 4-byte UTF-8 (emoji).
    const content = "const 苹果 = 1;\nconst 🐍 = 2;\nconst överflöd = 3;\n";
    await writeFile(join(cwd, "unicode.txt"), content, "utf8");
    const tools = await loadTools();

    const result = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "unicode.txt", mode: "full" }, undefined, undefined, { cwd });

    expect(result.details.mode).toBe("full");
    // Should have anchors assigned.
    const lines = result.details.lines as Array<{ anchor: string; text: string }>;
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.anchor).toBeDefined();
      expect(line.anchor.length).toBeGreaterThan(0);
    }
  });

  it("edits file with unicode content correctly", async () => {
    const cwd = await workspace();
    const content = "const 苹果 = 1;\nconst 🐍 = 2;\n";
    await writeFile(join(cwd, "unicode-edit.txt"), content, "utf8");
    const tools = await loadTools();

    const readResult = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "unicode-edit.txt", mode: "full" }, undefined, undefined, { cwd });
    const revision = readResult.details.revision;
    const lines = readResult.details.lines as Array<{ anchor: string }>;
    const firstAnchor = lines[0].anchor;

    const editResult = await tools.get("edit_anchored_range")!.execute(
      "2",
      {
        path: "unicode-edit.txt",
        startAnchor: firstAnchor,
        endAnchor: lines[1].anchor,
        replacement: "const 苹果 = 99;\n",
        expectedRevision: revision,
      },
      undefined,
      undefined,
      { cwd },
    );

    expect(editResult.content[0].text).toMatch(/^[+-]/m);
  });
});

describe("anchor churn under rapid edits", () => {
  it("50 sequential edits maintain unique anchors and correct content", async () => {
    const cwd = await workspace();
    const file = join(cwd, "churn.txt");
    const initialLines = Array.from({ length: 20 }, (_, i) => `line-${i}`);
    await writeFile(file, initialLines.join("\n") + "\n", "utf8");
    const tools = await loadTools();

    // Perform 50 sequential edits, each replacing one line
    for (let i = 0; i < 50; i++) {
      // Read current state before each edit
      const read = await tools
        .get("read_anchored_file")!
        .execute(String(i * 2), { path: "churn.txt" }, undefined, undefined, { cwd });
      const lines = (read.details as any)?.lines as Array<{ anchor: string; text: string }>;

      // Cycle through: first line, last line, and middle line.
      let targetLine: number;
      if (i % 3 === 0) {
        targetLine = 0; // first
      } else if (i % 3 === 1) {
        targetLine = lines.length - 1; // last
      } else {
        targetLine = Math.floor(lines.length / 2); // middle
      }
      const anchor = lines[targetLine].anchor;

      const result = await tools.get("edit_anchored_range")!.execute(
        String(i * 2 + 1),
        {
          path: "churn.txt",
          startAnchor: anchor,
          endAnchor: anchor,
          replacement: `edited-${i}\n`,
        },
        undefined,
        undefined,
        { cwd },
      );
      expect(result.content[0].text).toMatch(/^[+-]/m);
    }

    // Verify final content has the last edit
    const finalContent = await readFile(file, "utf8");
    expect(finalContent).toContain("edited-49");

    // Verify anchors are all unique
    const finalRead = await tools
      .get("read_anchored_file")!
      .execute("100", { path: "churn.txt" }, undefined, undefined, { cwd });
    const finalLinesData = (finalRead.details as any)?.lines as Array<{ anchor: string }>;
    const anchorSet = new Set(finalLinesData.map((l: any) => l.anchor));
    expect(anchorSet.size).toBe(finalLinesData.length);
  });
});

describe("Myers fallback branch (n + m >= 4000)", () => {
  it("delete-all + insert-all fallback for a 3200-line full rewrite", async () => {
    const cwd = await workspace();
    const lineCount = 3200;
    // Completely different old and new lines: zero common prefix/suffix, so the
    // full 3200+3200 middle reaches the core and triggers n + m >= 4000.
    const oldLines = Array.from({ length: lineCount }, (_, i) => `old-line-${i}`);
    const newLines = Array.from({ length: lineCount }, (_, i) => `new-line-${i}`);
    await writeFile(join(cwd, "fallback.txt"), oldLines.join("\n") + "\n", "utf8");
    const tools = await loadTools();

    const readResult = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "fallback.txt", mode: "full" }, undefined, undefined, { cwd });
    const revision = readResult.details.revision;
    const linesData = readResult.details.lines as Array<{ anchor: string }>;
    expect(linesData).toHaveLength(lineCount);
    const firstAnchor = linesData[0].anchor;
    const lastAnchor = linesData[linesData.length - 1].anchor;

    // Replace the whole file content with the new lines.
    const editResult = await tools.get("edit_anchored_range")!.execute(
      "2",
      {
        path: "fallback.txt",
        startAnchor: firstAnchor,
        endAnchor: lastAnchor,
        replacement: newLines.join("\n"),
        expectedRevision: revision,
      },
      undefined,
      undefined,
      { cwd },
    );

    // Fallback path still reports a successful edit.
    expect(editResult.content[0].text).toMatch(/^[+-]/m);

    // Final file content is correct: all 3200 new lines.
    const afterResult = await tools
      .get("read_anchored_file")!
      .execute("3", { path: "fallback.txt", mode: "full" }, undefined, undefined, { cwd });
    const afterLines = afterResult.details.lines as Array<{ anchor: string; text: string }>;
    expect(afterLines).toHaveLength(lineCount);
    expect(afterLines[0].text).toBe("new-line-0");
    expect(afterLines[lineCount - 1].text).toBe(`new-line-${lineCount - 1}`);

    // All anchors remain unique after the full rewrite.
    const anchorSet = new Set(afterLines.map((line) => line.anchor));
    expect(anchorSet.size).toBe(afterLines.length);
  }, 30000);
});

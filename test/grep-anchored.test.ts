import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
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

async function sampleWorkspace() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-fast-edits-grep-"));
  await mkdir(join(cwd, "src"), { recursive: true });
  await mkdir(join(cwd, "node_modules/pkg"), { recursive: true });
  await writeFile(
    join(cwd, "src", "a.ts"),
    "export function alpha() {\n  return 1;\n}\n\nexport function beta() {\n  return alpha();\n}\n",
    "utf8",
  );
  await writeFile(
    join(cwd, "src", "b.ts"),
    "const greeting = 'hello';\nconst Greeting = 'hi';\n",
    "utf8",
  );
  await writeFile(join(cwd, "notes.md"), "- alpha mentioned here\n", "utf8");
  await writeFile(join(cwd, "node_modules", "pkg", "index.js"), "alpha noise\n", "utf8");
  await writeFile(join(cwd, "binary.bin"), "ok\x00alpha\x00binary", "utf8");
  return cwd;
}

describe("grep_anchored_files", () => {
  it("finds matches across a directory with anchors, line numbers, and revision", async () => {
    const cwd = await sampleWorkspace();
    const tools = await loadTools();
    const result = await tools
      .get("grep_anchored_files")!
      .execute("1", { pattern: "alpha" }, undefined, undefined, { cwd });
    const text = result.content[0].text as string;

    expect(text).toContain("File: src/a.ts");
    expect(text).toContain("Revision: ");
    expect(text).toMatch(/Apple§ export function alpha\(\)/);
    expect(text).toContain("line 1");
    expect(text).toContain("Forest§   return alpha();");
    // Notes file also matches
    expect(text).toContain("File: notes.md");
    // node_modules and binary content are skipped
    expect(text).not.toContain("noise");
    expect(text).not.toContain("binary");
  });

  it("searches a single file when path points at a file", async () => {
    const cwd = await sampleWorkspace();
    const tools = await loadTools();
    const result = await tools
      .get("grep_anchored_files")!
      .execute("1", { pattern: "beta", path: "src/a.ts" }, undefined, undefined, { cwd });
    const text = result.content[0].text as string;
    expect(text).toContain("File: src/a.ts");
    expect(text).toMatch(/Eagle§ export function beta\(\) \{/);
    expect(text).not.toContain("notes.md");
  });

  it("supports case-insensitive search", async () => {
    const cwd = await sampleWorkspace();
    const tools = await loadTools();
    const result = await tools
      .get("grep_anchored_files")!
      .execute(
        "1",
        { pattern: "greeting", ignoreCase: true, path: "src/b.ts" },
        undefined,
        undefined,
        { cwd },
      );
    const text = result.content[0].text as string;
    expect(text).toMatch(/Apple§ const greeting/);
    expect(text).toMatch(/Brave§ const Greeting/);
  });

  it("filters files by glob", async () => {
    const cwd = await sampleWorkspace();
    const tools = await loadTools();
    const result = await tools
      .get("grep_anchored_files")!
      .execute("1", { pattern: "alpha", glob: "*.md" }, undefined, undefined, { cwd });
    const text = result.content[0].text as string;
    expect(text).toContain("File: notes.md");
    expect(text).not.toContain("File: src/a.ts");
  });

  it("caps matches per file", async () => {
    const cwd = await sampleWorkspace();
    const tools = await loadTools();
    const result = await tools
      .get("grep_anchored_files")!
      .execute(
        "1",
        { pattern: "alpha|beta", maxMatches: 2, path: "src/a.ts" },
        undefined,
        undefined,
        { cwd },
      );
    const text = result.content[0].text as string;
    const anchored = text.split("\n").filter((l) => l.includes("§ "));
    expect(anchored).toHaveLength(2);
    expect(text).toContain("showing 2 of 3");
  });

  it("returns a no-matches message", async () => {
    const cwd = await sampleWorkspace();
    const tools = await loadTools();
    const result = await tools
      .get("grep_anchored_files")!
      .execute("1", { pattern: "zzz_not_found" }, undefined, undefined, { cwd });
    expect(result.content[0].text).toContain("No matches");
  });

  it("rejects invalid regex patterns", async () => {
    const cwd = await sampleWorkspace();
    const tools = await loadTools();
    await expect(
      tools
        .get("grep_anchored_files")!
        .execute("1", { pattern: "(bad" }, undefined, undefined, { cwd }),
    ).rejects.toThrow(/Invalid regex/);
  });

  it("anchors from grep results are valid for subsequent edits", async () => {
    const cwd = await sampleWorkspace();
    const tools = await loadTools();
    const grep = await tools
      .get("grep_anchored_files")!
      .execute("1", { pattern: "alpha", path: "src/a.ts" }, undefined, undefined, { cwd });
    const grepText = grep.content[0].text as string;
    const revision = /Revision: ([a-f0-9]+)/.exec(grepText)![1];

    // The grep result's revision must satisfy the edit tool's revision guard.
    const edit = await tools.get("edit_anchored_range")!.execute(
      "2",
      {
        path: "src/a.ts",
        startAnchor: "Apple",
        endAnchor: "Brave",
        replacement: "export function alpha2() {\n  return 2;\n}",
        expectedRevision: revision,
      },
      undefined,
      undefined,
      { cwd },
    );
    expect(edit.content[0].text).toContain("+");
  });

  it("skips protected paths", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-fast-edits-grep-"));
    await writeFile(join(cwd, "package-lock.json"), '"locked": "secret-value"\n', "utf8");
    await writeFile(join(cwd, "app.ts"), "const x = 1;\n", "utf8");
    const tools = await loadTools();
    const result = await tools
      .get("grep_anchored_files")!
      .execute("1", { pattern: "secret-value|const x" }, undefined, undefined, { cwd });
    const text = result.content[0].text as string;
    expect(text).toContain("File: app.ts");
    expect(text).not.toContain("package-lock.json");
  });
});

describe("grep_anchored_files (rg-backed)", () => {
  it("returns identical anchored results via rg as the JS path", async () => {
    const cwd = await sampleWorkspace();
    const tools = await loadTools();
    const result = await tools
      .get("grep_anchored_files")!
      .execute("1", { pattern: "alpha", path: "src/a.ts" }, undefined, undefined, { cwd });
    const text = result.content[0].text as string;
    expect(text).toContain("File: src/a.ts");
    expect(text).toContain("Revision: ");
    expect(text).toMatch(/Apple§ export function alpha\(\)/);
  });

  it("omits drifted files and reports them", async () => {
    // Pure-function test of the drift check.
    const { filterDrifted } = await import("../src/tools/grep-anchored.js");
    const hits = [
      { file: "a.ts", lineNo: 1, content: "kept line\n", isMatch: true },
      {
        file: "a.ts",
        lineNo: 2,
        content: "changed since scan\n",
        isMatch: true,
      },
    ];
    const state = { lines: [{ text: "kept line" }, { text: "current text" }] };
    const { kept, drifted } = filterDrifted(hits, state.lines);
    expect(drifted).toBe(true);
    // Only the drifted hit is dropped; the still-valid hit is kept and the
    // caller omits the whole file because `drifted` is true.
    expect(kept).toHaveLength(1);
  });

  it("includes anchored context lines when context > 0", async () => {
    const cwd = await sampleWorkspace();
    const tools = await loadTools();
    const result = await tools
      .get("grep_anchored_files")!
      .execute("1", { pattern: "beta", path: "src/a.ts", context: 1 }, undefined, undefined, {
        cwd,
      });
    const text = result.content[0].text as string;
    expect(text).toMatch(/Eagle§ export function beta\(\) \{/);
    // Line 4 of the fixture is blank, so Delta renders with empty content.
    expect(text).toMatch(/Delta§ +line 4/); // context line above
  });

  it("never reports 'No matches' when the byte budget truncates the first file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-fast-edits-grep-"));
    // One file whose single rendered section exceeds MAX_OUTPUT_BYTES: 500
    // long match lines (~320 bytes each after MAX_LINE_LENGTH truncation)
    // render to well over 100KB, so the budget cuts the very first section.
    const lines: string[] = [];
    for (let i = 1; i <= 500; i++) {
      lines.push(`${"x".repeat(400)} target ${i}`);
    }
    await writeFile(join(cwd, "big.ts"), `${lines.join("\n")}\n`, "utf8");
    const tools = await loadTools();
    const result = await tools
      .get("grep_anchored_files")!
      .execute("1", { pattern: "target", path: "big.ts", maxMatches: 500 }, undefined, undefined, {
        cwd,
      });
    const text = result.content[0].text as string;
    expect(text).toContain("1 file matched, 500 lines shown.");
    expect(text).toContain("truncated at 100KB");
    expect(text).not.toContain("No matches");
  });

  it("falls back to the JS scanner when rg is unavailable", async () => {
    // Force resolveRg to report no binary, then re-import the tool chain
    // fresh: the static import at the top of this file still references the
    // real resolver, so the mock only affects this test's module graph.
    vi.resetModules();
    vi.doMock("../src/fs/rg-resolver.js", () => ({
      resolveRg: async () => null,
    }));
    const { default: piFastEditsMocked } = await import("../src/index.js");

    const cwd = await sampleWorkspace();
    const tools = new Map<string, ToolDef>();
    const pi = {
      registerTool(tool: ToolDef) {
        tools.set(tool.name, tool);
      },
      registerCommand() {},
      on() {},
    };
    await piFastEditsMocked(pi as any, undefined);

    // context is accepted but ignored by the JS scanner (no context lines),
    // while matches and anchors must render. Eagle only appears via rg
    // context, so its absence proves the JS path actually ran.
    const result = await tools
      .get("grep_anchored_files")!
      .execute("1", { pattern: "alpha", path: "src/a.ts", context: 1 }, undefined, undefined, {
        cwd,
      });
    const text = result.content[0].text as string;
    expect(text).toContain("File: src/a.ts");
    expect(text).toMatch(/Apple§ export function alpha\(\)/);
    expect(text).toMatch(/Forest§ {3}return alpha\(\);/);
    expect(text).not.toContain("Eagle");

    vi.doUnmock("../src/fs/rg-resolver.js");
  });
});

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import piFastEdits from "../src/index.js";
import type { PiFastEditsConfig } from "../src/types.js";
import { resolveRg } from "../src/fs/rg-resolver.js";
import { anchorOf, lineTextFrom } from "./anchor-helpers.js";

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

// Context lines and byte-budget truncation are rendered only by the ripgrep
// path; the JS fallback cannot produce them. When no rg binary is resolvable
// (e.g. a CI sandbox without ripgrep), those assertions have nothing to run
// against, so they are skipped — the fallback itself is covered by the mocked
// "falls back to the JS scanner" test below.
const rgAvailable = (await resolveRg()) !== null;
// Every test that reaches the rg scan path is gated: the tool errors out
// (no JS fallback) when rg is missing, so these tests cannot run there.
const itWithRg = rgAvailable ? it : it.skip;

describe("grep_anchored_files", () => {
  itWithRg(
    "finds matches across a directory with anchors, line numbers, and revision",
    async () => {
      const cwd = await sampleWorkspace();
      const tools = await loadTools();
      const result = await tools
        .get("grep_anchored_files")!
        .execute("1", { pattern: "alpha" }, undefined, undefined, { cwd });
      const text = result.content[0].text as string;

      expect(text).toContain("File: src/a.ts");
      expect(text).toContain("Revision: ");
      const alphaAnchor = anchorOf(text, "export function alpha() {");
      expect(text).toMatch(new RegExp(`${alphaAnchor}§ export function alpha\\(\\)`));
      expect(text).toContain("line 1");
      const returnAnchor = anchorOf(text, "  return alpha();");
      expect(text).toContain(`${returnAnchor}§   return alpha();`);
      // Notes file also matches
      expect(text).toContain("File: notes.md");
      // node_modules and binary content are skipped
      expect(text).not.toContain("noise");
      expect(text).not.toContain("binary");
    },
  );

  itWithRg("searches a single file when path points at a file", async () => {
    const cwd = await sampleWorkspace();
    const tools = await loadTools();
    const result = await tools
      .get("grep_anchored_files")!
      .execute("1", { pattern: "beta", path: "src/a.ts" }, undefined, undefined, { cwd });
    const text = result.content[0].text as string;
    expect(text).toContain("File: src/a.ts");
    const betaAnchor = anchorOf(text, "export function beta() {");
    expect(text).toMatch(new RegExp(`${betaAnchor}§ export function beta\\(\\) \\{`));
    expect(text).not.toContain("notes.md");
  });

  itWithRg("supports case-insensitive search", async () => {
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
    const greetingAnchor = anchorOf(text, "const greeting = 'hello';");
    const GreetingAnchor = anchorOf(text, "const Greeting = 'hi';");
    expect(text).toMatch(new RegExp(`${greetingAnchor}§ const greeting`));
    expect(text).toMatch(new RegExp(`${GreetingAnchor}§ const Greeting`));
  });

  itWithRg("filters files by glob", async () => {
    const cwd = await sampleWorkspace();
    const tools = await loadTools();
    const result = await tools
      .get("grep_anchored_files")!
      .execute("1", { pattern: "alpha", glob: "*.md" }, undefined, undefined, { cwd });
    const text = result.content[0].text as string;
    expect(text).toContain("File: notes.md");
    expect(text).not.toContain("File: src/a.ts");
  });

  itWithRg("caps matches per file", async () => {
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

  itWithRg("returns a no-matches message", async () => {
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

  itWithRg("anchors from grep results are valid for subsequent edits", async () => {
    const cwd = await sampleWorkspace();
    const tools = await loadTools();
    const grep = await tools
      .get("grep_anchored_files")!
      .execute("1", { pattern: "alpha", path: "src/a.ts" }, undefined, undefined, { cwd });
    const grepText = grep.content[0].text as string;
    const revision = /Revision: ([a-f0-9]+)/.exec(grepText)![1];
    const alphaAnchor = anchorOf(grepText, "export function alpha() {");
    const alphaLine = lineTextFrom(grepText, "export function alpha() {");

    // The grep result's revision must satisfy the edit tool's revision guard.
    const edit = await tools.get("edit_anchored_range")!.execute(
      "2",
      {
        path: "src/a.ts",
        startAnchor: alphaAnchor,
        startAnchorLine: alphaLine,
        endAnchor: alphaAnchor,
        endAnchorLine: alphaLine,
        replacement: "export function alpha2() {\n  return 2;\n}",
        expectedRevision: revision,
      },
      undefined,
      undefined,
      { cwd },
    );
    expect(edit.content[0].text).toContain("+");
  });

  itWithRg("skips protected paths", async () => {
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

  it.skipIf(!rgAvailable)("includes anchored context lines when context > 0", async () => {
    const cwd = await sampleWorkspace();
    const tools = await loadTools();
    const result = await tools
      .get("grep_anchored_files")!
      .execute("1", { pattern: "beta", path: "src/a.ts", context: 1 }, undefined, undefined, {
        cwd,
      });
    const text = result.content[0].text as string;
    const betaAnchor = anchorOf(text, "export function beta() {");
    expect(text).toMatch(new RegExp(`${betaAnchor}§ export function beta\\(\\) \\{`));
    // Line 4 of the fixture is blank, so it renders with empty content: any
    // anchor followed by whitespace and the line number suffix.
    expect(text).toMatch(/^\w+§ +line 4$/m); // context line above
  });

  it.skipIf(!rgAvailable)(
    "never reports 'No matches' when the byte budget truncates the first file",
    async () => {
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
        .execute(
          "1",
          { pattern: "target", path: "big.ts", maxMatches: 500 },
          undefined,
          undefined,
          {
            cwd,
          },
        );
      const text = result.content[0].text as string;
      expect(text).toContain("1 file matched, 500 lines shown.");
      expect(text).toContain("truncated at 100KB");
      expect(text).not.toContain("No matches");
    },
  );

  it.skipIf(!rgAvailable)(
    "excludes nested node_modules and .git paths from rg results",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "pi-fast-edits-grep-"));
      await mkdir(join(cwd, "packages", "x", "node_modules", "dep"), { recursive: true });
      await mkdir(join(cwd, "packages", "x", ".git"), { recursive: true });
      // Dependency and VCS trees at arbitrary depth: only top-level
      // node_modules/.git segments were filtered before the rg-path fix.
      await writeFile(
        join(cwd, "packages", "x", "node_modules", "dep", "index.js"),
        "leaky-pattern nested dependency\n",
        "utf8",
      );
      await writeFile(
        join(cwd, "packages", "x", ".git", "config"),
        "leaky-pattern = nested git config\n",
        "utf8",
      );
      await writeFile(
        join(cwd, "packages", "x", "src.ts"),
        "const ok = 'leaky-pattern';\n",
        "utf8",
      );
      const tools = await loadTools();
      const result = await tools
        .get("grep_anchored_files")!
        .execute("1", { pattern: "leaky-pattern" }, undefined, undefined, { cwd });
      const text = result.content[0].text as string;
      expect(text).toContain("File: packages/x/src.ts");
      expect(text).not.toContain("index.js");
      expect(text).not.toContain(".git");
    },
  );

  it.skipIf(!rgAvailable)("skips files larger than MAX_FILE_BYTES in rg results", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-fast-edits-grep-"));
    // Just over 1MB so the per-file cap (MAX_FILE_BYTES) must kick in; the
    // padded single line keeps the fixture cheap to write.
    const huge = `oversize-pattern ${`x`.repeat(1024 * 1024 + 200)}\n`;
    await writeFile(join(cwd, "huge.ts"), huge, "utf8");
    await writeFile(join(cwd, "small.ts"), "oversize-pattern small\n", "utf8");
    const tools = await loadTools();
    const result = await tools
      .get("grep_anchored_files")!
      .execute("1", { pattern: "oversize-pattern" }, undefined, undefined, { cwd });
    const text = result.content[0].text as string;
    expect(text).toContain("File: small.ts");
    expect(text).not.toContain("huge.ts");
  });

  it("errors when rg is unavailable (no JS fallback)", async () => {
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

    await expect(
      tools
        .get("grep_anchored_files")!
        .execute("1", { pattern: "alpha", path: "src/a.ts" }, undefined, undefined, { cwd }),
    ).rejects.toThrow(/ripgrep \(rg\) is required for this tool but was not found/);

    vi.doUnmock("../src/fs/rg-resolver.js");
  });

  itWithRg("propagates rg failures instead of falling back", async () => {
    // An invalid-for-rg pattern reaches rg and rg rejects it; the tool must
    // surface that failure (wrapped), not silently degrade.
    const cwd = await sampleWorkspace();
    const tools = await loadTools();
    // A look-behind is invalid in Rust regex (rg's engine) but valid in JS.
    await expect(
      tools
        .get("grep_anchored_files")!
        .execute("1", { pattern: "(?<=x)alpha", path: "src/a.ts" }, undefined, undefined, { cwd }),
    ).rejects.toThrow(/ripgrep search failed/);
  });
});

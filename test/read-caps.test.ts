import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import piFastEdits from "../src/index.js";
import type { PiFastEditsConfig, SessionState } from "../src/types.js";

type ToolDef = {
  name: string;
  execute: (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => Promise<any>;
};

async function loadTools(overrides?: Partial<PiFastEditsConfig>): Promise<Map<string, ToolDef>> {
  const tools = new Map<string, ToolDef>();
  const pi = {
    registerTool: (tool: ToolDef) => tools.set(tool.name, tool),
    registerCommand: () => {},
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools: () => {},
    on: () => {},
  };
  await piFastEdits(pi as never, overrides);
  return tools;
}

describe("read_anchored full-mode caps", () => {
  async function workspaceWithLines(lineCount: number): Promise<{ cwd: string; file: string }> {
    const cwd = await mkdtemp(join(tmpdir(), "pi-fast-edits-read-caps-"));
    const file = join(cwd, "big.txt");
    await writeFile(
      file,
      Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join("\n") + "\n",
      "utf8",
    );
    return { cwd, file };
  }

  it("caps a full read at maxReadLines with a continuation notice teaching startLine", async () => {
    const { cwd } = await workspaceWithLines(20);
    const tools = await loadTools({ maxReadLines: 5 });
    const result = await tools
      .get("read_anchored")!
      .execute("1", { path: "big.txt" }, undefined, undefined, { cwd });

    const text = result.content[0].text as string;
    expect(text).toContain("Lines: 1-5 of 20");
    expect(text).toContain("[15 more lines in file. Use startLine=6 to continue.]");
    expect(text).toContain("line 5");
    expect(text).not.toContain("line 6\n");
    // details mirror the shown (capped) lines, not the whole file
    expect(result.details.lines).toHaveLength(5);

    // The continuation notice is actionable: reading from startLine=6 works.
    const rest = await tools
      .get("read_anchored")!
      .execute("1", { path: "big.txt", startLine: 6, endLine: 20 }, undefined, undefined, { cwd });
    expect(rest.content[0].text).toContain("line 6");
  });

  it("applies the byte budget before the line cap for wide lines", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-fast-edits-read-caps-"));
    // 200 lines x ~280 chars ≈ 56KB of content — the 50KB budget trips first.
    await writeFile(
      join(cwd, "wide.txt"),
      Array.from({ length: 200 }, (_, i) => `w${i}: ${"x".repeat(270)}`).join("\n") + "\n",
      "utf8",
    );
    const tools = await loadTools({ maxReadLines: 2000 });
    const result = await tools
      .get("read_anchored")!
      .execute("1", { path: "wide.txt" }, undefined, undefined, { cwd });

    const text = result.content[0].text as string;
    expect(text).toContain("more lines in file");
    expect(result.details.lines.length).toBeLessThan(200);
  });

  it("truncates a minified monster line for display and the edit mismatch error teaches the verbatim re-read", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-fast-edits-read-caps-"));
    const file = join(cwd, "min.js");
    const monster = `const x = 1;${";".repeat(600)}`;
    await writeFile(file, `${monster}\n`, "utf8");
    const tools = await loadTools();
    const result = await tools
      .get("read_anchored")!
      .execute("1", { path: "min.js" }, undefined, undefined, { cwd });

    const text = result.content[0].text as string;
    expect(text).toContain("...");
    // Displayed line is bounded by the 300-char display cap (plus anchor prefix).
    const line = text.split("\n").find((l) => l.includes("const x = 1"))!;
    expect(line.length).toBeLessThan(340);

    // Copying the truncated display text as startAnchorLine must be rejected
    // with the verbatim re-read teaching.
    const shown = result.details.lines[0].text as string;
    expect(shown.length).toBeLessThan(monster.length);
    await expect(
      tools.get("edit_anchored")!.execute(
        "1",
        {
          edits: [
            {
              type: "replace",
              path: "min.js",
              startAnchor: result.details.lines[0].anchor,
              startAnchorLine: shown,
              endAnchor: result.details.lines[0].anchor,
              endAnchorLine: shown,
              replacement: "const x = 2;",
            },
          ],
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(/display cap/);
  });
  it("anchored:false delivers verbatim over-cap lines, closing the mismatch recovery loop", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-fast-edits-read-caps-"));
    const file = join(cwd, "long.txt");
    const monster = `const x = 1;${";".repeat(600)}`;
    await writeFile(file, `${monster}\nregular line\n`, "utf8");
    const tools = await loadTools();

    // Anchored read truncates the display...
    const anchoredRead = await tools
      .get("read_anchored")!
      .execute("1", { path: "long.txt" }, undefined, undefined, { cwd });
    const shown = (anchoredRead.details as any).lines[0].text as string;
    expect(shown.length).toBeLessThan(monster.length);

    // ...the plain re-read delivers the FULL verbatim line (the taught fix)...
    const plain = await tools
      .get("read_anchored")!
      .execute("1", { path: "long.txt", anchored: false }, undefined, undefined, { cwd });
    const plainText = plain.content[0].text as string;
    expect(plainText).toContain(monster);
    expect((plain.details as any).lines[0].text).toBe(monster);
    const verbatim = (plain.details as any).lines[0].text as string;

    // ...and editing with the verbatim line now succeeds (loop closed).
    await tools.get("edit_anchored")!.execute(
      "1",
      {
        edits: [
          {
            type: "replace",
            path: "long.txt",
            startAnchor: (anchoredRead.details as any).lines[0].anchor,
            startAnchorLine: verbatim,
            endAnchor: (anchoredRead.details as any).lines[0].anchor,
            endAnchorLine: verbatim,
            replacement: "const x = 2;",
          },
        ],
      },
      undefined,
      undefined,
      { cwd },
    );
    expect(await readFile(file, "utf8")).toContain("const x = 2;");
  });
});

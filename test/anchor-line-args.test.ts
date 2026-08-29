import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import piFastEdits from "../src/index.js";
import type { PiFastEditsConfig } from "../src/types.js";
import {
  batchEditsSchema,
  deleteEditSchema,
  insertEditSchema,
  replaceEditSchema,
} from "../src/tools/schemas.js";
import { lineTextFrom } from "./anchor-helpers.js";

type ToolDef = {
  name: string;
  parameters: unknown;
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
  return mkdtemp(join(tmpdir(), "pi-fast-edits-anchor-line-"));
}

async function readAnchored(tools: Map<string, ToolDef>, cwd: string, path: string) {
  const read = await tools
    .get("read_anchored_file")!
    .execute("1", { path }, undefined, undefined, { cwd });
  const details = read.details as {
    revision: string;
    lines: Array<{ anchor: string; text: string }>;
  };
  return {
    text: read.content[0].text as string,
    revision: details.revision,
    lines: details.lines,
  };
}

describe("anchor line args", () => {
  it("strict schemas require the new line args; lenient schemas make them optional", () => {
    // Schema-builder level.
    const strictReplace = replaceEditSchema(true) as any;
    expect(strictReplace.required).toContain("startAnchorLine");
    expect(strictReplace.required).toContain("endAnchorLine");
    const lenientReplace = replaceEditSchema(false) as any;
    expect(lenientReplace.required).not.toContain("startAnchorLine");
    expect(lenientReplace.required).not.toContain("endAnchorLine");
    expect((insertEditSchema(true) as any).required).toContain("anchorLine");
    expect((insertEditSchema(false) as any).required).not.toContain("anchorLine");
    expect((deleteEditSchema(true) as any).required).toContain("startAnchorLine");
    expect((deleteEditSchema(true) as any).required).toContain("endAnchorLine");
    expect((deleteEditSchema(false) as any).required).not.toContain("startAnchorLine");
    // Batch per-edit objects inherit the same requirement, per edit kind.
    const strictBatch = batchEditsSchema(true) as any;
    const strictVariants = strictBatch.properties.edits.items.anyOf;
    expect(strictVariants).toBeDefined();
    const strictRequired = (variant: any) => variant.allOf.flatMap((t: any) => t.required ?? []);
    expect(strictRequired(strictVariants[0])).toContain("startAnchorLine");
    expect(strictRequired(strictVariants[1])).toContain("anchorLine");
    expect(strictRequired(strictVariants[2])).toContain("startAnchorLine");
    const lenientBatch = batchEditsSchema(false) as any;
    for (const variant of lenientBatch.properties.edits.items.anyOf) {
      const required = variant.allOf.flatMap((t: any) => t.required ?? []);
      expect(required).not.toContain("startAnchorLine");
      expect(required).not.toContain("anchorLine");
    }
  });

  it("registered tool definitions follow the live requireAnchorLines setting", async () => {
    const strict = await loadTools();
    const strictParams = strict.get("edit_anchored_range")!.parameters as any;
    expect(strictParams.required).toContain("startAnchorLine");
    expect(strictParams.required).toContain("endAnchorLine");
    expect((strict.get("insert_at_anchor")!.parameters as any).required).toContain("anchorLine");
    expect((strict.get("delete_anchor_range")!.parameters as any).required).toContain(
      "startAnchorLine",
    );
    expect((strict.get("preview_anchored_edit")!.parameters as any).required).toContain(
      "endAnchorLine",
    );
    // Batch: the outer object requires `edits`; strictness lives on each
    // per-edit variant.
    const strictBatchTool = strict.get("apply_anchored_edits")!.parameters as any;
    expect(strictBatchTool.required).toEqual(["edits"]);
    const strictVariant = strictBatchTool.properties.edits.items.anyOf[0];
    expect(strictVariant.allOf.flatMap((t: any) => t.required ?? [])).toContain("startAnchorLine");

    const lenient = await loadTools({ requireAnchorLines: false });
    const lenientParams = lenient.get("edit_anchored_range")!.parameters as any;
    expect(lenientParams.required).not.toContain("startAnchorLine");
    expect(lenientParams.required).not.toContain("endAnchorLine");
    expect((lenient.get("insert_at_anchor")!.parameters as any).required).not.toContain(
      "anchorLine",
    );
    const lenientBatchTool = lenient.get("apply_anchored_edits")!.parameters as any;
    expect(
      lenientBatchTool.properties.edits.items.anyOf[0].allOf.flatMap((t: any) => t.required ?? []),
    ).not.toContain("startAnchorLine");
  });

  it("strict: missing startAnchorLine rejects with a corrective message and leaves the file untouched", async () => {
    const cwd = await workspace();
    const file = join(cwd, "sample.txt");
    await writeFile(file, "alpha\nbeta\n", "utf8");
    const tools = await loadTools();
    const { lines } = await readAnchored(tools, cwd, "sample.txt");

    await expect(
      tools.get("edit_anchored_range")!.execute(
        "1",
        {
          path: "sample.txt",
          startAnchor: lines[0].anchor,
          endAnchor: lines[0].anchor,
          replacement: "ALPHA",
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(/Missing startAnchorLine: pass the exact current source line at startAnchor/);

    await expect(readFile(file, "utf8")).resolves.toBe("alpha\nbeta\n");
  });

  it("strict: correct line content succeeds", async () => {
    const cwd = await workspace();
    const file = join(cwd, "sample.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
    const tools = await loadTools();
    const { lines } = await readAnchored(tools, cwd, "sample.txt");

    const result = await tools.get("edit_anchored_range")!.execute(
      "1",
      {
        path: "sample.txt",
        startAnchor: lines[0].anchor,
        endAnchor: lines[1].anchor,
        startAnchorLine: lines[0].text,
        endAnchorLine: lines[1].text,
        replacement: "ONE",
      },
      undefined,
      undefined,
      { cwd },
    );

    expect(result.content[0].text).toMatch(/^[+-]/m);
    await expect(readFile(file, "utf8")).resolves.toBe("ONE\ngamma\n");
  });

  it("strict: a *Line value carrying the rendered `    line N` / `    lines N` suffix gets a teaching mismatch error", async () => {
    const cwd = await workspace();
    const file = join(cwd, "sample.txt");
    await writeFile(file, "alpha\nbeta\n", "utf8");
    const tools = await loadTools();
    const { lines } = await readAnchored(tools, cwd, "sample.txt");

    // grep-style singular suffix (`    line N`).
    await expect(
      tools.get("edit_anchored_range")!.execute(
        "1",
        {
          path: "sample.txt",
          startAnchor: lines[0].anchor,
          endAnchor: lines[1].anchor,
          startAnchorLine: `${lines[0].text}    line 1`,
          endAnchorLine: `${lines[1].text}    line 2`,
          replacement: "ALPHA",
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(
      /startAnchorLine mismatch for .+: the line is currently "alpha"\. Re-read the file and copy the line verbatim\. \(if you copied the rendered ` {4}line N` suffix from grep\/read output, drop it — it is positional metadata, not part of the line\)/,
    );

    // skeleton-style plural suffix (`    lines N`).
    await expect(
      tools.get("insert_at_anchor")!.execute(
        "2",
        {
          path: "sample.txt",
          anchor: lines[1].anchor,
          anchorLine: `${lines[1].text}    lines 2`,
          position: "after",
          content: "NEW",
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(/drop it — it is positional metadata, not part of the line/);

    await expect(readFile(file, "utf8")).resolves.toBe("alpha\nbeta\n");
  });

  it("strict: wrong line content rejects with a mismatch message and leaves the file untouched", async () => {
    const cwd = await workspace();
    const file = join(cwd, "sample.txt");
    await writeFile(file, "alpha\nbeta\n", "utf8");
    const tools = await loadTools();
    const { lines } = await readAnchored(tools, cwd, "sample.txt");

    await expect(
      tools.get("edit_anchored_range")!.execute(
        "1",
        {
          path: "sample.txt",
          startAnchor: lines[0].anchor,
          endAnchor: lines[1].anchor,
          startAnchorLine: "wrong content",
          endAnchorLine: lines[1].text,
          replacement: "ALPHA",
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(
      new RegExp(
        `startAnchorLine mismatch for ${lines[0].anchor}: the line is currently "alpha"\\. Re-read the file and copy the line verbatim\\.`,
      ),
    );

    await expect(readFile(file, "utf8")).resolves.toBe("alpha\nbeta\n");
  });

  it("strict: endAnchorLine and insert anchorLine are verified (missing and mismatched)", async () => {
    const cwd = await workspace();
    const file = join(cwd, "sample.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
    const tools = await loadTools();
    const { lines } = await readAnchored(tools, cwd, "sample.txt");

    // Missing endAnchorLine.
    await expect(
      tools.get("delete_anchor_range")!.execute(
        "1",
        {
          path: "sample.txt",
          startAnchor: lines[0].anchor,
          endAnchor: lines[1].anchor,
          startAnchorLine: lines[0].text,
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(/Missing endAnchorLine: pass the exact current source line at endAnchor/);

    // Mismatched endAnchorLine.
    await expect(
      tools.get("delete_anchor_range")!.execute(
        "2",
        {
          path: "sample.txt",
          startAnchor: lines[0].anchor,
          endAnchor: lines[1].anchor,
          startAnchorLine: lines[0].text,
          endAnchorLine: "stale beta",
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(/endAnchorLine mismatch/);

    // Missing insert anchorLine.
    await expect(
      tools.get("insert_at_anchor")!.execute(
        "3",
        {
          path: "sample.txt",
          anchor: lines[0].anchor,
          position: "after",
          content: "NEW",
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(/Missing anchorLine: pass the exact current source line at anchor/);

    // Correct insert anchorLine succeeds.
    const result = await tools.get("insert_at_anchor")!.execute(
      "4",
      {
        path: "sample.txt",
        anchor: lines[0].anchor,
        anchorLine: lines[0].text,
        position: "after",
        content: "NEW",
      },
      undefined,
      undefined,
      { cwd },
    );
    expect(result.content[0].text).toMatch(/^[+-]/m);
    await expect(readFile(file, "utf8")).resolves.toBe("alpha\nNEW\nbeta\ngamma\n");
  });

  it("strict: batch edits require the line args per edit and verify them before writing", async () => {
    const cwd = await workspace();
    const file = join(cwd, "sample.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
    const tools = await loadTools();
    const { lines } = await readAnchored(tools, cwd, "sample.txt");

    // Missing line args in one batch edit rejects the whole batch.
    await expect(
      tools.get("apply_anchored_edits")!.execute(
        "1",
        {
          edits: [
            {
              type: "replace",
              path: "sample.txt",
              startAnchor: lines[0].anchor,
              endAnchor: lines[0].anchor,
              replacement: "ALPHA",
            },
          ],
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(/Missing startAnchorLine/);
    await expect(readFile(file, "utf8")).resolves.toBe("alpha\nbeta\ngamma\n");

    // A mismatched line arg in one edit aborts the whole batch.
    await expect(
      tools.get("apply_anchored_edits")!.execute(
        "2",
        {
          edits: [
            {
              type: "replace",
              path: "sample.txt",
              startAnchor: lines[0].anchor,
              endAnchor: lines[0].anchor,
              startAnchorLine: lines[0].text,
              endAnchorLine: lines[0].text,
              replacement: "ALPHA",
            },
            {
              type: "delete",
              path: "sample.txt",
              startAnchor: lines[1].anchor,
              endAnchor: lines[1].anchor,
              startAnchorLine: "stale",
              endAnchorLine: lines[1].text,
            },
          ],
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(/startAnchorLine mismatch/);
    await expect(readFile(file, "utf8")).resolves.toBe("alpha\nbeta\ngamma\n");

    // All-correct batch succeeds.
    const result = await tools.get("apply_anchored_edits")!.execute(
      "3",
      {
        edits: [
          {
            type: "replace",
            path: "sample.txt",
            startAnchor: lines[0].anchor,
            endAnchor: lines[0].anchor,
            startAnchorLine: lines[0].text,
            endAnchorLine: lines[0].text,
            replacement: "ALPHA",
          },
          {
            type: "insert",
            path: "sample.txt",
            anchor: lines[2].anchor,
            anchorLine: lines[2].text,
            position: "before",
            content: "NEW",
          },
        ],
      },
      undefined,
      undefined,
      { cwd },
    );
    expect(result.content[0].text).toMatch(/^[+-]/m);
    await expect(readFile(file, "utf8")).resolves.toBe("ALPHA\nbeta\nNEW\ngamma\n");
  });

  it("lenient: bare-anchor edits succeed without line args; provided line args are still verified", async () => {
    const cwd = await workspace();
    const file = join(cwd, "sample.txt");
    await writeFile(file, "alpha\nbeta\n", "utf8");
    const tools = await loadTools({ requireAnchorLines: false });
    const { lines } = await readAnchored(tools, cwd, "sample.txt");

    // Bare anchors, no line args — succeeds.
    const ok = await tools.get("edit_anchored_range")!.execute(
      "1",
      {
        path: "sample.txt",
        startAnchor: lines[0].anchor,
        endAnchor: lines[0].anchor,
        replacement: "ALPHA",
      },
      undefined,
      undefined,
      { cwd },
    );
    expect(ok.content[0].text).toMatch(/^[+-]/m);

    // Wrong provided content still rejects.
    await expect(
      tools.get("edit_anchored_range")!.execute(
        "2",
        {
          path: "sample.txt",
          startAnchor: lines[1].anchor,
          endAnchor: lines[1].anchor,
          startAnchorLine: "wrong",
          endAnchorLine: "wrong",
          replacement: "BETA",
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(/startAnchorLine mismatch/);

    // The rejected edit must not have written anything.
    await expect(readFile(file, "utf8")).resolves.toBe("ALPHA\nbeta\n");
  });

  it("lineTextFrom extracts the verbatim line from rendered grep-style output", () => {
    const output =
      "1 file matched.\n\nFile: src/a.ts\nRevision: abc123\n\nApple§ export function alpha() {    line 1\nBrave§   return 1;    line 2\n";
    expect(lineTextFrom(output, "export function alpha() {")).toBe("export function alpha() {");
    expect(lineTextFrom(output, "  return 1;")).toBe("  return 1;");
    expect(() => lineTextFrom(output, "missing")).toThrow(/No anchored line found/);
  });

  it("rejects anchor-marked text in replacement and content by default", async () => {
    const cwd = await workspace();
    const file = join(cwd, "marked.ts");
    await writeFile(file, "one\ntwo\nthree\n", "utf8");
    const tools = await loadTools();
    const read = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "marked.ts" }, undefined, undefined, { cwd });
    const lines = read.details.lines as Array<{ anchor: string; text: string }>;
    const first = lines[0];

    // Model echoes a rendered anchored line into replacement → rejected.
    await expect(
      tools.get("edit_anchored_range")!.execute(
        "2",
        {
          path: "marked.ts",
          startAnchor: first.anchor,
          endAnchor: first.anchor,
          replacement: `Apple§ one\nplain`,
          startAnchorLine: first.text,
          endAnchorLine: first.text,
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(/anchor-marked content/);
    await expect(readFile(file, "utf8")).resolves.toBe("one\ntwo\nthree\n");

    // Insert path: same rejection, same corrective guidance.
    await expect(
      tools.get("insert_at_anchor")!.execute(
        "3",
        {
          path: "marked.ts",
          anchor: first.anchor,
          position: "before",
          content: "fine line\nFoxtrot2§ suffixed anchor echo",
          anchorLine: first.text,
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(/allowAnchoredLines: true/);

    // CRLF-embedded anchored line is caught too.
    await expect(
      tools.get("edit_anchored_range")!.execute(
        "4",
        {
          path: "marked.ts",
          startAnchor: first.anchor,
          endAnchor: first.anchor,
          replacement: "ok\r\nBrave§ two",
          startAnchorLine: first.text,
          endAnchorLine: first.text,
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(/anchor-marked content/);
  });

  it("allowAnchoredLines: true accepts genuine § content verbatim", async () => {
    const cwd = await workspace();
    const file = join(cwd, "genuine.md");
    await writeFile(file, "title\n", "utf8");
    const tools = await loadTools();
    const read = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "genuine.md" }, undefined, undefined, { cwd });
    const first = (read.details.lines as Array<{ anchor: string; text: string }>)[0];

    const result = await tools.get("edit_anchored_range")!.execute(
      "2",
      {
        path: "genuine.md",
        startAnchor: first.anchor,
        endAnchor: first.anchor,
        replacement: "Apple§ one\nplain",
        startAnchorLine: first.text,
        endAnchorLine: first.text,
        allowAnchoredLines: true,
      },
      undefined,
      undefined,
      { cwd },
    );
    expect(result.content[0].text).toBeTruthy();
    await expect(readFile(file, "utf8")).resolves.toBe("Apple§ one\nplain\n");
  });

  it("batch rejects as a whole when one edit carries anchor-marked text", async () => {
    const cwd = await workspace();
    const file = join(cwd, "batch.ts");
    await writeFile(file, "one\ntwo\n", "utf8");
    const tools = await loadTools();
    const read = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "batch.ts" }, undefined, undefined, { cwd });
    const lines = read.details.lines as Array<{ anchor: string; text: string }>;

    await expect(
      tools.get("apply_anchored_edits")!.execute(
        "2",
        {
          edits: [
            {
              type: "replace",
              path: "batch.ts",
              startAnchor: lines[0].anchor,
              endAnchor: lines[0].anchor,
              replacement: "clean",
              startAnchorLine: lines[0].text,
              endAnchorLine: lines[0].text,
            },
            {
              type: "insert",
              path: "batch.ts",
              anchor: lines[1].anchor,
              position: "after",
              content: "Echo§ echoed",
              anchorLine: lines[1].text,
            },
          ],
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(/anchor-marked content/);
    await expect(readFile(file, "utf8")).resolves.toBe("one\ntwo\n");
  });

  it("blank source lines accept an empty anchorLine value", async () => {
    // A blank line is a valid edit target; its verbatim content is the empty
    // string (dirac's blank-coordinate case). The schema requires the arg but
    // an empty string must pass verification, not be treated as missing.
    const cwd = await workspace();
    const file = join(cwd, "blank.ts");
    await writeFile(file, "first\n\nlast\n", "utf8");
    const tools = await loadTools();
    const read = await tools
      .get("read_anchored_file")!
      .execute("1", { path: "blank.ts" }, undefined, undefined, { cwd });
    const lines = read.details.lines as Array<{ anchor: string; text: string }>;
    const blank = lines.find((l) => l.text === "")!;
    expect(blank).toBeDefined();

    // Insert after the blank line — empty anchorLine verifies against "".
    const result = await tools.get("insert_at_anchor")!.execute(
      "2",
      {
        path: "blank.ts",
        anchor: blank.anchor,
        position: "after",
        content: "inserted",
        anchorLine: "",
      },
      undefined,
      undefined,
      { cwd },
    );
    expect(result.content[0].text).toBeTruthy();
    const after = await readFile(file, "utf8");
    expect(after).toBe("first\n\ninserted\nlast\n");
  });
});

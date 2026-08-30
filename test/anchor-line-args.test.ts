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
    expect((lenient.get("preview_anchored_edit")!.parameters as any).required).not.toContain(
      "endAnchorLine",
    );
    const lenientBatchTool = lenient.get("apply_anchored_edits")!.parameters as any;
    expect(
      lenientBatchTool.properties.edits.items.anyOf[0].allOf.flatMap((t: any) => t.required ?? []),
    ).not.toContain("startAnchorLine");
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


  it("lineTextFrom extracts the verbatim line from rendered grep-style output", () => {
    const output =
      "1 file matched.\n\nFile: src/a.ts\nRevision: abc123\n\nApple§ export function alpha() {    line 1\nBrave§   return 1;    line 2\n";
    expect(lineTextFrom(output, "export function alpha() {")).toBe("export function alpha() {");
    expect(lineTextFrom(output, "  return 1;")).toBe("  return 1;");
    expect(() => lineTextFrom(output, "missing")).toThrow(/No anchored line found/);
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

});

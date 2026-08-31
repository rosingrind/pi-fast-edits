import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import piFastEdits from "../src/index.js";
import { runRg, type RgHit } from "../src/fs/rg-search.js";

// Mock rg so drift (content changed between rg's scan and the anchor-state
// read) is deterministic: call #1 reports hits for the OLD content, later
// calls report hits for the CURRENT content.
vi.mock("../src/fs/rg-search.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/fs/rg-search.js")>();
  return { ...mod, runRg: vi.fn() };
});
vi.mock("../src/fs/rg-resolver.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/fs/rg-resolver.js")>();
  return { ...mod, resolveRg: vi.fn(async () => "/usr/bin/rg") };
});

const runRgMock = vi.mocked(runRg);

type ToolDef = {
  name: string;
  execute: (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) => Promise<any>;
};

async function loadTools(): Promise<Map<string, ToolDef>> {
  const tools = new Map<string, ToolDef>();
  const pi = {
    registerTool: (tool: ToolDef) => tools.set(tool.name, tool),
    registerCommand: () => {},
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools: () => {},
    on: () => {},
  };
  await piFastEdits(pi as never);
  return tools;
}

const DRIFT_NOTICE = "file changed during search";

describe("grep drift re-scan", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "pi-fast-edits-drift-"));
    // On-disk content (what the anchor-state read sees).
    await writeFile(join(cwd, "drift.txt"), "beta\nalpha\n", "utf8");
    runRgMock.mockReset();
  });

  it("re-scans a drifted file once and returns fresh verified coordinates", async () => {
    const absPath = join(cwd, "drift.txt");
    // Call 1 (workspace scan): hit reflects the OLD content (beta was line 2).
    // Call 2 (drift re-scan of the single file): hit reflects the CURRENT
    // content (beta is line 1).
    const staleHit: RgHit = { file: absPath, lineNo: 2, content: "beta", isMatch: true };
    const freshHit: RgHit = { file: absPath, lineNo: 1, content: "beta", isMatch: true };
    runRgMock.mockImplementation((_rgPath, args) => {
      const scoped = args.at(-1) === absPath;
      return Promise.resolve(scoped ? [freshHit] : [staleHit]);
    });

    const tools = await loadTools();
    const result = await tools
      .get("grep_anchored")!
      .execute("1", { pattern: "beta" }, undefined, undefined, { cwd });

    const text = result.content[0].text as string;
    expect(text).toContain("File: drift.txt");
    expect(text).not.toContain(DRIFT_NOTICE);
    // Fresh coordinates: beta is at line 1 now — the anchor must map to it.
    expect(runRgMock).toHaveBeenCalledTimes(2);
    const betaAnchor = /([A-Za-z]+)§ beta/.exec(text)?.[1];
    expect(betaAnchor).toBeTruthy();
    expect(text).toContain(`${betaAnchor}§ beta    line 1`);
  });

  it("reports 'no longer matches' when the re-scan is stable but empty", async () => {
    const absPath = join(cwd, "drift.txt");
    // Call 1 (workspace scan): stale hit for old content. Call 2 (re-scan):
    // stable but empty — the file changed and the pattern no longer matches.
    const staleHit: RgHit = { file: absPath, lineNo: 2, content: "beta", isMatch: true };
    runRgMock.mockImplementation((_rgPath, args) => {
      const scoped = args.at(-1) === absPath;
      return Promise.resolve(scoped ? [] : [staleHit]);
    });

    const tools = await loadTools();
    const result = await tools
      .get("grep_anchored")!
      .execute("1", { pattern: "beta" }, undefined, undefined, { cwd });

    const text = result.content[0].text as string;
    expect(text).toContain("no longer matches this file");
    expect(text).not.toContain(DRIFT_NOTICE);
  });

  it("falls back to the drift notice when the re-scan drifts too", async () => {
    const absPath = join(cwd, "drift.txt");
    // Every scan reports the stale line — the file keeps changing.
    const staleHit: RgHit = { file: absPath, lineNo: 2, content: "beta", isMatch: true };
    runRgMock.mockImplementation(() => Promise.resolve([staleHit]));

    const tools = await loadTools();
    const result = await tools
      .get("grep_anchored")!
      .execute("1", { pattern: "beta" }, undefined, undefined, { cwd });

    const text = result.content[0].text as string;
    expect(text).toContain(DRIFT_NOTICE);
  });
});

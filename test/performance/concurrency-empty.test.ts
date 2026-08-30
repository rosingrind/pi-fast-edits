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
    it("read_anchored on an empty file reports zero lines and a revision", async () => {
      const cwd = await workspace();
      const file = join(cwd, "empty-read.txt");
      await writeFile(file, "", "utf8");
      const tools = await loadTools();

      const read = await tools
        .get("read_anchored")!
        .execute("0", { path: "empty-read.txt" }, undefined, undefined, { cwd });

      expect(read.details.mode).toBe("full");
      expect(read.details.lines).toEqual([]);
      expect(typeof read.details.revision).toBe("string");
      expect(read.content[0].text).toContain("Lines: 0");
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
          .get("read_anchored")!
          .execute("1", { path: "a.txt" }, undefined, undefined, { cwd });
        const rB = await tools
          .get("read_anchored")!
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
            tools.get("edit_anchored")!.execute(
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
});

import { mkdtemp, readFile, rm, writeFile, chmod, readdir, mkdir } from "node:fs/promises";
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
  return mkdtemp(join(tmpdir(), "pi-fast-edits-io-"));
}

describe("I/O errors on the reconcile/read path", () => {
  it("fails cleanly when the file is deleted between read and edit", async () => {
    const cwd = await workspace();
    const file = join(cwd, "disappear.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
    const tools = await loadTools();

    const read = await tools
      .get("read_anchored")!
      .execute("1", { path: "disappear.txt" }, undefined, undefined, { cwd });
    const revision = read.details.revision as string;

    // Remove the file behind the tools' back.
    await rm(file, { force: true });

    // Editing with the (now unusable) revision must fail without recreating the file.
    await expect(
      tools.get("edit_anchored")!.execute(
        "2",
        {
          edits: [
            {
              type: "replace",
              path: "disappear.txt",
              startAnchor: "Apple",
              endAnchor: "Apple",
              replacement: "ALPHA\n",
              expectedRevision: revision,
            },
          ],
        },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(/ENOENT|no such file/i);

    // The failed edit must not recreate the file.
    await expect(readFile(file, "utf8")).rejects.toThrow(/ENOENT|no such file/i);
  });

  it("fails cleanly when a read target is deleted and re-read", async () => {
    const cwd = await workspace();
    const file = join(cwd, "gone.txt");
    await writeFile(file, "alpha\n", "utf8");
    const tools = await loadTools();

    // First read populates the session cache.
    await tools.get("read_anchored")!.execute("1", { path: "gone.txt" }, undefined, undefined, {
      cwd,
    });

    await rm(file, { force: true });

    // Re-reading a deleted file must surface an I/O error, not stale cached anchors.
    await expect(
      tools.get("read_anchored")!.execute("2", { path: "gone.txt" }, undefined, undefined, {
        cwd,
      }),
    ).rejects.toThrow(/ENOENT|no such file/i);
  });
});

// chmod-based write-protection tests only fail writes when running as a
// non-root user; root can write into 0o555 directories, so skip there.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("atomic-write failure cleanup", () => {
  it.skipIf(isRoot)(
    "atomic write failure leaves original file intact and cleans up temp files",
    async () => {
      const cwd = await workspace();
      const dir = join(cwd, "readonly-dir");
      await mkdir(dir, { recursive: true });
      const file = join(dir, "atomic.txt");
      await writeFile(file, "original content\n", "utf8");

      // Make directory read-only so atomic write (temp file + rename) fails.
      await chmod(dir, 0o555);
      try {
        const tools = await loadTools();

        // Read to get anchors.
        await tools
          .get("read_anchored")!
          .execute("1", { path: "readonly-dir/atomic.txt" }, undefined, undefined, { cwd });

        // Edit should fail because atomic write can't create temp file.
        await expect(
          tools.get("edit_anchored")!.execute(
            "2",
            {
              edits: [
                {
                  type: "replace",
                  path: "readonly-dir/atomic.txt",
                  startAnchor: "Apple",
                  endAnchor: "Apple",
                  replacement: "CHANGED\n",
                },
              ],
            },
            undefined,
            undefined,
            { cwd },
          ),
        ).rejects.toThrow();

        // Original file must be unchanged.
        expect(await readFile(file, "utf8")).toBe("original content\n");

        // No temp files should be left behind.
        const entries = await readdir(dir);
        const tempFiles = entries.filter((e: string) => e.startsWith("."));
        expect(tempFiles).toHaveLength(0);
      } finally {
        await chmod(dir, 0o755).catch(() => {});
      }
    },
  );
});

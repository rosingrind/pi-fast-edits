import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, writeFile, readdir, rm, mkdir, chmod, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { atomicWriteFile } from "../src/fs/atomic-write.js";

describe("atomicWriteFile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `atomic-write-test-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      const files = await readdir(tmpDir);
      for (const f of files) {
        await rm(join(tmpDir, f), { recursive: true, force: true });
      }
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Directory already gone; nothing to clean up.
    }
  });

  it("writes content to a new file", async () => {
    const filePath = join(tmpDir, "new.txt");
    await atomicWriteFile(filePath, "hello\n");
    await expect(readFile(filePath, "utf8")).resolves.toBe("hello\n");
  });

  it("overwrites an existing file", async () => {
    const filePath = join(tmpDir, "existing.txt");
    await writeFile(filePath, "old\n", "utf8");
    await atomicWriteFile(filePath, "new\n");
    await expect(readFile(filePath, "utf8")).resolves.toBe("new\n");
  });

  it("creates parent directories", async () => {
    const filePath = join(tmpDir, "a", "b", "c.txt");
    await atomicWriteFile(filePath, "data\n");
    await expect(readFile(filePath, "utf8")).resolves.toBe("data\n");
  });

  it("preserves the file mode after a rewrite", async () => {
    const filePath = join(tmpDir, "mode.txt");
    await writeFile(filePath, "old\n", "utf8");
    await chmod(filePath, 0o600);
    await atomicWriteFile(filePath, "new\n");
    const st = await stat(filePath);
    expect(st.mode & 0o777).toBe(0o600);
  });
});

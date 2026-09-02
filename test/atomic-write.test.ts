import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readFile,
  writeFile,
  readdir,
  rm,
  mkdir,
  chmod,
  stat,
  lstat,
  symlink,
} from "node:fs/promises";
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

  it("writes through a symlink, preserving the link and updating its target", async () => {
    const realFile = join(tmpDir, "real.json");
    const link = join(tmpDir, "config-link.json");
    await writeFile(realFile, "old\n", "utf8");
    await symlink(realFile, link);

    await atomicWriteFile(link, "new\n");

    // The symlink must still be a symlink — not replaced by a regular file.
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    // Reads through the link see the new content...
    await expect(readFile(link, "utf8")).resolves.toBe("new\n");
    // ...and the real target was updated.
    await expect(readFile(realFile, "utf8")).resolves.toBe("new\n");
  });

  it("writes through a cross-directory symlink (stowed-config shape)", async () => {
    const targetDir = join(tmpDir, "stowed");
    const linkDir = join(tmpDir, "agent");
    await mkdir(targetDir, { recursive: true });
    await mkdir(linkDir, { recursive: true });
    const realFile = join(targetDir, "pi-fast-edits.json");
    const link = join(linkDir, "pi-fast-edits.json");
    await writeFile(realFile, "old\n", "utf8");
    await symlink(realFile, link);

    await atomicWriteFile(link, "new\n");

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    await expect(readFile(realFile, "utf8")).resolves.toBe("new\n");
    // No temp droppings in either directory.
    await expect(readdir(linkDir)).resolves.toEqual(["pi-fast-edits.json"]);
    await expect(readdir(targetDir)).resolves.toEqual(["pi-fast-edits.json"]);
  });
});

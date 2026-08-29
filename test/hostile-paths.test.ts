import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { atomicWriteFile } from "../src/fs/atomic-write.js";
import { resolveWorkspacePath, assertRegularFile } from "../src/fs/path-safety.js";

describe("hostile path inputs (write-path regression guard)", () => {
  it("atomic write creates deeply nested unicode/space parent dirs and round-trips content", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hostile-"));
    const deep = join(cwd, "a b", "café ☕", "nested..ok", "deeper", "file.txt");
    await atomicWriteFile(deep, "héllo wörld\nline2 ✓\n");
    const written = await import("node:fs/promises").then((m) => m.readFile(deep, "utf8"));
    expect(written).toBe("héllo wörld\nline2 ✓\n");
  });

  it("atomic write round-trips content exactly through the temp+rename dance", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hostile-"));
    const file = join(cwd, "target.txt");
    for (const content of [
      "",
      "no newline",
      "with\nnewlines\n\n",
      "﻿bom-ish",
      "x".repeat(10_000),
    ]) {
      await atomicWriteFile(file, content);
      const written = await import("node:fs/promises").then((m) => m.readFile(file, "utf8"));
      expect(written).toBe(content);
    }
  });

  it("failed writes leave no stray temp files in the target directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hostile-"));
    const dir = join(cwd, "sub");
    await mkdir(dir);
    // Writing to a directory path must fail cleanly.
    await expect(atomicWriteFile(dir, "nope")).rejects.toThrow();
    const entries = await readdir(cwd);
    // Only 'sub' exists — no temp files leaked next to the target.
    expect(entries).toEqual(["sub"]);
  });

  it("resolveWorkspacePath rejects traversal outside the workspace", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hostile-"));
    await expect(resolveWorkspacePath(cwd, "../outside.txt")).rejects.toThrow(/outside workspace/);
    await expect(resolveWorkspacePath(cwd, "/etc/hosts")).rejects.toThrow(/outside workspace/);
    await expect(resolveWorkspacePath(cwd, "a/../../b")).rejects.toThrow(/outside workspace/);
  });

  it("resolveWorkspacePath normalizes a leading @ and nested traversal that stays inside", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hostile-"));
    await mkdir(join(cwd, "d"), { recursive: true });
    await writeFile(join(cwd, "d", "f.txt"), "x");
    const resolved = await resolveWorkspacePath(cwd, "@d/../d/f.txt");
    expect(resolved).toBe(join(cwd, "d", "f.txt"));
  });

  it("directory and trailing-separator targets fail assertRegularFile cleanly", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hostile-"));
    const dir = join(cwd, "sub");
    await mkdir(dir);
    await expect(assertRegularFile(dir)).rejects.toThrow(/not a regular file/);
    // Trailing separator resolves to the directory itself → same clean failure.
    await expect(resolveWorkspacePath(cwd, "sub/")).resolves.toBe(dir);
    await expect(assertRegularFile(await resolveWorkspacePath(cwd, "sub/"))).rejects.toThrow(
      /not a regular file/,
    );
  });

  it("dash-prefixed and dot-file names are ordinary files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hostile-"));
    for (const name of ["-not-a-flag", ".hidden", ".env.local"]) {
      const file = join(cwd, name);
      await atomicWriteFile(file, "content");
      const info = await stat(file);
      expect(info.isFile()).toBe(true);
    }
  });

  it("overwriting an existing file preserves no temp residue on either failure or success", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hostile-"));
    const file = join(cwd, "f.txt");
    await atomicWriteFile(file, "v1");
    await atomicWriteFile(file, "v2");
    const entries = await readdir(cwd);
    expect(entries).toEqual(["f.txt"]);
    const written = await import("node:fs/promises").then((m) => m.readFile(file, "utf8"));
    expect(written).toBe("v2");
  });
});

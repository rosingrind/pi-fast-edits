import { mkdtemp, writeFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { assertRegularFile, isProtectedPath, resolveWorkspacePath } from "../src/fs/path-safety.js";
import { DEFAULT_CONFIG } from "../src/config.js";

describe("resolveWorkspacePath", () => {
  it("rejects ../ traversal", async () => {
    await expect(resolveWorkspacePath("/workspace", "../etc/passwd")).rejects.toThrow();
    await expect(resolveWorkspacePath("/workspace", "subdir/../../etc/passwd")).rejects.toThrow();
  });

  it("rejects absolute paths outside the workspace", async () => {
    await expect(resolveWorkspacePath("/workspace", "/etc/passwd")).rejects.toThrow();
    await expect(resolveWorkspacePath("/workspace", "/etc")).rejects.toThrow();
  });

  it("accepts nested in-workspace paths", async () => {
    await expect(resolveWorkspacePath("/workspace", "subdir/nested/file.txt")).resolves.toBe(
      "/workspace/subdir/nested/file.txt",
    );
  });

  it("accepts simple in-workspace paths", async () => {
    await expect(resolveWorkspacePath("/workspace", "file.txt")).resolves.toBe(
      "/workspace/file.txt",
    );
  });

  it("accepts absolute paths that resolve inside the workspace", async () => {
    // The security boundary is *outside-workspace access*, so absolute paths
    // that stay within the workspace are permitted.
    await expect(resolveWorkspacePath("/workspace", "/workspace/file.txt")).resolves.toBe(
      "/workspace/file.txt",
    );
  });

  it("rejects a symlink pointing outside the workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pfe-symlink-"));
    const outside = join(await mkdtemp(join(tmpdir(), "pfe-outside-")), "target.txt");
    await writeFile(outside, "secret\n", "utf8");
    const link = join(dir, "link-to-outside.txt");
    await symlink(outside, link);

    await expect(resolveWorkspacePath(dir, "link-to-outside.txt")).rejects.toThrow(
      /outside workspace/,
    );
  });
});

describe("assertRegularFile", () => {
  it("accepts a regular file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pfe-reg-"));
    const file = join(dir, "a.txt");
    await writeFile(file, "hi\n", "utf8");
    await expect(assertRegularFile(file)).resolves.toBeUndefined();
  });

  it("rejects a directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pfe-dir-"));
    await mkdir(join(dir, "subdir"));
    await expect(assertRegularFile(join(dir, "subdir"))).rejects.toThrow(/not a regular file/);
  });

  it("rejects a symlink pointing to a directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pfe-linkdir-"));
    const target = join(dir, "subdir");
    await mkdir(target, { recursive: true });
    const link = join(dir, "link-to-dir");
    await symlink(target, link);
    await expect(assertRegularFile(link)).rejects.toThrow(/not a regular file/);
  });
});

describe("isProtectedPath", () => {
  it("matches protected defaults", () => {
    const paths = DEFAULT_CONFIG.protectedPaths;
    expect(isProtectedPath(".env", paths)).toBe(true);
    expect(isProtectedPath(".env.local", paths)).toBe(true);
    expect(isProtectedPath(".git/config", paths)).toBe(true);
    expect(isProtectedPath("package-lock.json", paths)).toBe(true);
    expect(isProtectedPath("migrations/001.js", paths)).toBe(true);
  });

  it("does not match unprotected paths", () => {
    const paths = DEFAULT_CONFIG.protectedPaths;
    expect(isProtectedPath("src/index.ts", paths)).toBe(false);
    expect(isProtectedPath("not-env.txt", paths)).toBe(false);
  });

  it("protected-path check is case-sensitive (current behavior documented)", () => {
    // isProtectedPath does an exact/glob match, case-sensitively.
    expect(isProtectedPath(".ENV", [".env"])).toBe(false);
    expect(isProtectedPath("Package-lock.json", ["package-lock.json"])).toBe(false);
    // This is a known limitation on case-insensitive filesystems.
  });
});

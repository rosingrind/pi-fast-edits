import { mkdir, writeFile, chmod, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

describe("resolveRg", () => {
  const realProbe = (cmd: string) => Promise.resolve(cmd === "PATH_RG");
  let origDir: string | undefined;
  let dir: string;

  beforeEach(async () => {
    origDir = process.env.PI_CODING_AGENT_DIR;
    dir = await mkdtemp(join(tmpdir(), "rg-resolver-"));
    process.env.PI_CODING_AGENT_DIR = dir;
    // Reset the module-level cache between tests.
    vi.resetModules();
  });
  afterEach(() => {
    if (origDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = origDir;
  });

  it("prefers the pi tool cache over PATH", async () => {
    const binDir = join(dir, "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, "rg"), "#!/bin/sh\nexit 0\n");
    await chmod(join(binDir, "rg"), 0o755);
    const { resolveRg } = await import("../src/fs/rg-resolver.js");
    const seen: string[] = [];
    const result = await resolveRg(async (cmd) => {
      seen.push(cmd);
      return true;
    });
    expect(seen[0]).toBe(join(binDir, "rg"));
    expect(result).toBe(join(binDir, "rg"));
  });

  it("falls back to PATH rg when cache is absent", async () => {
    const { resolveRg } = await import("../src/fs/rg-resolver.js");
    const seen: string[] = [];
    const result = await resolveRg(async (cmd) => {
      seen.push(cmd);
      return cmd === "rg";
    });
    expect(seen).toEqual([join(dir, "bin", "rg"), "rg"]);
    expect(result).toBe("rg");
  });

  it("returns null when nothing probes true", async () => {
    const { resolveRg } = await import("../src/fs/rg-resolver.js");
    expect(await resolveRg(async () => false)).toBeNull();
  });

  it("skips a non-executable cache file", async () => {
    const binDir = join(dir, "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, "rg"), "not executable");
    const { resolveRg } = await import("../src/fs/rg-resolver.js");
    const seen: string[] = [];
    const result = await resolveRg(async (cmd) => {
      seen.push(cmd);
      return true;
    });
    expect(seen).toEqual(["rg"]);
    expect(result).toBe("rg");
  });
});

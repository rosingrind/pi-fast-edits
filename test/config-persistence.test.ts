import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.js";
import { loadConfig, saveConfig } from "../src/config-persistence.js";

const ORIG_ENV = process.env.PI_CODING_AGENT_DIR;

describe("config persistence round-trip", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-fast-edits-roundtrip-"));
    process.env.PI_CODING_AGENT_DIR = dir;
  });

  afterEach(() => {
    process.env.PI_CODING_AGENT_DIR = ORIG_ENV;
    rmSync(dir, { recursive: true, force: true });
  });

  it("load -> mutate -> save -> load round-trips the config", async () => {
    // Fresh dir → no pi-fast-edits.json → falls back to defaults
    expect(await loadConfig()).toEqual(DEFAULT_CONFIG);

    const mutated = {
      ...DEFAULT_CONFIG,
      confirmation: "never" as const,
      protectedPaths: ["custom.txt", ".git/**"],
    };

    await saveConfig(mutated);
    expect(await loadConfig()).toEqual(mutated);
  });
});

describe("config sanitization", () => {
  let dir: string;
  const ORIG = process.env.PI_CODING_AGENT_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-fast-edits-sanitize-"));
    process.env.PI_CODING_AGENT_DIR = dir;
  });

  afterEach(() => {
    process.env.PI_CODING_AGENT_DIR = ORIG;
    rmSync(dir, { recursive: true, force: true });
  });

  it("wrong-typed fields fall back to defaults instead of reaching runtime", async () => {
    writeFileSync(
      join(dir, "pi-fast-edits.json"),
      JSON.stringify({
        suppressNativeTools: "yes",
        confirmation: 42,
        requireAnchorLines: "true",
        maxRangeReadLines: "400",
        maxReadLines: -5,
        protectedPaths: [".env", 123, null, ""],
      }),
      "utf8",
    );
    const config = await loadConfig();
    // Scalar junk falls back to defaults; a present, well-typed array keeps
    // its valid entries (preserving user intent) with junk entries dropped.
    expect(config).toEqual({ ...DEFAULT_CONFIG, protectedPaths: [".env"] });
  });

  it("well-typed fields survive sanitization", async () => {
    writeFileSync(
      join(dir, "pi-fast-edits.json"),
      JSON.stringify({
        suppressNativeTools: true,
        confirmation: "always",
        requireAnchorLines: false,
        maxRangeReadLines: 120.9,
        maxReadLines: 500,
        protectedPaths: [".env", "secrets/**", ""],
      }),
      "utf8",
    );
    const config = await loadConfig();
    expect(config.suppressNativeTools).toBe(true);
    expect(config.confirmation).toBe("always");
    expect(config.requireAnchorLines).toBe(false);
    expect(config.maxRangeReadLines).toBe(120); // floored
    expect(config.maxReadLines).toBe(500);
    expect(config.protectedPaths).toEqual([".env", "secrets/**"]);
  });
});

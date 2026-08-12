import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
      maxFullReadBytes: 123_456,
      maxFullReadLines: 777,
      confirmation: "never" as const,
      protectedPaths: ["custom.txt", ".git/**"],
    };

    await saveConfig(mutated);
    expect(await loadConfig()).toEqual(mutated);
  });
});

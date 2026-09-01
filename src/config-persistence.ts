import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, parseConfirmationMode } from "./config.js";
import { atomicWriteFile } from "./fs/atomic-write.js";
import type { PiFastEditsConfig } from "./types.js";

function getConfigPath(): string {
  return join(getAgentDir(), "pi-fast-edits.json");
}

export async function loadConfig(): Promise<PiFastEditsConfig> {
  try {
    const path = getConfigPath();
    if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
    const content = readFileSync(path, "utf-8");
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return sanitizeConfig(parsed);
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

/**
 * Keep only well-typed fields from a parsed config file; everything else
 * falls back to its default. A hand-edited config must never smuggle a
 * wrong-typed value (e.g. a string where a number belongs) into runtime.
 */
function sanitizeConfig(parsed: Record<string, unknown>): PiFastEditsConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  if (typeof parsed.overrideBuiltInEditTools === "boolean") {
    config.overrideBuiltInEditTools = parsed.overrideBuiltInEditTools;
  }
  if (typeof parsed.confirmation === "string") {
    const mode = parseConfirmationMode(parsed.confirmation);
    if (mode) config.confirmation = mode;
  }
  if (typeof parsed.requireAnchorLines === "boolean") {
    config.requireAnchorLines = parsed.requireAnchorLines;
  }
  if (typeof parsed.suppressNativeTools === "boolean") {
    config.suppressNativeTools = parsed.suppressNativeTools;
  }
  for (const key of ["maxRangeReadLines", "maxReadLines"] as const) {
    const value = parsed[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      config[key] = Math.floor(value);
    }
  }
  if (Array.isArray(parsed.protectedPaths)) {
    config.protectedPaths = parsed.protectedPaths.filter(
      (entry): entry is string => typeof entry === "string" && entry.length > 0,
    );
  }
  return config;
}

/** Persist the config; resolves false (with a logged reason) when the write fails. */
export async function saveConfig(config: PiFastEditsConfig): Promise<boolean> {
  try {
    await atomicWriteFile(getConfigPath(), JSON.stringify(config, null, 2));
    return true;
  } catch (error) {
    console.error("Failed to save pi-fast-edits config:", error);
    return false;
  }
}

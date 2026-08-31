import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "./config.js";
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
    const parsed = JSON.parse(content) as Partial<PiFastEditsConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      protectedPaths: [...(parsed.protectedPaths ?? DEFAULT_CONFIG.protectedPaths)],
    } as PiFastEditsConfig;
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export async function saveConfig(config: PiFastEditsConfig): Promise<void> {
  try {
    await atomicWriteFile(getConfigPath(), JSON.stringify(config, null, 2));
  } catch (error) {
    console.error("Failed to save pi-fast-edits config:", error);
  }
}

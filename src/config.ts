import type { ConfirmationMode, PiFastEditsConfig } from "./types.js";

export const DEFAULT_CONFIG: PiFastEditsConfig = {
  confirmation: "protected-paths",
  requireAnchorLines: true,
  maxRangeReadLines: 400,
  maxReadLines: 2000,
  suppressNativeTools: false,
  protectedPaths: [
    ".env",
    ".env.*",
    ".git",
    ".git/**",
    ".github/workflows/**",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "migrations/**",
  ],
};

export function parseConfirmationMode(value: string): ConfirmationMode | undefined {
  if (value === "always" || value === "protected-paths" || value === "never") return value;
  return undefined;
}

export function formatConfig(config: PiFastEditsConfig): string {
  return JSON.stringify(config, null, 2);
}

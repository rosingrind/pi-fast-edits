import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const PROBE_TIMEOUT_MS = 5000;

export type Probe = (cmd: string, args: string[], timeoutMs?: number) => Promise<boolean>;

function defaultProbe(cmd: string, args: string[], timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "ignore"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch (error) {
    // A cache entry that is missing entirely is still probed — the probe's
    // spawn itself distinguishes a missing binary from a working one. Only an
    // existing file that isn't executable should be skipped.
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

let cached: string | null | undefined;

/**
 * Resolve the ripgrep binary: pi's own tool cache first (~/.pi/agent/bin/rg,
 * installed by pi's built-in grep tool), then PATH. Returns null when neither
 * passes a `--version` probe; callers must degrade gracefully.
 */
export async function resolveRg(probe: Probe = defaultProbe): Promise<string | null> {
  if (cached !== undefined) return cached;
  const candidates: string[] = [];
  try {
    candidates.push(join(getAgentDir(), "bin", "rg"));
  } catch {
    // No agent dir available — PATH only.
  }
  candidates.push("rg");
  for (const candidate of candidates) {
    if (candidate.includes("/") && !(await isExecutable(candidate))) continue;
    if (await probe(candidate, ["--version"], PROBE_TIMEOUT_MS)) {
      cached = candidate;
      return cached;
    }
  }
  cached = null;
  return cached;
}

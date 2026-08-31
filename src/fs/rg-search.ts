import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const MAX_TOTAL_HITS = 500;

export type RgHit = {
  file: string;
  lineNo: number;
  content: string;
  isMatch: boolean;
};

/** Parse one rg --json output line. Returns null for begin/end/malformed lines. */
export function parseRgLine(line: string): RgHit | null {
  if (!line) return null;
  let parsed: {
    type?: string;
    data?: {
      path?: { text?: string };
      line_number?: number;
      lines?: { text?: string };
    };
  };
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (
    (parsed.type !== "match" && parsed.type !== "context") ||
    typeof parsed.data?.path?.text !== "string" ||
    typeof parsed.data?.line_number !== "number" ||
    typeof parsed.data?.lines?.text !== "string"
  ) {
    return null;
  }
  return {
    file: parsed.data.path.text,
    lineNo: parsed.data.line_number,
    content: parsed.data.lines.text,
    isMatch: parsed.type === "match",
  };
}

/**
 * Run rg with the given args and collect hit events. stdin is ignored: with no
 * path arg rg reads piped stdin and blocks forever. Resolves on exit code 0
 * (hits) or 1 (no matches); rejects on spawn errors and other exit codes.
 * Kills rg once MAX_TOTAL_HITS matches have been collected.
 */
export function runRg(rgPath: string, args: string[], signal?: AbortSignal): Promise<RgHit[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const hits: RgHit[] = [];
    let stderr = "";
    let settled = false;
    let killedForLimit = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(hits);
    };

    const killForLimit = () => {
      killedForLimit = true;
      child.kill("SIGKILL");
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(new Error("ripgrep search aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    const rl = createInterface({
      input: child.stdout,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    rl.on("line", (line) => {
      const hit = parseRgLine(line);
      if (!hit) return;
      if (hit.isMatch && hits.filter((h) => h.isMatch).length >= MAX_TOTAL_HITS) {
        killForLimit();
        return;
      }
      hits.push(hit);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => finish(new Error(`ripgrep spawn failed: ${err.message}`)));
    child.on("close", (code) => {
      if (killedForLimit) return finish(); // partial results are valid
      if (code === 0 || code === 1) return finish();
      finish(new Error(stderr.trim() || `ripgrep exited with code ${code}.`));
    });
  });
}

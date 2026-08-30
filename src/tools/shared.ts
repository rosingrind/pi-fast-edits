import { relative } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { FileAnchorState, PiFastEditsConfig, SessionState } from "../types.js";
import { createFileAnchorState } from "../anchor/anchor-state.js";
import { reconcileState } from "../anchor/reconcile.js";
import { readTextFile } from "../fs/text-file.js";
import {
  assertRegularFile,
  isProtectedPath,
  resolveWorkspacePath,
  toWorkspaceRelative,
} from "../fs/path-safety.js";

/**
 * The subset of pi's `ExtensionContext` that pi-fast-edits reads. Kept local so
 * the tools are decoupled from the full extension context surface they don't use.
 */
export type PiContext = {
  ui?: {
    confirm?: (title: string, body: string) => Promise<boolean>;
    notify?: (message: string, type?: "info" | "warning" | "error") => void;
  };
  cwd?: string;
};

export function textResult(text: string, details?: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

export type AnchorChangeSet = {
  removed: string[];
  added: string[];
  preserved: string[];
};

export function computeAnchorChanges(before: string[], after: string[]): AnchorChangeSet {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    removed: before.filter((anchor) => !afterSet.has(anchor)),
    added: after.filter((anchor) => !beforeSet.has(anchor)),
    preserved: before.filter((anchor) => afterSet.has(anchor)),
  };
}

export function getCwd(ctx: PiContext): string {
  return typeof ctx?.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
}

export async function loadStateForPath(
  session: SessionState,
  cwd: string,
  requestedPath: string,
): Promise<{
  absPath: string;
  writePath: string;
  relativePath: string;
  state: FileAnchorState;
  snapshot: Awaited<ReturnType<typeof readTextFile>>;
}> {
  const absPath = await resolveWorkspacePath(cwd, requestedPath);
  await assertRegularFile(absPath);
  // Resolve symlinks so atomic writes replace the target file, not the link.
  const writePath = await _resolveSymlink(absPath);
  const snapshot = await readTextFile(absPath);
  const relativePath = toWorkspaceRelative(cwd, absPath);
  let state = session.files.get(absPath);
  if (!state) {
    state = createFileAnchorState(
      absPath,
      snapshot.lines,
      snapshot.lineEnding,
      snapshot.hadFinalNewline,
      snapshot.hadBom,
      snapshot.text,
    );
    session.files.set(absPath, state);
  } else if (state.revisionHash !== snapshot.revisionHash) {
    reconcileState(
      state,
      snapshot.lines,
      snapshot.lineEnding,
      snapshot.hadFinalNewline,
      snapshot.hadBom,
      snapshot.revisionHash,
    );
  }
  return { absPath, writePath, relativePath, state, snapshot };
}

async function _resolveSymlink(absPath: string): Promise<string> {
  try {
    const lst = await lstat(absPath);
    return lst.isSymbolicLink() ? await realpath(absPath) : absPath;
  } catch {
    return absPath;
  }
}

export function assertExpectedRevision(
  relativePath: string,
  actual: string,
  expected?: string,
): void {
  if (expected && expected !== actual) {
    throw new Error(
      `Revision mismatch for ${relativePath}: expected ${expected}, current ${actual}. Re-read the file before editing.`,
    );
  }
}

export async function confirmIfNeeded(
  ctx: PiContext,
  config: PiFastEditsConfig,
  cwd: string,
  absPaths: string[],
  preview: string,
): Promise<boolean> {
  if (config.confirmation === "never") return true;

  // Resolve the workspace root and target paths so protection compares like
  // for like: a symlinked prefix (e.g. /tmp -> /private/tmp on macOS) or an
  // aliased file both normalize to their real paths.
  const cwdReal = await realpath(cwd).catch(() => cwd);
  const resolvedPaths = await Promise.all(
    absPaths.map(async (abs) => realpath(abs).catch(() => abs)),
  );

  const protectedHits = resolvedPaths.filter((abs) =>
    isProtectedPath(relative(cwdReal, abs).replace(/\\/g, "/"), config.protectedPaths),
  );
  if (config.confirmation === "protected-paths" && protectedHits.length === 0) return true;

  const ui = ctx?.ui;
  if (!ui?.confirm) return false;

  const files = resolvedPaths
    .map(
      (abs) =>
        `- ${relative(cwdReal, abs).replace(/\\/g, "/")}${protectedHits.includes(abs) ? " (protected)" : ""}`,
    )
    .join("\n");
  const body = `${files}\n\n${preview.slice(0, 6000)}`;
  return ui.confirm("pi-fast-edits wants to edit files", body);
}

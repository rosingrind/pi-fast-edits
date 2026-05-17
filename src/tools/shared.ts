import { relative } from "node:path";
import type { FileAnchorState, PiFastEditsConfig, SessionState, ToolTextResult } from "../types.js";
import { createFileAnchorState } from "../anchor/anchor-state.js";
import { reconcileState } from "../anchor/reconcile.js";
import { readTextFile } from "../fs/text-file.js";
import { assertRegularFile, isProtectedPath, resolveWorkspacePath, toWorkspaceRelative } from "../fs/path-safety.js";

export function textResult(text: string, details?: unknown): ToolTextResult {
  return { content: [{ type: "text", text }], details };
}

export function getCwd(ctx: unknown): string {
  const candidate = (ctx as { cwd?: string } | undefined)?.cwd;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : process.cwd();
}

export async function loadStateForPath(
  session: SessionState,
  cwd: string,
  requestedPath: string
): Promise<{ absPath: string; relativePath: string; state: FileAnchorState; snapshot: Awaited<ReturnType<typeof readTextFile>> }> {
  const absPath = await resolveWorkspacePath(cwd, requestedPath);
  await assertRegularFile(absPath);
  const snapshot = await readTextFile(absPath);
  const relativePath = toWorkspaceRelative(cwd, absPath);
  let state = session.files.get(absPath);
  if (!state) {
    state = createFileAnchorState(absPath, snapshot.lines, snapshot.lineEnding, snapshot.hadFinalNewline, snapshot.text);
    session.files.set(absPath, state);
  } else if (state.revisionHash !== snapshot.revisionHash) {
    reconcileState(state, snapshot.lines, snapshot.lineEnding, snapshot.hadFinalNewline);
  }
  return { absPath, relativePath, state, snapshot };
}

export function assertExpectedRevision(relativePath: string, actual: string, expected?: string): void {
  if (expected && expected !== actual) {
    throw new Error(
      `Revision mismatch for ${relativePath}: expected ${expected}, current ${actual}. Read the file again with read_anchored_file before editing.`
    );
  }
}

export async function confirmIfNeeded(
  ctx: unknown,
  config: PiFastEditsConfig,
  cwd: string,
  absPaths: string[],
  preview: string
): Promise<boolean> {
  if (config.confirmation === "never") return true;
  const protectedHits = absPaths.filter((abs) => isProtectedPath(relative(cwd, abs).replace(/\\/g, "/"), config.protectedPaths));
  if (config.confirmation === "protected-paths" && protectedHits.length === 0) return true;

  const ui = (ctx as { ui?: { confirm?: (title: string, body: string) => Promise<boolean> } } | undefined)?.ui;
  if (!ui?.confirm) return true;

  const files = absPaths.map((abs) => `- ${relative(cwd, abs).replace(/\\/g, "/")}${protectedHits.includes(abs) ? " (protected)" : ""}`).join("\n");
  const body = `${files}\n\n${preview.slice(0, 6000)}`;
  return ui.confirm("pi-fast-edits wants to edit files", body);
}

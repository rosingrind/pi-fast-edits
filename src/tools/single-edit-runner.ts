import type { AnchoredEdit, PiFastEditsConfig, SessionState } from "../types.js";
import { renderAnchoredLines } from "../anchor/anchor-renderer.js";
import { reconcileState } from "../anchor/reconcile.js";
import { unifiedDiff } from "../diff/unified-diff.js";
import { atomicWriteFile } from "../fs/atomic-write.js";
import { joinLines, readTextFile } from "../fs/text-file.js";
import { assertExpectedRevision, confirmIfNeeded, getCwd, loadStateForPath, textResult } from "./shared.js";
import { applyPlansToLines, planEdit } from "./edit-core.js";

export async function runSingleEdit(session: SessionState, config: PiFastEditsConfig, ctx: unknown, edit: AnchoredEdit) {
  const cwd = getCwd(ctx);
  const loaded = await loadStateForPath(session, cwd, edit.path);
  assertExpectedRevision(loaded.relativePath, loaded.state.revisionHash, edit.expectedRevision);
  const plan = planEdit(loaded.state, edit);
  const beforeLines = loaded.state.lines.map((line) => line.text);
  const afterLines = applyPlansToLines(beforeLines, [plan]);
  const diff = unifiedDiff(loaded.relativePath, beforeLines, afterLines);
  const ok = await confirmIfNeeded(ctx, config, cwd, [loaded.absPath], diff);
  if (!ok) return textResult("Edit cancelled. No files were changed.");

  await atomicWriteFile(loaded.absPath, joinLines(afterLines, loaded.state.lineEnding, loaded.state.hadFinalNewline));
  const snapshot = await readTextFile(loaded.absPath);
  reconcileState(loaded.state, snapshot.lines, snapshot.lineEnding, snapshot.hadFinalNewline);

  const changedAt = Math.max(0, Math.min(afterLines.length, firstChangedLine(beforeLines, afterLines)) - 3);
  const region = renderAnchoredLines(loaded.state.lines.slice(changedAt, Math.min(loaded.state.lines.length, changedAt + 24)));
  const parts = [`Edited ${loaded.relativePath}.`, `Updated anchors:\n${region}`];
  if (config.returnDiffsAfterEdit) parts.push(`Diff:\n${diff}`);
  return textResult(parts.join("\n\n"));
}

function firstChangedLine(before: string[], after: string[]): number {
  const max = Math.min(before.length, after.length);
  for (let i = 0; i < max; i++) if (before[i] !== after[i]) return i;
  return max;
}

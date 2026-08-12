import type { AnchoredEdit, PiFastEditsConfig, SessionState } from "../types.js";
import { reconcileState } from "../anchor/reconcile.js";
import { myersDiff } from "../diff/myers.js";
import { unifiedDiff } from "../diff/unified-diff.js";
import { atomicWriteFile } from "../fs/atomic-write.js";
import { joinLines, readTextFile } from "../fs/text-file.js";
import {
  assertExpectedRevision,
  computeAnchorChanges,
  confirmIfNeeded,
  getCwd,
  loadStateForPath,
  textResult,
  type PiContext,
} from "./shared.js";
import { applyPlansToLines, planEdit } from "./edit-core.js";
import { renderDiff } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { ToolResult, RenderOptions, RenderContext } from "./render.js";
import type { Theme } from "./theme.js";

export async function runSingleEdit(
  session: SessionState,
  config: PiFastEditsConfig,
  ctx: PiContext,
  edit: AnchoredEdit,
  signal?: AbortSignal,
) {
  if (signal?.aborted) return textResult("Edit cancelled (aborted).");
  const cwd = getCwd(ctx);
  const loaded = await loadStateForPath(session, cwd, edit.path);
  assertExpectedRevision(loaded.relativePath, loaded.state.revisionHash, edit.expectedRevision);
  const beforeAnchors = loaded.state.lines.map((line) => line.anchor);
  const plan = planEdit(loaded.state, edit);
  const beforeLines = loaded.state.lines.map((line) => line.text);
  const afterLines = applyPlansToLines(beforeLines, [plan]);
  // Myers runs once here and is shared by both the preview diff and the
  // post-write reconciliation (reconcileState skips its own re-run).
  const diffOps = myersDiff(beforeLines, afterLines);
  const diff = unifiedDiff(beforeLines, afterLines, 4, diffOps);
  const ok = await confirmIfNeeded(ctx, config, cwd, [loaded.absPath], diff);
  if (!ok) {
    return textResult(
      ctx?.ui?.confirm
        ? "Edit cancelled. No files were changed."
        : "Edit cancelled: this edit requires confirmation, but no confirmation UI is available in this environment (headless/CI). No files were changed.",
    );
  }

  const created = beforeLines.length === 0 && afterLines.length > 0;
  // An empty result must not retain a trailing newline — a truly empty file.
  const joined =
    afterLines.length === 0
      ? ""
      : joinLines(afterLines, loaded.state.lineEnding, loaded.state.hadFinalNewline || created);
  // Re-add a UTF-8 BOM stripped at read time so it survives edits to line 1.
  const content = `${loaded.state.hadBom ? "\uFEFF" : ""}${joined}`;
  await atomicWriteFile(loaded.writePath, content);
  const snapshot = await readTextFile(loaded.absPath);
  // Only reuse diffOps when the write→read round-trip is lossless. When it
  // normalizes lines differently (e.g. a trailing newline is stripped), the
  // ops built against afterLines no longer line up with snapshot.lines, so
  // let reconcileState recompute its own diff.
  const linesMatch =
    afterLines.length === snapshot.lines.length &&
    afterLines.every((line, i) => line === snapshot.lines[i]);
  reconcileState(
    loaded.state,
    snapshot.lines,
    snapshot.lineEnding,
    snapshot.hadFinalNewline,
    snapshot.hadBom,
    snapshot.revisionHash,
    linesMatch ? diffOps : undefined,
  );
  const afterAnchors = loaded.state.lines.map((line) => line.anchor);
  const anchorChanges = computeAnchorChanges(beforeAnchors, afterAnchors);
  // Visual output matches the built-in edit tools: the unified diff, colored by
  // the renderer. Structured anchor data stays in `details` for programmatic use.
  return textResult(diff, { editType: edit.type, anchorChanges });
}

/**
 * Render a single-edit tool result. Diffs (lines prefixed with `+`/`-`) are
 * colored with pi's diff theme; plain success messages render as-is. The diff
 * is always visible regardless of collapse state, matching the built-in edit
 * tool's rendering.
 */
export function renderEditResult(
  result: ToolResult,
  options: RenderOptions,
  theme: Theme,
  context: RenderContext,
): Component {
  if (context.isError) {
    const text = result.content?.[0]?.text ?? "error";
    return new Text(theme.fg("error", text), 0, 0);
  }
  const raw = result.content?.[0]?.text ?? "";
  // A diff has at least one `+`/`-` change line; a plain success message never
  // starts with one. Detect on the change marker so indented message lines or
  // space-prefixed context lines do not false-positive into diff rendering.
  const isDiff = raw.split("\n").some((line) => /^[+-]/.test(line));
  if (!isDiff) {
    // Not a diff — render the success message as-is.
    return new Text(raw, 0, 0);
  }
  // Match the built-in edit tool's rendering: a blank line spacer, then the
  // diff colored (with intra-line change highlighting) via pi's renderDiff,
  // indented one column. renderDiff uses pi's global theme singleton.
  const container = new Container();
  container.addChild(new Spacer(1));
  container.addChild(new Text(renderDiff(raw), 1, 0));
  return container;
}

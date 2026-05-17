import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AnchoredEdit, PiFastEditsConfig, SessionState } from "../types.js";
import { renderAnchoredLines } from "../anchor/anchor-renderer.js";
import { reconcileState } from "../anchor/reconcile.js";
import { atomicWriteFile } from "../fs/atomic-write.js";
import { joinLines, readTextFile } from "../fs/text-file.js";
import { unifiedDiff } from "../diff/unified-diff.js";
import { assertExpectedRevision, confirmIfNeeded, getCwd, loadStateForPath, textResult } from "./shared.js";
import { applyPlansToLines, assertNoOverlaps, planEdit } from "./edit-core.js";

const editSchema = Type.Object({
  type: Type.String(),
  path: Type.String(),
  startAnchor: Type.Optional(Type.String()),
  endAnchor: Type.Optional(Type.String()),
  replacement: Type.Optional(Type.String()),
  includeStart: Type.Optional(Type.Boolean()),
  includeEnd: Type.Optional(Type.Boolean()),
  anchor: Type.Optional(Type.String()),
  position: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()),
  expectedRevision: Type.Optional(Type.String())
});

export function registerApplyAnchoredEdits(pi: ExtensionAPI, session: SessionState, config: PiFastEditsConfig): void {
  pi.registerTool({
    name: "apply_anchored_edits",
    label: "Apply Anchored Edits",
    description: "Apply multiple Dirac-style anchored edits, validating all anchors before writing and reconciling lazily with Myers diff.",
    parameters: Type.Object({ edits: Type.Array(editSchema) }),
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const cwd = getCwd(ctx);
      const edits = normalizeEdits(params.edits);
      const byAbsPath = new Map<
        string,
        { loaded: Awaited<ReturnType<typeof loadStateForPath>>; edits: AnchoredEdit[] }
      >();
      for (const edit of edits) {
        const loaded = await loadStateForPath(session, cwd, edit.path);
        const group = byAbsPath.get(loaded.absPath);
        if (group) group.edits.push(edit);
        else byAbsPath.set(loaded.absPath, { loaded, edits: [edit] });
      }

      const plansByAbsPath = new Map<string, { relativePath: string; beforeLines: string[]; afterLines: string[]; state: Awaited<ReturnType<typeof loadStateForPath>>["state"] }>();
      const diffs: string[] = [];
      for (const [absPath, { loaded, edits: pathEdits }] of byAbsPath) {
        for (const edit of pathEdits) assertExpectedRevision(loaded.relativePath, loaded.state.revisionHash, edit.expectedRevision);
        const plans = pathEdits.map((edit) => planEdit(loaded.state, edit));
        assertNoOverlaps(plans);
        const beforeLines = loaded.state.lines.map((line) => line.text);
        const afterLines = applyPlansToLines(beforeLines, plans);
        plansByAbsPath.set(absPath, { relativePath: loaded.relativePath, beforeLines, afterLines, state: loaded.state });
        diffs.push(unifiedDiff(loaded.relativePath, beforeLines, afterLines));
      }

      const preview = diffs.join("\n\n");
      const ok = await confirmIfNeeded(ctx, config, cwd, [...plansByAbsPath.keys()], preview);
      if (!ok) return textResult("Edit cancelled. No files were changed.");

      const summaries: string[] = [];
      for (const [absPath, plan] of plansByAbsPath) {
        const newText = joinLines(plan.afterLines, plan.state.lineEnding, plan.state.hadFinalNewline);
        await atomicWriteFile(absPath, newText);
        const snapshot = await readTextFile(absPath);
        reconcileState(plan.state, snapshot.lines, snapshot.lineEnding, snapshot.hadFinalNewline);
        summaries.push(`Edited ${plan.relativePath}: ${plan.beforeLines.length} lines -> ${plan.afterLines.length} lines.`);
        if (config.returnUpdatedAnchorsAfterEdit) {
          const start = Math.max(0, Math.min(plan.afterLines.length, firstChangedLine(plan.beforeLines, plan.afterLines)) - 3);
          const end = Math.min(plan.state.lines.length, start + 24);
          summaries.push(`Updated anchors around first change:\n${renderAnchoredLines(plan.state.lines.slice(start, end))}`);
        }
      }

      if (config.returnDiffsAfterEdit) summaries.push(`Diff:\n${preview}`);
      return textResult(summaries.join("\n\n"));
    }
  });
}

function normalizeEdits(input: unknown[]): AnchoredEdit[] {
  return input.map((raw) => {
    const edit = raw as Record<string, unknown>;
    if (edit.type === "replace") {
      return {
        type: "replace",
        path: String(edit.path),
        startAnchor: String(edit.startAnchor),
        endAnchor: String(edit.endAnchor),
        replacement: String(edit.replacement ?? ""),
        includeStart: edit.includeStart === undefined ? undefined : Boolean(edit.includeStart),
        includeEnd: edit.includeEnd === undefined ? undefined : Boolean(edit.includeEnd),
        expectedRevision: optionalString(edit.expectedRevision)
      };
    }
    if (edit.type === "insert") {
      return {
        type: "insert",
        path: String(edit.path),
        anchor: String(edit.anchor),
        position: edit.position === "before" ? "before" : "after",
        content: String(edit.content ?? ""),
        expectedRevision: optionalString(edit.expectedRevision)
      };
    }
    if (edit.type === "delete") {
      return {
        type: "delete",
        path: String(edit.path),
        startAnchor: String(edit.startAnchor),
        endAnchor: String(edit.endAnchor),
        expectedRevision: optionalString(edit.expectedRevision)
      };
    }
    throw new Error(`Unsupported edit type: ${String(edit.type)}`);
  });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstChangedLine(before: string[], after: string[]): number {
  const max = Math.min(before.length, after.length);
  for (let i = 0; i < max; i++) if (before[i] !== after[i]) return i;
  return max;
}

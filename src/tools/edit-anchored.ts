import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AnchoredEdit, PiFastEditsConfig, SessionState } from "../types.js";
import { reconcileState } from "../anchor/reconcile.js";
import { atomicWriteFile } from "../fs/atomic-write.js";
import { resolveWorkspacePath } from "../fs/path-safety.js";
import { joinLines, readTextFile } from "../fs/text-file.js";
import { myersDiff, type DiffOp } from "../diff/myers.js";
import { unifiedDiff } from "../diff/unified-diff.js";
import {
  assertExpectedRevision,
  computeAnchorChanges,
  confirmIfNeeded,
  getCwd,
  loadStateForPath,
  textResult,
  type AnchorChangeSet,
  type PiContext,
} from "./shared.js";
import { applyPlansToLines, assertNoOverlaps, planEdit, type PlannedEdit } from "./edit-core.js";
import {
  renderToolCall,
  type ToolResult,
  type RenderOptions,
  type RenderContext,
} from "./render.js";
import type { Component } from "@earendil-works/pi-tui";
import { experimentalToolSampling } from "./experimental-sampling.js";
import { renderEditResult } from "./render-edit-result.js";
import { batchEditsSchema, type BatchEditsParams } from "./schemas.js";
import type { Static } from "typebox";

type BatchParams = BatchEditsParams;

/** True when the value looks like a single batch edit object (has anchor/path fields). */
function isSingleEdit(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.path === "string" &&
    (typeof v.startAnchor === "string" || typeof v.anchor === "string")
  );
}

/**
 * Models sometimes send edits as a JSON string or a single edit object
 * instead of an array (the same quirk pi's built-in edit handles in its
 * prepareArguments). Normalize before render and execute so the chip
 * suffix and the executor see the same well-formed shape.
 */
function normalizeEdits(input: unknown) {
  // The schema's static type (strict/lenient variants) is the contract pi
  // type-checks against; cast through it since normalization is shape-only.
  type BatchStatic = Static<ReturnType<typeof batchEditsSchema>>;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return input as BatchStatic;
  }
  const raw = input as { edits?: unknown };
  let edits = raw.edits;
  if (typeof edits === "string") {
    try {
      const parsed = JSON.parse(edits);
      if (Array.isArray(parsed)) edits = parsed;
      else if (isSingleEdit(parsed)) edits = [parsed];
    } catch {
      // leave as-is; schema validation reports the malformed value
    }
  } else if (isSingleEdit(edits)) {
    edits = [edits];
  }
  // Field-name rescue: models alternating insert/replace in one batch
  // sometimes use `content` for replace edits (or `replacement` for
  // inserts). Move the text to the field the variant actually takes.
  if (Array.isArray(edits)) {
    for (const e of edits as Array<Record<string, unknown>>) {
      if (e.type === "replace" && e.replacement === undefined && typeof e.content === "string") {
        e.replacement = e.content;
        delete e.content;
      } else if (
        e.type === "insert" &&
        e.content === undefined &&
        typeof e.replacement === "string"
      ) {
        e.content = e.replacement;
        delete e.replacement;
      }
    }
  }
  return { edits: edits as BatchStatic["edits"] } as BatchStatic;
}

export function registerEditAnchored(
  pi: ExtensionAPI,
  session: SessionState,
  config: PiFastEditsConfig,
) {
  const tool = {
    name: "edit_anchored",
    label: "Apply Anchored Edits",
    constrainedSampling: experimentalToolSampling(),
    description:
      "Apply multiple anchored edits in a single batch, validating all anchors before writing and reconciling lazily with Myers diff.",
    promptSnippet: "Apply multiple anchored edits in a single batch operation",
    promptGuidelines: [
      "startAnchorLine/endAnchorLine/anchorLine = the bare source line at each anchor — verified; a mismatch rejects the whole batch (drop any rendered `    line N` suffix)",
      "Workflows, multi-file batches, failure recovery: the pi-fast-edits skill (/skill:pi-fast-edits)",
    ],
    renderShell: "default" as const,
    executionMode: "sequential" as const,
    prepareArguments(input: unknown) {
      return normalizeEdits(input);
    },
    renderCall: renderToolCall("edit_anchored", (args, theme) => {
      const edits = Array.isArray(args.edits)
        ? args.edits.filter(
            (e) =>
              typeof (e as { path?: string })?.path === "string" && (e as { path: string }).path,
          )
        : [];
      if (edits.length === 0) return "";
      const paths = [...new Set(edits.map((e) => (e as { path: string }).path))];
      const display =
        paths.length === 1
          ? paths[0]
          : `${paths[0]} (+${paths.length - 1} more file${paths.length > 2 ? "s" : ""})`;
      return theme.fg("warning", ` ${display}`);
    }),
    renderResult: renderEditResult,
    parameters: batchEditsSchema(config.requireAnchorLines),
    async execute(
      _toolCallId: string,
      params: BatchParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: PiContext,
    ) {
      if (signal?.aborted) return textResult("Edit cancelled (aborted).", []);
      const cwd = getCwd(ctx);
      const edits = params.edits;
      if (edits.length === 0) return textResult("No edits to apply.", []);

      const byAbsPath = await loadEditsByPath(session, cwd, edits);

      const planned: PlannedFile[] = [];
      for (const [absPath, { loaded, edits: pathEdits }] of byAbsPath) {
        planned.push(planEditsForFile(absPath, loaded, pathEdits, config.requireAnchorLines));
      }

      const cancelled = await confirmOrCancel(ctx, config, cwd, planned);
      if (cancelled) return cancelled;

      return applyBatch(planned, signal, planned.length);
    },
  };
  pi.registerTool(tool);
  return tool;
}

type LoadedFile = Awaited<ReturnType<typeof loadStateForPath>>;

/** One file's complete edit plan: what to preview, confirm, write, and reconcile. */
type PlannedFile = {
  absPath: string;
  writePath: string;
  relativePath: string;
  state: LoadedFile["state"];
  beforeLines: string[];
  beforeAnchors: string[];
  afterLines: string[];
  diffOps: DiffOp[];
  diff: string;
  plans: PlannedEdit[];
};

/**
 * Resolve every edit to its absolute path, then load each unique file in
 * parallel. Reads are I/O-bound, and each unique path is read exactly once.
 */
async function loadEditsByPath(
  session: SessionState,
  cwd: string,
  edits: AnchoredEdit[],
): Promise<Map<string, { loaded: LoadedFile; edits: AnchoredEdit[] }>> {
  const resolvedPaths = await Promise.all(
    edits.map((edit) => resolveWorkspacePath(cwd, edit.path)),
  );
  const uniqueAbs = [...new Set(resolvedPaths)];
  const loadedAll = await Promise.all(
    uniqueAbs.map((absPath) => loadStateForPath(session, cwd, absPath)),
  );
  const loadedByPath = new Map(loadedAll.map((l) => [l.absPath, l]));

  const byAbsPath = new Map<string, { loaded: LoadedFile; edits: AnchoredEdit[] }>();
  edits.forEach((edit, i) => {
    const absPath = resolvedPaths[i];
    const group = byAbsPath.get(absPath);
    if (group) group.edits.push(edit);
    else byAbsPath.set(absPath, { loaded: loadedByPath.get(absPath)!, edits: [edit] });
  });
  return byAbsPath;
}

/** Validate, plan, and diff every edit for one already-loaded file. */
function planEditsForFile(
  absPath: string,
  loaded: LoadedFile,
  pathEdits: AnchoredEdit[],
  requireAnchorLines: boolean,
): PlannedFile {
  for (const edit of pathEdits) {
    assertExpectedRevision(loaded.relativePath, loaded.state.revisionHash, edit.expectedRevision);
  }
  const plans = pathEdits.map((edit) => planEdit(loaded.state, edit, requireAnchorLines));
  assertNoOverlaps(plans);
  const beforeLines = loaded.state.lines.map((line) => line.text);
  const beforeAnchors = loaded.state.lines.map((line) => line.anchor);
  const afterLines = applyPlansToLines(beforeLines, plans);
  // Myers runs once here and is shared by both the preview diff and the
  // post-write reconciliation (reconcileState skips its own re-run).
  const diffOps = myersDiff(beforeLines, afterLines);
  return {
    absPath,
    writePath: loaded.writePath,
    relativePath: loaded.relativePath,
    state: loaded.state,
    beforeLines,
    beforeAnchors,
    afterLines,
    diffOps,
    diff: unifiedDiff(beforeLines, afterLines, 4, diffOps),
    plans,
  };
}

/**
 * Prompt for confirmation when the config requires it. Returns the
 * cancellation result, or null when the batch should proceed.
 */
async function confirmOrCancel(
  ctx: PiContext,
  config: PiFastEditsConfig,
  cwd: string,
  planned: PlannedFile[],
): Promise<AgentToolResult<unknown> | null> {
  const preview = planned.map((p) => p.diff).join("\n\n");
  const ok = await confirmIfNeeded(
    ctx,
    config,
    cwd,
    planned.map((p) => p.absPath),
    preview,
  );
  if (ok) return null;
  return textResult(
    ctx?.ui?.confirm
      ? "Edit cancelled. No files were changed."
      : "Edit cancelled: this batch requires confirmation, but no confirmation UI is available in this environment (headless/CI). No files were changed.",
  );
}

/**
 * Write every planned file, reconcile cached state, and summarize. An abort
 * that fires mid-batch stops here; already-persisted files are reported as
 * partial progress rather than rolled back: the multi-file batch is
 * deliberately not transactional.
 */
async function applyBatch(
  planned: PlannedFile[],
  signal: AbortSignal | undefined,
  totalFiles: number,
): Promise<AgentToolResult<unknown>> {
  const groups: BatchGroup[] = [];
  for (const p of planned) {
    const created = p.beforeLines.length === 0 && p.afterLines.length > 0;
    // An empty result must not retain a trailing newline — a truly empty file.
    const joined =
      p.afterLines.length === 0
        ? ""
        : joinLines(p.afterLines, p.state.lineEnding, p.state.hadFinalNewline || created);
    // Re-add a UTF-8 BOM stripped at read time so it survives edits to line 1.
    const content = `${p.state.hadBom ? "\uFEFF" : ""}${joined}`;
    await atomicWriteFile(p.writePath, content);
    const snapshot = await readTextFile(p.absPath);
    // Only reuse diffOps when the write→read round-trip is lossless. If it
    // normalizes lines differently (e.g. a trailing newline is stripped),
    // the ops built against afterLines no longer line up with
    // snapshot.lines, so let reconcileState recompute its own diff.
    const linesMatch =
      p.afterLines.length === snapshot.lines.length &&
      p.afterLines.every((line, i) => line === snapshot.lines[i]);
    reconcileState(
      p.state,
      snapshot.lines,
      snapshot.lineEnding,
      snapshot.hadFinalNewline,
      snapshot.hadBom,
      snapshot.revisionHash,
      linesMatch ? p.diffOps : undefined,
    );
    const afterAnchors = p.state.lines.map((line) => line.anchor);
    groups.push({
      relativePath: p.relativePath,
      diff: p.diff,
      plans: p.plans,
      perEdit: _computePerEditChanges(p.plans, p.beforeAnchors, afterAnchors),
    });

    // An abort that fires after this file is written stops the batch here.
    // Already-persisted files are reported as partial progress rather than
    // rolled back: the multi-file batch is deliberately not transactional.
    if (signal?.aborted) {
      const partial = _summarizeBatch(groups);
      return {
        ...textResult(
          `Aborted after ${groups.length} of ${totalFiles} files.\n\n${partial.text}`,
          partial.details,
        ),
        terminate: true,
      } as AgentToolResult<unknown>;
    }
  }

  const full = _summarizeBatch(groups);
  return textResult(full.text, full.details);
}

type BatchGroup = {
  relativePath: string;
  diff: string;
  plans: PlannedEdit[];
  perEdit: Map<AnchoredEdit, AnchorChangeSet>;
};

function _summarizeBatch(groups: BatchGroup[]): { text: string; details: unknown } {
  // Visual output matches the built-in tools: the combined unified diffs,
  // colored by the renderer. Structured anchor data stays in `details`.
  // Prefix each group's diff with its relative path so multi-file batches
  // remain readable — the tool-call title only shows the first path.
  //
  // The combined text is byte-capped (grep parity): a huge rewrite must not
  // dump megabytes of diff into context. Truncating mid-diff is safe here —
  // the text is informational; every edit is already applied and the note
  // teaches re-reading the edited files instead of implying data loss.
  let text = groups
    .map((group) => (groups.length > 1 ? `${group.relativePath}\n${group.diff}` : group.diff))
    .join("\n\n");
  if (text.length > MAX_RESULT_BYTES) {
    text =
      text.slice(0, MAX_RESULT_BYTES) +
      "\n\n... result truncated at 100KB — all edits were applied; re-read the edited files for their current diffs.";
  }
  const details = groups.map((group) => ({
    edits: group.plans.map((plan) => ({
      editType: plan.edit.type,
      anchorChanges: group.perEdit.get(plan.edit) ?? { removed: [], added: [], preserved: [] },
    })),
  }));
  return { text, details };
}

/** Byte budget for the model-facing batch result (grep parity). */
const MAX_RESULT_BYTES = 100_000;

function _computePerEditChanges(
  plans: PlannedEdit[],
  beforeAnchors: string[],
  afterAnchors: string[],
): Map<AnchoredEdit, AnchorChangeSet> {
  const removedByEdit = new Map<AnchoredEdit, string[]>();
  const addedByEdit = new Map<AnchoredEdit, string[]>();
  for (const plan of plans) {
    removedByEdit.set(plan.edit, beforeAnchors.slice(plan.start, plan.end + 1));
    addedByEdit.set(plan.edit, []);
  }

  // Attribute the final-file added anchors to the edits that produced them. The
  // pool is allocated top-down over the whole file, so walk the final line
  // positions in order and hand each newly-added anchor to the owning edit.
  const globalAdded = new Set(computeAnchorChanges(beforeAnchors, afterAnchors).added);
  const final: Array<{ owner: AnchoredEdit | undefined }> = beforeAnchors.map(() => ({
    owner: undefined,
  }));
  const sorted = [...plans].sort((a, b) => b.start - a.start);
  for (const plan of sorted) {
    final.splice(
      plan.start,
      plan.end - plan.start + 1,
      ...plan.replacementLines.map(() => ({ owner: plan.edit })),
    );
  }
  for (let i = 0; i < final.length; i++) {
    const owner = final[i].owner;
    if (owner && globalAdded.has(afterAnchors[i])) {
      addedByEdit.get(owner)!.push(afterAnchors[i]);
    }
  }

  const afterSet = new Set(afterAnchors);
  const result = new Map<AnchoredEdit, AnchorChangeSet>();
  // Preserved anchors are scoped to a small neighborhood around each edit's
  // affected range — reporting every surviving anchor in the file would bury
  // the signal under whole-file noise.
  const NEIGHBORHOOD = 5;
  for (const plan of plans) {
    const windowStart = Math.max(0, plan.start - NEIGHBORHOOD);
    const windowEnd = Math.min(beforeAnchors.length - 1, plan.end + NEIGHBORHOOD);
    const preserved = beforeAnchors
      .map((anchor, i) => ({ anchor, i }))
      .filter(({ i }) => i >= windowStart && i <= windowEnd && (i < plan.start || i > plan.end))
      .filter(({ anchor }) => afterSet.has(anchor))
      .map(({ anchor }) => anchor);
    result.set(plan.edit, {
      removed: removedByEdit.get(plan.edit)!,
      added: addedByEdit.get(plan.edit)!,
      preserved,
    });
  }
  return result;
}

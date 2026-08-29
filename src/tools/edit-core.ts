import type { AnchoredEdit, FileAnchorState } from "../types.js";
import { findAnchorIndex } from "../anchor/anchor-state.js";
import { splitTextPreserveFinal } from "../fs/text-file.js";

export type PlannedEdit = {
  edit: AnchoredEdit;
  start: number;
  end: number;
  replacementLines: string[];
};

/**
 * Verify that each anchor's `*Line` companion (startAnchorLine/endAnchorLine/
 * anchorLine) matches the line currently at that anchor. In strict mode
 * (`requireAnchorLines`) the companions are mandatory; in lenient mode they are
 * verified only when provided. Each check runs against the anchor's own line
 * index — never plan.start/plan.end — so includeStart/position offsets cannot
 * misdirect it. Anchors that cannot be found are skipped; planEdit reports the
 * missing anchor itself.
 */
function verifyAnchorLines(
  state: FileAnchorState,
  edit: AnchoredEdit,
  requireAnchorLines: boolean,
): void {
  const anchors: Array<{ anchor: string; expected: string | undefined; label: string }> =
    edit.type === "insert"
      ? [{ anchor: edit.anchor, expected: edit.anchorLine, label: "anchor" }]
      : [
          { anchor: edit.startAnchor, expected: edit.startAnchorLine, label: "startAnchor" },
          { anchor: edit.endAnchor, expected: edit.endAnchorLine, label: "endAnchor" },
        ];
  for (const { anchor, expected, label } of anchors) {
    const anchorIndex = findAnchorIndex(state, anchor);
    if (anchorIndex === -1) continue; // planEdit reports the missing anchor itself
    if (expected === undefined) {
      if (requireAnchorLines) {
        throw new Error(
          `Missing ${label}Line: pass the exact current source line at ${label}, copied verbatim from read_anchored_file or grep_anchored_files output.`,
        );
      }
      continue;
    }
    const actual = state.lines[anchorIndex]?.text;
    if (actual !== expected) {
      throw new Error(
        `${label}Line mismatch for ${anchor}: the line is currently ${JSON.stringify(actual)}. Re-read the file and copy the line verbatim.`,
      );
    }
  }
}

export function planEdit(
  state: FileAnchorState,
  edit: AnchoredEdit,
  requireAnchorLines: boolean,
): PlannedEdit {
  verifyAnchorLines(state, edit, requireAnchorLines);

  // Empty files have no anchors — any edit creates the file content from scratch.
  if (state.lines.length === 0) {
    if (edit.type === "delete") return { edit, start: 0, end: -1, replacementLines: [] };
    const content = edit.type === "replace" ? edit.replacement : edit.content;
    return {
      edit,
      start: 0,
      end: -1,
      replacementLines: splitTextPreserveFinal(content).lines,
    };
  }

  if (edit.type === "replace") {
    const startAnchor = findAnchorIndex(state, edit.startAnchor);
    const endAnchor = findAnchorIndex(state, edit.endAnchor);
    if (startAnchor === -1)
      throw new Error(`Could not find start anchor ${edit.startAnchor} in ${state.path}.`);
    if (endAnchor === -1)
      throw new Error(`Could not find end anchor ${edit.endAnchor} in ${state.path}.`);
    const includeStart = edit.includeStart ?? true;
    const includeEnd = edit.includeEnd ?? true;
    const start = includeStart ? startAnchor : startAnchor + 1;
    const end = includeEnd ? endAnchor : endAnchor - 1;
    // Excluding both anchors of two adjacent lines (start === end + 1) yields a
    // zero-width insertion point between them — a valid way to replace a gap
    // without touching either anchor line.
    if (start > end + 1)
      throw new Error(`Invalid anchor range ${edit.startAnchor}..${edit.endAnchor}.`);
    return {
      edit,
      start,
      end,
      replacementLines: splitTextPreserveFinal(edit.replacement).lines,
    };
  }

  if (edit.type === "insert") {
    const index = findAnchorIndex(state, edit.anchor);
    if (index === -1) throw new Error(`Could not find anchor ${edit.anchor} in ${state.path}.`);
    const start = edit.position === "before" ? index : index + 1;
    return {
      edit,
      start,
      end: start - 1,
      replacementLines: splitTextPreserveFinal(edit.content).lines,
    };
  }

  const start = findAnchorIndex(state, edit.startAnchor);
  const end = findAnchorIndex(state, edit.endAnchor);
  if (start === -1)
    throw new Error(`Could not find start anchor ${edit.startAnchor} in ${state.path}.`);
  if (end === -1) throw new Error(`Could not find end anchor ${edit.endAnchor} in ${state.path}.`);
  if (start > end) throw new Error(`Invalid delete range ${edit.startAnchor}..${edit.endAnchor}.`);
  return { edit, start, end, replacementLines: [] };
}

export function assertNoOverlaps(plans: PlannedEdit[]): void {
  // Build effective intervals: every edit occupies [start, max(start, end)] inclusive.
  // An insert has end = start - 1, so its effective interval is [start, start].
  // A replace/delete has end >= start, so its effective interval is [start, end].
  const intervals: Array<{ start: number; end: number }> = plans.map((p) => ({
    start: p.start,
    end: Math.max(p.start, p.end),
  }));
  // Sort by start, then by end descending (larger ranges first).
  intervals.sort((a, b) => a.start - b.start || b.end - a.end);
  for (let i = 1; i < intervals.length; i++) {
    const prev = intervals[i - 1];
    const curr = intervals[i];
    if (curr.start <= prev.end) {
      throw new Error(`Overlapping edits are not supported in one file.`);
    }
  }
}

export function applyPlansToLines(lines: string[], plans: PlannedEdit[]): string[] {
  const out = [...lines];
  const sorted = [...plans].sort((a, b) => b.start - a.start);
  for (const plan of sorted) {
    out.splice(plan.start, plan.end - plan.start + 1, ...plan.replacementLines);
  }
  return out;
}

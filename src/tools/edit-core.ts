import type { AnchoredEdit, FileAnchorState } from "../types.js";
import { findAnchorIndex } from "../anchor/anchor-state.js";
import { splitTextPreserveFinal } from "../fs/text-file.js";

export type PlannedEdit = {
  edit: AnchoredEdit;
  start: number;
  end: number;
  replacementLines: string[];
};

export function planEdit(state: FileAnchorState, edit: AnchoredEdit): PlannedEdit {
  if (edit.type === "replace") {
    const startAnchor = findAnchorIndex(state, edit.startAnchor);
    const endAnchor = findAnchorIndex(state, edit.endAnchor);
    if (startAnchor === -1) throw new Error(`Could not find start anchor ${edit.startAnchor}§ in ${state.path}.`);
    if (endAnchor === -1) throw new Error(`Could not find end anchor ${edit.endAnchor}§ in ${state.path}.`);
    const includeStart = edit.includeStart ?? true;
    const includeEnd = edit.includeEnd ?? true;
    const start = includeStart ? startAnchor : startAnchor + 1;
    const end = includeEnd ? endAnchor : endAnchor - 1;
    if (start > end + 1) throw new Error(`Invalid anchor range ${edit.startAnchor}§..${edit.endAnchor}§.`);
    return { edit, start, end, replacementLines: splitTextPreserveFinal(edit.replacement).lines };
  }

  if (edit.type === "insert") {
    const index = findAnchorIndex(state, edit.anchor);
    if (index === -1) throw new Error(`Could not find anchor ${edit.anchor}§ in ${state.path}.`);
    const start = edit.position === "before" ? index : index + 1;
    return { edit, start, end: start - 1, replacementLines: splitTextPreserveFinal(edit.content).lines };
  }

  const start = findAnchorIndex(state, edit.startAnchor);
  const end = findAnchorIndex(state, edit.endAnchor);
  if (start === -1) throw new Error(`Could not find start anchor ${edit.startAnchor}§ in ${state.path}.`);
  if (end === -1) throw new Error(`Could not find end anchor ${edit.endAnchor}§ in ${state.path}.`);
  if (start > end) throw new Error(`Invalid delete range ${edit.startAnchor}§..${edit.endAnchor}§.`);
  return { edit, start, end, replacementLines: [] };
}

export function assertNoOverlaps(plans: PlannedEdit[]): void {
  const sorted = [...plans].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
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

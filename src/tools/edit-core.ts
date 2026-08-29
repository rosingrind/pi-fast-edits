import type { AnchoredEdit, FileAnchorState } from "../types.js";
import { findAnchorIndex } from "../anchor/anchor-state.js";
import { splitTextPreserveFinal } from "../fs/text-file.js";
import { ANCHOR_DELIMITER, parseAnchoredCoordinate } from "../anchor/anchor-renderer.js";

export type PlannedEdit = {
  edit: AnchoredEdit;
  start: number;
  end: number;
  replacementLines: string[];
};

/**
 * Verify that every full `ANCHOR§content` coordinate in the edit matches the
 * line currently at that anchor. Bare anchors carry no content and are never
 * checked, so legacy callers behave exactly as before. Called by planEdit
 * before any planning; throws a corrective message on mismatch.
 */
function assertCoordinateContent(state: FileAnchorState, edit: AnchoredEdit): void {
  const coordinates: Array<{ anchor: string; content?: string } | null> =
    edit.type === "insert"
      ? [parseAnchoredCoordinate(edit.anchor)]
      : [parseAnchoredCoordinate(edit.startAnchor), parseAnchoredCoordinate(edit.endAnchor)];
  for (const coord of coordinates) {
    if (coord?.content === undefined) continue;
    // A trailing ANCHOR§ with no content is the legacy bare-anchor form
    // (normalizeAnchor strips the trailing delimiter) — nothing to verify. One
    // leading space is also tolerated so full coordinates copied verbatim from
    // rendered read output (`Anchor§ text`) match the line text in details.
    const expected = coord.content.replace(/^ /, "");
    if (expected === "") continue;
    const index = findAnchorIndex(state, coord.anchor);
    if (index === -1) continue; // planEdit reports the missing anchor itself
    const actual = state.lines[index]?.text;
    if (actual !== expected) {
      throw new Error(
        `Anchor content mismatch for ${coord.anchor}${ANCHOR_DELIMITER}${coord.content}: the line is currently ${JSON.stringify(actual)}. Re-read the file with read_anchored_file and copy the anchored line verbatim.`,
      );
    }
  }
}

export function planEdit(state: FileAnchorState, edit: AnchoredEdit): PlannedEdit {
  assertCoordinateContent(state, edit);

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
    const startCoord = parseAnchoredCoordinate(edit.startAnchor) ?? { anchor: edit.startAnchor };
    const endCoord = parseAnchoredCoordinate(edit.endAnchor) ?? { anchor: edit.endAnchor };
    const startAnchor = findAnchorIndex(state, startCoord.anchor);
    const endAnchor = findAnchorIndex(state, endCoord.anchor);
    if (startAnchor === -1)
      throw new Error(
        `Could not find start anchor ${edit.startAnchor}${ANCHOR_DELIMITER} in ${state.path}.`,
      );
    if (endAnchor === -1)
      throw new Error(
        `Could not find end anchor ${edit.endAnchor}${ANCHOR_DELIMITER} in ${state.path}.`,
      );
    const includeStart = edit.includeStart ?? true;
    const includeEnd = edit.includeEnd ?? true;
    const start = includeStart ? startAnchor : startAnchor + 1;
    const end = includeEnd ? endAnchor : endAnchor - 1;
    // Excluding both anchors of two adjacent lines (start === end + 1) yields a
    // zero-width insertion point between them — a valid way to replace a gap
    // without touching either anchor line.
    if (start > end + 1)
      throw new Error(
        `Invalid anchor range ${edit.startAnchor}${ANCHOR_DELIMITER}..${edit.endAnchor}${ANCHOR_DELIMITER}.`,
      );
    return {
      edit,
      start,
      end,
      replacementLines: splitTextPreserveFinal(edit.replacement).lines,
    };
  }

  if (edit.type === "insert") {
    const coord = parseAnchoredCoordinate(edit.anchor) ?? { anchor: edit.anchor };
    const index = findAnchorIndex(state, coord.anchor);
    if (index === -1)
      throw new Error(`Could not find anchor ${edit.anchor}${ANCHOR_DELIMITER} in ${state.path}.`);
    const start = edit.position === "before" ? index : index + 1;
    return {
      edit,
      start,
      end: start - 1,
      replacementLines: splitTextPreserveFinal(edit.content).lines,
    };
  }

  const startCoord = parseAnchoredCoordinate(edit.startAnchor) ?? { anchor: edit.startAnchor };
  const endCoord = parseAnchoredCoordinate(edit.endAnchor) ?? { anchor: edit.endAnchor };
  const start = findAnchorIndex(state, startCoord.anchor);
  const end = findAnchorIndex(state, endCoord.anchor);
  if (start === -1)
    throw new Error(
      `Could not find start anchor ${edit.startAnchor}${ANCHOR_DELIMITER} in ${state.path}.`,
    );
  if (end === -1)
    throw new Error(
      `Could not find end anchor ${edit.endAnchor}${ANCHOR_DELIMITER} in ${state.path}.`,
    );
  if (start > end)
    throw new Error(
      `Invalid delete range ${edit.startAnchor}${ANCHOR_DELIMITER}..${edit.endAnchor}${ANCHOR_DELIMITER}.`,
    );
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

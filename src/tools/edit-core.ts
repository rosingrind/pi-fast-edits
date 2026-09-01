import type { AnchoredEdit, FileAnchorState } from "../types.js";
import { AnchorIndex, suggestAnchor } from "../anchor/anchor-state.js";
import { splitTextPreserveFinal } from "../fs/text-file.js";

/**
 * Display truncation cap shared by read/grep rendering. Lines longer than
 * this are shown truncated (with `...`); the anchorLine mismatch error
 * detects the resulting copy-the-truncation mistake and teaches the fix.
 */
export const DISPLAY_LINE_CAP = 300;

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
  index: AnchorIndex,
): void {
  const anchors: Array<{ anchor: string; expected: string | undefined; label: string }> =
    edit.type === "insert"
      ? [{ anchor: edit.anchor, expected: edit.anchorLine, label: "anchor" }]
      : [
          { anchor: edit.startAnchor, expected: edit.startAnchorLine, label: "startAnchor" },
          { anchor: edit.endAnchor, expected: edit.endAnchorLine, label: "endAnchor" },
        ];
  for (const { anchor, expected, label } of anchors) {
    const anchorIndex = index.find(anchor);
    if (anchorIndex === -1) continue; // planEdit reports the missing anchor itself
    if (expected === undefined) {
      if (requireAnchorLines) {
        throw new Error(
          `Missing ${label}Line: pass the exact current source line at ${label}, copied verbatim from read_anchored or grep_anchored output.`,
        );
      }
      continue;
    }
    const actual = state.lines[anchorIndex]?.text;
    if (actual !== expected) {
      // The rendered grep/read output appends a positional `    line N` /
      // `    lines N` marker after each line. Models copying that text
      // verbatim will carry the marker into *Line values; teach them to drop
      // it instead of silently accepting (dirac-grade strictness).
      const suffixStripped = expected.replace(/\s+lines? \d+$/, "");
      const suffixOnly = suffixStripped !== expected && suffixStripped === actual;
      let message = `${label}Line mismatch for ${anchor}: the line is currently ${JSON.stringify(actual)}. Re-read the file and copy the line verbatim.`;
      if (suffixOnly) {
        message +=
          " (if you copied the rendered `    line N` suffix from grep/read output, drop it — it is positional metadata, not part of the line)";
      } else if (actual.length > DISPLAY_LINE_CAP) {
        message +=
          ` (the line exceeds the ${DISPLAY_LINE_CAP}-character display cap and was shown truncated — ` +
          "re-read it with `anchored: false` plus startLine/endLine to copy it verbatim)";
      }
      throw new Error(message);
    }
  }
}

/**
 * Matches one anchor-marked source line: a TitleCase anchor word (optionally
 * numeric-suffixed, e.g. `Apple2`) immediately followed by the § delimiter.
 */
const ANCHOR_MARKED_LINE = /^[A-Z][a-zA-Z]*\d*§/;

/**
 * Reject anchor-marked text (`Word§...`) in replacement/content: an agent that
 * echoes rendered anchored output into raw text is making the exact mistake
 * the tools' guidelines warn about. `allowAnchoredLines: true` opts in when
 * the § is genuine content.
 */
function rejectAnchorMarkedText(edit: AnchoredEdit): void {
  if (edit.type === "delete" || edit.allowAnchoredLines === true) return;
  const text = edit.type === "replace" ? edit.replacement : edit.content;
  const offending = splitTextPreserveFinal(text).lines.find((line) =>
    ANCHOR_MARKED_LINE.test(line),
  );
  if (offending !== undefined) {
    throw new Error(
      `Text contains anchor-marked content (${JSON.stringify(offending.slice(0, 60))}). ` +
        `Pass raw text only — the § delimiter and anchor words are internal metadata. ` +
        `If the § is genuine content, set allowAnchoredLines: true.`,
    );
  }
}

/** Not-found error with a best-effort "did you mean" hint for near-miss anchors. */
function anchorNotFoundError(
  label: string,
  anchor: string,
  state: FileAnchorState,
  lineField: string,
): Error {
  const name = label ? `${label} anchor` : "anchor";
  const suggestion = suggestAnchor(state, anchor);
  if (!suggestion) return new Error(`Could not find ${name} ${anchor} in ${state.path}.`);
  const shown =
    suggestion.text.length > DISPLAY_LINE_CAP
      ? `${suggestion.text.slice(0, DISPLAY_LINE_CAP)}…`
      : suggestion.text;
  const lineHint = `line ${suggestion.lineNo}: ${JSON.stringify(shown)}`;
  const retry = `Retry with that anchor and ${lineField} '${shown}'.`;
  if (suggestion.caseOnly) {
    return new Error(
      `Could not find ${name} ${anchor} in ${state.path}. Anchors are case-sensitive — did you mean '${suggestion.suggestion}' (${lineHint})? ${retry}`,
    );
  }
  return new Error(
    `Could not find ${name} ${anchor} in ${state.path}. Did you mean '${suggestion.suggestion}' (${lineHint})? ${retry}`,
  );
}

/**
 * Compact fresh-coordinates block for a revision-mismatch rejection: resolves
 * every anchor named by the batch against the CURRENT (reconciled) state so
 * the model can retry in one turn instead of a dead-end re-read. Rows carry
 * the fresh anchor word, current text, and line number; rows whose content
 * matches what the edit expected are marked "(content unchanged)" — the
 * lost-update safety valve: changed content is shown, never hidden. Bounded
 * to 8 rows; anchors whose lines no longer exist are counted, not invented.
 */
const FRESH_HINT_MAX_ROWS = 8;
const FRESH_HINT_TEXT_CAP = 160;

export function freshAnchorHint(state: FileAnchorState, edits: AnchoredEdit[]): string | undefined {
  const index = new AnchorIndex(state);
  const expectedText = new Map<string, string | undefined>();
  const names: string[] = [];
  for (const edit of edits) {
    const named =
      edit.type === "insert"
        ? [[edit.anchor, edit.anchorLine] as const]
        : [
            [edit.startAnchor, edit.startAnchorLine] as const,
            [edit.endAnchor, edit.endAnchorLine] as const,
          ];
    for (const [name, line] of named) {
      if (!expectedText.has(name)) {
        names.push(name);
        expectedText.set(name, line);
      }
    }
  }

  const rows: string[] = [];
  let missing = 0;
  let overflow = 0;
  for (const name of names) {
    const i = index.find(name);
    if (i === -1) {
      missing++;
      continue;
    }
    if (rows.length >= FRESH_HINT_MAX_ROWS) {
      overflow++;
      continue;
    }
    const line = state.lines[i];
    const truncated = line.text.length > FRESH_HINT_TEXT_CAP;
    const text = truncated ? `${line.text.slice(0, FRESH_HINT_TEXT_CAP)}…` : line.text;
    const unchanged = expectedText.get(name) === line.text ? " (content unchanged)" : "";
    const truncatedNote = truncated
      ? " (truncated — re-read with `anchored: false` to copy verbatim)"
      : "";
    rows.push(`${line.anchor}§ ${text}    line ${line.lineNo}${unchanged}${truncatedNote}`);
  }

  if (rows.length === 0) {
    if (missing === 0) return undefined;
    return `\nAll named anchors no longer exist in the current file — re-read it before retrying.`;
  }
  const parts: string[] = [
    "Fresh coordinates in the current file (verify the content before retrying):",
  ];
  parts.push(...rows);
  if (overflow > 0) parts.push(`... ${overflow} more named anchors omitted.`);
  if (missing > 0) {
    parts.push(
      missing === 1
        ? "1 named anchor no longer exists (its line changed or was deleted) — re-read that region before retrying."
        : `${missing} named anchors no longer exist (their lines changed or were deleted) — re-read those regions before retrying.`,
    );
  }
  return `\n${parts.join("\n")}`;
}

export function planEdit(
  state: FileAnchorState,
  edit: AnchoredEdit,
  requireAnchorLines: boolean,
  index?: AnchorIndex,
): PlannedEdit {
  const idx = index ?? new AnchorIndex(state);
  verifyAnchorLines(state, edit, requireAnchorLines, idx);
  rejectAnchorMarkedText(edit);

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
    const startAnchor = idx.find(edit.startAnchor);
    const endAnchor = idx.find(edit.endAnchor);
    if (startAnchor === -1)
      throw anchorNotFoundError("start", edit.startAnchor, state, "startAnchorLine/endAnchorLine");
    if (endAnchor === -1)
      throw anchorNotFoundError("end", edit.endAnchor, state, "startAnchorLine/endAnchorLine");
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
    const index = idx.find(edit.anchor);
    if (index === -1) throw anchorNotFoundError("", edit.anchor, state, "anchorLine");
    const start = edit.position === "before" ? index : index + 1;
    return {
      edit,
      start,
      end: start - 1,
      replacementLines: splitTextPreserveFinal(edit.content).lines,
    };
  }

  const start = idx.find(edit.startAnchor);
  const end = idx.find(edit.endAnchor);
  if (start === -1)
    throw anchorNotFoundError("start", edit.startAnchor, state, "startAnchorLine/endAnchorLine");
  if (end === -1)
    throw anchorNotFoundError("end", edit.endAnchor, state, "startAnchorLine/endAnchorLine");
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

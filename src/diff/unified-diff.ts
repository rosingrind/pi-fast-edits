import { myersDiff, type DiffOp } from "./myers.js";

/**
 * Build a display diff in pi's built-in tool format.
 *
 * Removed lines are prefixed with `-`, added with `+`, context with a leading
 * space, and collapsed context is marked with a `...` line. Line numbers are
 * padded to a consistent width so columns align.
 *
 * When `ops` is supplied (already computed for `before`/`after`), it is reused
 * instead of re-running the Myers diff.
 */
/** One rendered diff line: prefix, padded number, content. */
function formatDiffLine(prefix: string, lineNo: number, width: number, text: string): string {
  return `${prefix}${String(lineNo).padStart(width, " ")} ${text}`;
}

/** Collapse marker for skipped context runs. */
function collapseLine(width: number): string {
  return ` ${"".padStart(width, " ")} ...`;
}

/**
 * Visible [from, to) index windows for one equal run, with "collapse"
 * markers where skipped context is abbreviated. Context adjacent to no
 * change produces an empty plan (skipped entirely).
 */
function contextPlan(
  count: number,
  hasLeading: boolean,
  hasTrailing: boolean,
  context: number,
): Array<{ from: number; to: number } | "collapse"> {
  if (!hasLeading && !hasTrailing) return [];
  if (hasLeading && hasTrailing) {
    if (count <= context * 2) return [{ from: 0, to: count }];
    return [{ from: 0, to: context }, "collapse", { from: count - context, to: count }];
  }
  if (hasLeading) {
    const shown = Math.min(count, context);
    const plan: Array<{ from: number; to: number } | "collapse"> = [{ from: 0, to: shown }];
    if (count - shown > 0) plan.push("collapse");
    return plan;
  }
  const skipped = Math.max(0, count - context);
  const plan: Array<{ from: number; to: number } | "collapse"> = [];
  if (skipped > 0) plan.push("collapse");
  plan.push({ from: skipped, to: count });
  return plan;
}

export function unifiedDiff(
  before: string[],
  after: string[],
  context = 4,
  ops?: DiffOp[],
): string {
  const diffOps = ops ?? myersDiff(before, after);
  const changed = diffOps.some((op) => op.type !== "equal");
  if (!changed) return "No changes.";

  const width = String(Math.max(before.length, after.length)).length;
  const out: string[] = [];
  let oldLine = 1;
  let newLine = 1;
  let lastWasChange = false;
  // Initial-state number for the next inserted line. A pure insertion sits at
  // the next original line's number; a replacement (delete-then-insert) sits
  // at the first deleted line's number. Stacked insertions increment.
  let insertNumber = 1;

  for (let i = 0; i < diffOps.length; i++) {
    const op = diffOps[i];
    if (op.type === "insert") {
      for (let k = 0; k < op.count; k++) {
        out.push(formatDiffLine("+", insertNumber, width, after[op.newStart + k]));
        insertNumber++;
        newLine++;
      }
      lastWasChange = true;
    } else if (op.type === "delete") {
      insertNumber = op.oldStart + 1;
      for (let k = 0; k < op.count; k++) {
        out.push(formatDiffLine("-", oldLine, width, before[op.oldStart + k]));
        oldLine++;
      }
      lastWasChange = true;
    } else {
      const count = op.count;
      const hasLeading = lastWasChange;
      const hasTrailing =
        i + 1 < diffOps.length &&
        (diffOps[i + 1].type === "insert" || diffOps[i + 1].type === "delete");
      const plan = contextPlan(count, hasLeading, hasTrailing, context);
      for (const part of plan) {
        if (part === "collapse") {
          out.push(collapseLine(width));
          continue;
        }
        for (let k = part.from; k < part.to; k++) {
          out.push(formatDiffLine(" ", oldLine + k, width, before[op.oldStart + k]));
        }
      }
      oldLine += count;
      newLine += count;
      insertNumber = oldLine;
      lastWasChange = false;
    }
  }
  return out.join("\n");
}

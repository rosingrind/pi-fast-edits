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

  for (let i = 0; i < diffOps.length; i++) {
    const op = diffOps[i];
    if (op.type === "insert") {
      for (let k = 0; k < op.count; k++) {
        out.push(`+${String(newLine).padStart(width, " ")} ${after[op.newStart + k]}`);
        newLine++;
      }
      lastWasChange = true;
    } else if (op.type === "delete") {
      for (let k = 0; k < op.count; k++) {
        out.push(`-${String(oldLine).padStart(width, " ")} ${before[op.oldStart + k]}`);
        oldLine++;
      }
      lastWasChange = true;
    } else {
      const count = op.count;
      const hasLeading = lastWasChange;
      const hasTrailing =
        i + 1 < diffOps.length &&
        (diffOps[i + 1].type === "insert" || diffOps[i + 1].type === "delete");
      const emit = (k: number) => {
        out.push(` ${String(oldLine + k).padStart(width, " ")} ${before[op.oldStart + k]}`);
      };
      const collapse = () => {
        out.push(` ${"".padStart(width, " ")} ...`);
      };
      if (hasLeading && hasTrailing) {
        if (count <= context * 2) {
          for (let k = 0; k < count; k++) emit(k);
        } else {
          for (let k = 0; k < context; k++) emit(k);
          collapse();
          for (let k = count - context; k < count; k++) emit(k);
        }
      } else if (hasLeading) {
        const shown = Math.min(count, context);
        for (let k = 0; k < shown; k++) emit(k);
        if (count - shown > 0) collapse();
      } else if (hasTrailing) {
        const skipped = Math.max(0, count - context);
        if (skipped > 0) collapse();
        for (let k = skipped; k < count; k++) emit(k);
      }
      // Else: context not adjacent to any change, skip entirely.
      oldLine += count;
      newLine += count;
      lastWasChange = false;
    }
  }
  return out.join("\n");
}

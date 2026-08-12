export type DiffOp =
  | { type: "equal"; oldStart: number; newStart: number; count: number }
  | { type: "delete"; oldStart: number; count: number }
  | { type: "insert"; newStart: number; count: number };

type Step =
  | { type: "equal"; oldIndex: number; newIndex: number }
  | { type: "delete"; oldIndex: number }
  | { type: "insert"; newIndex: number };

/**
 * Myers O(ND) shortest-edit-script diff at line granularity.
 *
 * A wrapper that trims the common prefix and suffix before delegating to the
 * core O(ND) search, then stitches the resulting ops back with the trimmed
 * range. Long inputs that share a large common prefix/suffix (the common case
 * for incremental file edits) therefore never pay the full diff cost.
 */
export function myersDiff<T>(oldLines: T[], newLines: T[]): DiffOp[] {
  // Trim the common prefix.
  let prefixLen = 0;
  while (
    prefixLen < oldLines.length &&
    prefixLen < newLines.length &&
    Object.is(oldLines[prefixLen], newLines[prefixLen])
  ) {
    prefixLen++;
  }

  // Trim the common suffix.
  let suffixLen = 0;
  while (
    suffixLen < oldLines.length - prefixLen &&
    suffixLen < newLines.length - prefixLen &&
    Object.is(oldLines[oldLines.length - 1 - suffixLen], newLines[newLines.length - 1 - suffixLen])
  ) {
    suffixLen++;
  }

  // Diff only the differing middle; fully-equal inputs produce no middle ops.
  const oldMiddle = oldLines.slice(prefixLen, oldLines.length - suffixLen);
  const newMiddle = newLines.slice(prefixLen, newLines.length - suffixLen);
  const ops = _myersDiffCore(oldMiddle, newMiddle);

  // Stitch the trimmed prefix/suffix back around the middle ops.
  const result: DiffOp[] = [];
  if (prefixLen > 0) {
    result.push({ type: "equal", oldStart: 0, newStart: 0, count: prefixLen });
  }
  for (const op of ops) {
    if (op.type === "equal") {
      result.push({
        type: "equal",
        oldStart: prefixLen + op.oldStart,
        newStart: prefixLen + op.newStart,
        count: op.count,
      });
    } else if (op.type === "delete") {
      result.push({
        type: "delete",
        oldStart: prefixLen + op.oldStart,
        count: op.count,
      });
    } else {
      result.push({
        type: "insert",
        newStart: prefixLen + op.newStart,
        count: op.count,
      });
    }
  }
  if (suffixLen > 0) {
    result.push({
      type: "equal",
      oldStart: oldLines.length - suffixLen,
      newStart: newLines.length - suffixLen,
      count: suffixLen,
    });
  }

  return result;
}

/**
 * Myers O(ND) shortest-edit-script diff on the (already trimmed) middle.
 *
 * The trace uses a flat Int32Array indexed by `k + offset` rather than a
 * `Map<number, number>`, keeping memory bounded and avoiding per-step map
 * allocation for large rewrites. Unreachable diagonals hold `-1`; they are
 * never consulted by the decision/backtrack guards, which only read reachable
 * neighbors.
 */
function _myersDiffCore<T>(oldLines: T[], newLines: T[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  const max = n + m;

  // A full O(ND) trace is memory-prohibitive for very large inputs (the trace
  // is quadratic in line count). A delete-all + insert-all script is correct
  // for anchor reconciliation — minimality is not required — and costs only
  // O(N+M) memory. At n + m >= 4000 (e.g. 2000+2000) the trace would be
  // ~128 MB, so we skip to the fallback to avoid an OOM.
  if (n + m >= 4000) {
    const ops: DiffOp[] = [];
    if (n > 0) ops.push({ type: "delete", oldStart: 0, count: n });
    if (m > 0) ops.push({ type: "insert", newStart: 0, count: m });
    return ops;
  }
  const offset = max;
  const size = max * 2 + 1;
  const trace: Int32Array[] = [];
  let v = new Int32Array(size).fill(-1);
  v[1 + offset] = 0;

  for (let d = 0; d <= max; d++) {
    const current = new Int32Array(size);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
        x = v[k + 1 + offset];
      } else {
        x = v[k - 1 + offset] + 1;
      }
      let y = x - k;
      while (x < n && y < m && Object.is(oldLines[x], newLines[y])) {
        x++;
        y++;
      }
      current[k + offset] = x;
      if (x >= n && y >= m) {
        trace.push(current);
        return compactSteps(backtrack(trace, oldLines, newLines, offset));
      }
    }
    trace.push(current);
    v = current;
  }

  // The search always terminates with a solution by d == max for non-empty
  // inputs, so reaching here with content means the diff genuinely failed —
  // silently returning `[]` would drop every change. An empty middle is the
  // one valid no-op that falls through to an empty result.
  if (n > 0 || m > 0) {
    throw new Error("Myers diff failed to produce an edit script.");
  }
  return [];
}

function backtrack<T>(trace: Int32Array[], oldLines: T[], newLines: T[], offset: number): Step[] {
  let x = oldLines.length;
  let y = newLines.length;
  const steps: Step[] = [];

  for (let d = trace.length - 1; d > 0; d--) {
    const v = trace[d - 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset]) ? k + 1 : k - 1;
    const prevX = v[prevK + offset];
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      steps.push({ type: "equal", oldIndex: x - 1, newIndex: y - 1 });
      x--;
      y--;
    }

    if (x === prevX) {
      steps.push({ type: "insert", newIndex: y - 1 });
      y--;
    } else {
      steps.push({ type: "delete", oldIndex: x - 1 });
      x--;
    }
  }

  while (x > 0 && y > 0 && Object.is(oldLines[x - 1], newLines[y - 1])) {
    steps.push({ type: "equal", oldIndex: x - 1, newIndex: y - 1 });
    x--;
    y--;
  }
  while (x > 0) steps.push({ type: "delete", oldIndex: --x });
  while (y > 0) steps.push({ type: "insert", newIndex: --y });

  return steps.reverse();
}

function compactSteps(steps: Step[]): DiffOp[] {
  const ops: DiffOp[] = [];
  for (const step of steps) {
    const last = ops.at(-1);
    if (step.type === "equal") {
      if (
        last?.type === "equal" &&
        last.oldStart + last.count === step.oldIndex &&
        last.newStart + last.count === step.newIndex
      ) {
        last.count++;
      } else {
        ops.push({
          type: "equal",
          oldStart: step.oldIndex,
          newStart: step.newIndex,
          count: 1,
        });
      }
    } else if (step.type === "delete") {
      if (last?.type === "delete" && last.oldStart + last.count === step.oldIndex) {
        last.count++;
      } else {
        ops.push({ type: "delete", oldStart: step.oldIndex, count: 1 });
      }
    } else {
      if (last?.type === "insert" && last.newStart + last.count === step.newIndex) {
        last.count++;
      } else {
        ops.push({ type: "insert", newStart: step.newIndex, count: 1 });
      }
    }
  }
  return ops;
}

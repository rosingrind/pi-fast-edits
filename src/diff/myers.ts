export type DiffOp =
  | { type: "equal"; oldStart: number; newStart: number; count: number }
  | { type: "delete"; oldStart: number; count: number }
  | { type: "insert"; newStart: number; count: number };

type Step =
  | { type: "equal"; oldIndex: number; newIndex: number }
  | { type: "delete"; oldIndex: number }
  | { type: "insert"; newIndex: number };

const NEG_INF = Number.NEGATIVE_INFINITY;

/**
 * Myers O(ND) shortest-edit-script diff at line granularity.
 */
export function myersDiff<T>(oldLines: T[], newLines: T[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  const max = n + m;
  const trace: Array<Map<number, number>> = [];
  let v = new Map<number, number>([[1, 0]]);

  for (let d = 0; d <= max; d++) {
    const current = new Map<number, number>();
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && get(v, k - 1) < get(v, k + 1))) {
        x = get(v, k + 1);
      } else {
        x = get(v, k - 1) + 1;
      }
      let y = x - k;
      while (x < n && y < m && Object.is(oldLines[x], newLines[y])) {
        x++;
        y++;
      }
      current.set(k, x);
      if (x >= n && y >= m) {
        trace.push(current);
        return compactSteps(backtrack(trace, oldLines, newLines));
      }
    }
    trace.push(current);
    v = current;
  }

  return [];
}

function get(map: Map<number, number>, key: number): number {
  return map.get(key) ?? NEG_INF;
}

function backtrack<T>(trace: Array<Map<number, number>>, oldLines: T[], newLines: T[]): Step[] {
  let x = oldLines.length;
  let y = newLines.length;
  const steps: Step[] = [];

  for (let d = trace.length - 1; d > 0; d--) {
    const v = trace[d - 1];
    const k = x - y;
    const prevK =
      k === -d || (k !== d && get(v, k - 1) < get(v, k + 1))
        ? k + 1
        : k - 1;
    const prevX = get(v, prevK);
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
      if (last?.type === "equal" && last.oldStart + last.count === step.oldIndex && last.newStart + last.count === step.newIndex) {
        last.count++;
      } else {
        ops.push({ type: "equal", oldStart: step.oldIndex, newStart: step.newIndex, count: 1 });
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

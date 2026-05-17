import { myersDiff } from "./myers.js";

export function unifiedDiff(path: string, before: string[], after: string[], context = 3): string {
  const ops = myersDiff(before, after);
  const changed = ops.some((op) => op.type !== "equal");
  if (!changed) return "No changes.";

  const out: string[] = [`--- a/${path}`, `+++ b/${path}`];
  const beforeShown = new Set<number>();
  const afterShown = new Set<number>();

  for (const op of ops) {
    if (op.type === "equal") {
      const start = Math.max(0, op.oldStart - context);
      const end = Math.min(before.length, op.oldStart + op.count + context);
      for (let i = start; i < end; i++) beforeShown.add(i);
      const newStart = Math.max(0, op.newStart - context);
      const newEnd = Math.min(after.length, op.newStart + op.count + context);
      for (let i = newStart; i < newEnd; i++) afterShown.add(i);
    }
  }

  let oldLine = 0;
  let newLine = 0;
  for (const op of ops) {
    if (op.type === "equal") {
      for (let k = 0; k < op.count; k++) {
        const oi = op.oldStart + k;
        if (beforeShown.has(oi)) out.push(` ${before[oi]}`);
      }
      oldLine += op.count;
      newLine += op.count;
    } else if (op.type === "delete") {
      for (let k = 0; k < op.count; k++) out.push(`-${before[op.oldStart + k]}`);
      oldLine += op.count;
    } else {
      for (let k = 0; k < op.count; k++) out.push(`+${after[op.newStart + k]}`);
      newLine += op.count;
    }
  }
  void oldLine;
  void newLine;
  return out.join("\n");
}

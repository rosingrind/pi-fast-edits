import { describe, expect, it } from "vitest";
import { unifiedDiff } from "../src/diff/unified-diff.js";

describe("unifiedDiff", () => {
  it("produces correct format for replacement", () => {
    const diff = unifiedDiff(["alpha", "beta", "gamma"], ["ALPHA", "beta", "gamma"]);
    expect(diff).toContain("-1 alpha");
    expect(diff).toContain("+1 ALPHA");
    expect(diff).toContain(" 2 beta");
    expect(diff).toContain(" 3 gamma");
  });

  it("produces correct format for insertion", () => {
    const diff = unifiedDiff(["a", "c"], ["a", "b", "c"]);
    expect(diff).toContain("+2 b");
    expect(diff).toContain(" 1 a");
  });

  it("produces correct format for deletion", () => {
    const diff = unifiedDiff(["a", "b", "c"], ["a", "c"]);
    expect(diff).toContain("-2 b");
    expect(diff).toContain(" 1 a");
  });

  it("reports no changes", () => {
    const diff = unifiedDiff(["a", "b"], ["a", "b"]);
    expect(diff).toBe("No changes.");
  });

  it("handles context collapse with ... marker", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const after = [...before.slice(0, 5), "MODIFIED", ...before.slice(6)];
    const diff = unifiedDiff(before, after);
    expect(diff).toContain("...");
    expect(diff).toContain("- 6 line 6");
    expect(diff).toContain("+ 6 MODIFIED");
  });

  it("handles trailing context", () => {
    const diff = unifiedDiff(["a", "b", "c", "d"], ["a", "B", "c", "d"]);
    expect(diff).toContain(" 3 c");
    expect(diff).toContain(" 4 d");
  });

  it("handles leading context", () => {
    const diff = unifiedDiff(["a", "b", "c", "d"], ["A", "b", "c", "d"]);
    expect(diff).toContain(" 2 b");
  });

  it("handles multiple changes", () => {
    const diff = unifiedDiff(["a", "b", "c", "d", "e"], ["A", "b", "C", "d", "E"]);
    expect(diff).toContain("-1 a");
    expect(diff).toContain("+1 A");
    expect(diff).toContain("-3 c");
    expect(diff).toContain("+3 C");
    expect(diff).toContain("-5 e");
    expect(diff).toContain("+5 E");
  });

  it("produces exact collapse format for middle change", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const after = ["a", "b", "c", "d", "E", "f", "g", "h", "i", "j"];
    const diff = unifiedDiff(before, after);
    // Middle change with padded line numbers and a `...` collapse on the trailing context.
    expect(diff).toContain("+ 5 E");
    expect(diff).toContain("- 5 e");
    expect(diff).toContain("    ...");
  });
});

import { describe, expect, it } from "vitest";
import { myersDiff } from "../src/diff/myers.js";

describe("myersDiff", () => {
  it("detects equal ranges", () => {
    expect(myersDiff(["a", "b"], ["a", "b"])).toEqual([
      { type: "equal", oldStart: 0, newStart: 0, count: 2 },
    ]);
  });

  it("detects insertion", () => {
    expect(myersDiff(["a", "c"], ["a", "b", "c"])).toContainEqual({
      type: "insert",
      newStart: 1,
      count: 1,
    });
  });

  it("detects deletion", () => {
    expect(myersDiff(["a", "b", "c"], ["a", "c"])).toContainEqual({
      type: "delete",
      oldStart: 1,
      count: 1,
    });
  });

  it("empty ↔ empty returns no changes", () => {
    expect(myersDiff([], [])).toEqual([]);
  });

  it("empty → content returns a single insertion", () => {
    expect(myersDiff([], ["a", "b"])).toEqual([{ type: "insert", newStart: 0, count: 2 }]);
  });

  it("content → empty returns a single deletion", () => {
    expect(myersDiff(["a", "b"], [])).toEqual([{ type: "delete", oldStart: 0, count: 2 }]);
  });

  it("complete replacement returns delete then insert", () => {
    const result = myersDiff(["a", "b"], ["x", "y"]);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("delete");
    expect(result[1].type).toBe("insert");
  });
});

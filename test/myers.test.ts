import { describe, expect, it } from "vitest";
import { myersDiff } from "../src/diff/myers.js";

describe("myersDiff", () => {
  it("detects equal ranges", () => {
    expect(myersDiff(["a", "b"], ["a", "b"])).toEqual([
      { type: "equal", oldStart: 0, newStart: 0, count: 2 }
    ]);
  });

  it("detects insertion", () => {
    expect(myersDiff(["a", "c"], ["a", "b", "c"])).toContainEqual({ type: "insert", newStart: 1, count: 1 });
  });

  it("detects deletion", () => {
    expect(myersDiff(["a", "b", "c"], ["a", "c"])).toContainEqual({ type: "delete", oldStart: 1, count: 1 });
  });
});

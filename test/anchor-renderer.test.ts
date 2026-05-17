import { describe, expect, it } from "vitest";
import { renderAnchoredLine } from "../src/anchor/anchor-renderer.js";

describe("anchor renderer", () => {
  it("renders blank lines with anchors", () => {
    expect(renderAnchoredLine({ anchor: "Apple", text: "", lineNo: 1, lineHash: "x" })).toBe("Apple§ ");
  });
});

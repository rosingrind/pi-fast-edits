import { describe, expect, it } from "vitest";
import { renderAnchoredLines } from "../src/anchor/anchor-renderer.js";

describe("anchor renderer", () => {
  it("renders blank lines with anchors", () => {
    expect(
      renderAnchoredLines([
        {
          anchor: "Apple",
          text: "",
          lineNo: 1,
        },
      ]),
    ).toBe("Apple§ ");
  });
});

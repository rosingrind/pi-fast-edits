import { describe, expect, it } from "vitest";
import { parseAnchoredCoordinate } from "../src/anchor/anchor-renderer.js";

describe("parseAnchoredCoordinate", () => {
  it("parses a bare anchor", () => {
    expect(parseAnchoredCoordinate("Delta")).toEqual({ anchor: "Delta" });
  });
  it("parses a full coordinate", () => {
    expect(parseAnchoredCoordinate("Delta§const x = 1;")).toEqual({
      anchor: "Delta",
      content: "const x = 1;",
    });
  });
  it("keeps § inside content intact (first § splits)", () => {
    expect(parseAnchoredCoordinate("Delta§a§b")).toEqual({
      anchor: "Delta",
      content: "a§b",
    });
  });
  it("returns null for empty input", () => {
    expect(parseAnchoredCoordinate("")).toBeNull();
    expect(parseAnchoredCoordinate("§orphan")).toBeNull();
  });
});

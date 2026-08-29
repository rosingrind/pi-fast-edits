import { describe, expect, it } from "vitest";
import { parseRgLine } from "../src/fs/rg-search.js";

describe("parseRgLine", () => {
  it("parses a match event", () => {
    const line = JSON.stringify({
      type: "match",
      data: {
        path: { text: "src/a.ts" },
        line_number: 42,
        lines: { text: "export const x = 1;\n" },
        submatches: [{ start: 14 }],
      },
    });
    expect(parseRgLine(line)).toEqual({
      file: "src/a.ts",
      lineNo: 42,
      content: "export const x = 1;\n",
      isMatch: true,
    });
  });

  it("parses a context event with isMatch false", () => {
    const line = JSON.stringify({
      type: "context",
      data: {
        path: { text: "b.md" },
        line_number: 3,
        lines: { text: "- alpha\n" },
      },
    });
    expect(parseRgLine(line)).toEqual({
      file: "b.md",
      lineNo: 3,
      content: "- alpha\n",
      isMatch: false,
    });
  });

  it("returns null for non-hit events and malformed lines", () => {
    const begin = JSON.stringify({
      type: "begin",
      data: { path: { text: "x" } },
    });
    expect(parseRgLine(begin)).toBeNull();
    expect(parseRgLine("not json")).toBeNull();
    expect(parseRgLine("")).toBeNull();
    expect(parseRgLine("null")).toBeNull();
  });
});

describe("runRg (integration)", () => {
  // Runs whenever a ripgrep binary resolves (pi tool cache first, then PATH);
  // skips quietly otherwise, e.g. CI without ripgrep.
  it("collects hits from a real directory", async () => {
    const { resolveRg } = await import("../src/fs/rg-resolver.js");
    const rgPath = await resolveRg();
    if (!rgPath) return; // skip quietly
    const { runRg } = await import("../src/fs/rg-search.js");
    const hits = await runRg(rgPath, ["--json", "-e", "MAX_RETIRED_ANCHORS", "src"]);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({ isMatch: true });
    expect(hits.every((h) => typeof h.lineNo === "number" && h.lineNo >= 1)).toBe(true);
  });
});

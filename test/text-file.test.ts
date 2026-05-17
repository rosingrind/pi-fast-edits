import { describe, expect, it } from "vitest";
import { joinLines, splitTextPreserveFinal } from "../src/fs/text-file.js";

describe("text file helpers", () => {
  it("preserves final newline", () => {
    const parsed = splitTextPreserveFinal("a\nb\n");
    expect(parsed.lines).toEqual(["a", "b"]);
    expect(parsed.hadFinalNewline).toBe(true);
    expect(joinLines(parsed.lines, parsed.lineEnding, parsed.hadFinalNewline)).toBe("a\nb\n");
  });

  it("preserves no final newline", () => {
    const parsed = splitTextPreserveFinal("a\nb");
    expect(parsed.hadFinalNewline).toBe(false);
    expect(joinLines(parsed.lines, parsed.lineEnding, parsed.hadFinalNewline)).toBe("a\nb");
  });
});

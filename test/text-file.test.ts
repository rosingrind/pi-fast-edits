import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { joinLines, readTextFile, splitTextPreserveFinal } from "../src/fs/text-file.js";

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

  it("joins an empty line list with only the final newline when requested", () => {
    expect(joinLines([], "\n", true)).toBe("\n");
  });

  it("empty string splits to no lines, no final newline", () => {
    const result = splitTextPreserveFinal("");
    expect(result.lines).toEqual([]);
    expect(result.hadFinalNewline).toBe(false);
    expect(result.lineEnding).toBe("\n");
  });

  it("empty string round-trips through joinLines", () => {
    const split = splitTextPreserveFinal("");
    const joined = joinLines(split.lines, split.lineEnding, split.hadFinalNewline);
    expect(joined).toBe("");
  });

  it("detects majority line ending in mixed file", () => {
    // 2 CRLF vs 1 LF → should detect CRLF
    const result = splitTextPreserveFinal("a\r\nb\r\nc\n");
    expect(result.lineEnding).toBe("\r\n");
  });

  it("CR-only file parses as single line", () => {
    const result = splitTextPreserveFinal("a\rb\rc");
    expect(result.lines).toEqual(["a\rb\rc"]);
    expect(result.hadFinalNewline).toBe(false);
  });

  it("valid UTF-8 containing U+FFFD is rejected as binary (current behavior)", async () => {
    // U+FFFD is the valid UTF-8 encoding of the replacement character.
    const filePath = join(tmpdir(), `pfe-fffd-${Date.now()}.txt`);
    await writeFile(filePath, "hello\n\uFFFD\nworld\n", "utf8");
    // Current behavior: looksBinary flags any file whose decoded text contains
    // U+FFFD, even though these bytes are valid UTF-8.
    await expect(readTextFile(filePath)).rejects.toThrow("binary");
  });
});

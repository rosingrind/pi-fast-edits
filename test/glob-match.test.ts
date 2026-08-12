import { describe, expect, it } from "vitest";
import { globToRegExp, matchesGlob } from "../src/fs/glob-match.js";

describe("globToRegExp", () => {
  it("matches * against filename without crossing directories", () => {
    const re = globToRegExp("*.txt");
    expect(re.test("file.txt")).toBe(true);
    expect(re.test("sub/file.txt")).toBe(false);
  });

  it("matches ** against anything including slashes", () => {
    const re = globToRegExp("dir/**");
    expect(re.test("dir/file.txt")).toBe(true);
    expect(re.test("dir/sub/file.txt")).toBe(true);
  });

  it("matches ? against a single character", () => {
    const re = globToRegExp("?.txt");
    expect(re.test("a.txt")).toBe(true);
    expect(re.test("ab.txt")).toBe(false);
  });

  it("escapes regex special characters", () => {
    const re = globToRegExp("file[1].txt");
    expect(re.test("file[1].txt")).toBe(true);
    expect(re.test("file1.txt")).toBe(false);
  });
});

describe("matchesGlob", () => {
  it("matches .env", () => {
    expect(matchesGlob(".env", ".env")).toBe(true);
  });

  it("matches .env.local via .env.*", () => {
    expect(matchesGlob(".env.local", ".env.*")).toBe(true);
  });

  it("matches .git/config via .git/**", () => {
    expect(matchesGlob(".git/config", ".git/**")).toBe(true);
  });

  it("does not let .git/** match a nested .git directory", () => {
    expect(matchesGlob("submodule/.git/config", ".git/**")).toBe(false);
  });

  it("matches migrations/001.js via migrations/**", () => {
    expect(matchesGlob("migrations/001.js", "migrations/**")).toBe(true);
  });

  it("matches an exact package-lock.json", () => {
    expect(matchesGlob("package-lock.json", "package-lock.json")).toBe(true);
  });

  it("rejects non-matching paths", () => {
    expect(matchesGlob("migrations-sub/file.txt", "migrations/**")).toBe(false);
    expect(matchesGlob("not-env.txt", ".env.*")).toBe(false);
  });
});

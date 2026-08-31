import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { collectReadRoots, displayPathFor, piDocsRoot } from "../src/fs/read-roots.js";

describe("collectReadRoots", () => {
  it("collects skill baseDirs and the pi package root", () => {
    const roots = collectReadRoots(
      [
        { name: "a", baseDir: "/agents/skills/a" },
        { name: "b", baseDir: "/agents/skills/b" },
      ],
      "/pi-package",
    );
    expect(roots).toContain("/agents/skills/a");
    expect(roots).toContain("/agents/skills/b");
    expect(roots).toContain("/pi-package");
  });

  it("dedupes roots", () => {
    const roots = collectReadRoots(
      [
        { name: "a", baseDir: "/dup" },
        { name: "b", baseDir: "/dup" },
      ],
      "/dup",
    );
    expect(roots).toEqual(["/dup"]);
  });

  it("drops skills without a baseDir and tolerates a missing package root", () => {
    const roots = collectReadRoots([{ name: "a" }, { name: "b", baseDir: "/kept" }], undefined);
    expect(roots).toEqual(["/kept"]);
  });
});

describe("displayPathFor", () => {
  it("shortens paths under the home directory", () => {
    expect(displayPathFor("/home/u/proj/a.ts", "/home/u")).toBe("~/proj/a.ts");
  });

  it("leaves non-home absolute paths untouched", () => {
    expect(displayPathFor("/etc/passwd", "/home/u")).toBe("/etc/passwd");
  });

  it("returns the path as-is when no home is known", () => {
    expect(displayPathFor("/etc/passwd", undefined)).toBe("/etc/passwd");
  });
});

describe("piDocsRoot", () => {
  it("resolves the installed pi package root through the exports-safe main entry", () => {
    const root = piDocsRoot();
    expect(root).toBeDefined();
    // The climb must land on the directory that owns pi's package.json.
    expect(existsSync(join(root!, "package.json"))).toBe(true);
  });
});

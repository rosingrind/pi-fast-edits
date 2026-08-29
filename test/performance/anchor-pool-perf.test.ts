import { describe, expect, it } from "vitest";
import { writeFile, rm, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AnchorPool } from "../../src/anchor/anchor-pool.js";
import { createFileAnchorState } from "../../src/anchor/anchor-state.js";

describe("AnchorPool Performance", () => {
  // Use a fresh pool for each test to avoid state pollution from other tests
  const freshPool = () => new AnchorPool();

  describe("pool cycles beyond 200 unique anchors", () => {
    it("pool handles 250 unique anchors with correct cycling", () => {
      const pool = freshPool();
      const anchors: string[] = [];

      for (let i = 0; i < 250; i++) {
        anchors.push(pool.next());
      }

      // First 200: no digits
      for (let i = 0; i < 200; i++) {
        expect(anchors[i]).not.toMatch(/\d/);
      }

      // Last 50: must have digits
      for (let i = 200; i < 250; i++) {
        expect(anchors[i]).toMatch(/\d/);
      }

      // All anchors should be unique
      expect(new Set(anchors).size).toBe(250);
    });

    it("createFileAnchorState assigns correct anchors for >200 line file", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "pool-perf-"));
      const filePath = join(tmp, "large.txt");

      // Create file with 250 unique lines
      const lines: string[] = [];
      for (let i = 0; i < 250; i++) {
        lines.push(`unique line number ${i} with distinct content`);
      }
      await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");

      // Read file to create state with anchors
      const content = await readFile(filePath, "utf8");
      const state = createFileAnchorState(
        filePath,
        content.split("\n").filter((line: string) => line !== ""),
        "\n",
        false,
        false,
        content,
      );

      // Verify we have anchors for all 250 lines
      expect(state.lines).toHaveLength(250);

      // First 200 should be single words (no digits)
      const firstAnchors = state.lines.slice(0, 200).map((l) => l.anchor);
      for (const anchor of firstAnchors) {
        expect(anchor).not.toMatch(/\d/);
      }

      // Last 50 should have numeric suffix
      const nextAnchors = state.lines.slice(200, 250).map((l) => l.anchor);
      for (const anchor of nextAnchors) {
        expect(anchor).toMatch(/\d/);
      }

      // All anchors should be unique
      expect(new Set(state.lines.map((l) => l.anchor)).size).toBe(250);

      await rm(tmp, { recursive: true, force: true });
    });

    it("suffix increments correctly when cycling again", () => {
      const pool = freshPool();

      // Get 401 anchors to verify 3rd cycle
      const anchors: string[] = [];
      for (let i = 0; i < 401; i++) {
        anchors.push(pool.next());
      }

      // First 200: no suffix
      // 200-399: suffix "2"
      // 400+: suffix "3"

      // Anchor at index 400 should have suffix 3
      const anchor400 = anchors[400];
      expect(anchor400).toMatch(/3$/);

      // Anchor at index 200 should have suffix 2
      const anchor200 = anchors[200];
      expect(anchor200).toMatch(/2$/);
    });

    it("retired anchors are not reused", () => {
      const pool = freshPool();
      const a1 = pool.next();
      pool.retire(a1);
      const a2 = pool.next();

      // Retired anchor should not be issued again
      expect(a2).not.toBe(a1);

      // But if we mark a1 as used again, it should be available
      pool.markUsed(a1);
      const a3 = pool.next();
      // a3 should be a fresh anchor (not a1, not a2)
      expect(a3).not.toBe(a1);
      expect(a3).not.toBe(a2);
    });
  });
});

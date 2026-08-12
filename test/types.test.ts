import { describe, expect, it } from "vitest";
import { LRUMap } from "../src/types.js";

describe("LRUMap", () => {
  it("sets and gets entries, preserving insertion order", () => {
    const map = new LRUMap<string, number>(50);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    expect([...map.keys()]).toEqual(["a", "b", "c"]);
    expect(map.get("a")).toBe(1);
    expect(map.get("b")).toBe(2);
    expect(map.get("c")).toBe(3);
    expect(map.size).toBe(3);
  });

  it("evicts the least-recently-used entry when over capacity", () => {
    const map = new LRUMap<string, number>(50);
    for (let i = 0; i < 51; i++) {
      map.set(`k${i}`, i);
    }
    // 51 sets into a 50-capacity map evicts the oldest, k0.
    expect(map.size).toBe(50);
    expect(map.has("k0")).toBe(false);
    expect(map.get("k0")).toBeUndefined();
    // The newest 50 survive.
    expect(map.has("k50")).toBe(true);
    expect(map.has("k1")).toBe(true);
  });

  it("refreshes recency on get so touched entries are not evicted next", () => {
    const map = new LRUMap<string, number>(50);
    // 51 sets into a 50-capacity map evicts k0; k1 is now the LRU.
    for (let i = 0; i < 51; i++) {
      map.set(`k${i}`, i);
    }
    expect(map.has("k0")).toBe(false);
    // Touching the current LRU (k1) promotes it to MRU, so a subsequent write
    // evicts k2 instead.
    expect(map.get("k1")).toBe(1);
    map.set("new", 999);
    expect(map.size).toBe(50);
    expect(map.has("k1")).toBe(true);
    expect(map.has("k2")).toBe(false);
    expect(map.has("k3")).toBe(true);
  });

  it("keeps size bounded to the limit under sustained writes", () => {
    const map = new LRUMap<string, number>(50);
    for (let i = 0; i < 100; i++) {
      map.set(`k${i}`, i);
    }
    expect(map.size).toBe(50);
    // Only the most recent 50 keys survive.
    for (let i = 0; i < 50; i++) {
      expect(map.has(`k${i}`)).toBe(false);
    }
    for (let i = 50; i < 100; i++) {
      expect(map.has(`k${i}`)).toBe(true);
    }
  });

  it("re-setting an existing key updates its value and moves it to MRU", () => {
    const map = new LRUMap<string, number>(50);
    for (let i = 0; i < 50; i++) {
      map.set(`k${i}`, i);
    }
    // Touch the oldest, then overwrite it; overwriting moves it to MRU so the
    // next write evicts k1, not the overwritten key.
    map.set("k0", 100);
    map.set("evictor", 999);
    expect(map.get("k0")).toBe(100);
    expect(map.has("k1")).toBe(false);
  });
});

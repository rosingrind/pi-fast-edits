import { WORD_ANCHORS } from "./word-list.js";

/**
 * Deterministic per-file rng seed: stable across evictions, unique-ish per path.
 * FNV-1a over the path, then a small mulberry32 PRNG.
 */
export function poolRngForPath(path: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) {
    h = Math.imul(h ^ path.charCodeAt(i), 16777619);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class AnchorPool {
  private readonly pool: string[];
  private index = 0;
  private readonly used = new Set<string>();
  private readonly retired = new Set<string>();

  constructor(rng: () => number = Math.random) {
    this.pool = [...WORD_ANCHORS];
    // Fisher-Yates with the injectable rng.
    for (let i = this.pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [this.pool[i], this.pool[j]] = [this.pool[j], this.pool[i]];
    }
  }

  markUsed(anchor: string): void {
    this.used.add(anchor);
  }

  retire(anchor: string): void {
    this.used.delete(anchor);
    this.retired.add(anchor);
  }

  next(): string {
    while (true) {
      const anchor = this.makeCandidate(this.index++);
      if (!this.used.has(anchor) && !this.retired.has(anchor)) {
        this.used.add(anchor);
        return anchor;
      }
    }
  }

  private makeCandidate(index: number): string {
    const word = this.pool[index % this.pool.length];
    const cycle = Math.floor(index / this.pool.length);
    return cycle === 0 ? word : `${word}${cycle + 1}`;
  }
}

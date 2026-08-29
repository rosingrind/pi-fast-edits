import { WORD_ANCHORS } from "./word-list.js";

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

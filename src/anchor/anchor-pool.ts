import { WORD_ANCHORS } from "./word-list.js";

export class AnchorPool {
  private readonly used = new Set<string>();
  private readonly retired = new Set<string>();
  private cursor = 0;

  constructor(private readonly seedWords = WORD_ANCHORS) {}

  markUsed(anchor: string): void {
    this.used.add(anchor);
  }

  retire(anchor: string): void {
    this.used.delete(anchor);
    this.retired.add(anchor);
  }

  next(): string {
    while (true) {
      const anchor = this.makeCandidate(this.cursor++);
      if (!this.used.has(anchor) && !this.retired.has(anchor)) {
        this.used.add(anchor);
        return anchor;
      }
    }
  }

  private makeCandidate(index: number): string {
    const word = this.seedWords[index % this.seedWords.length];
    const cycle = Math.floor(index / this.seedWords.length);
    return cycle === 0 ? word : `${word}${cycle + 1}`;
  }
}

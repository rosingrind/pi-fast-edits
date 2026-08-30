export type ConfirmationMode = "always" | "protected-paths" | "never";

export type PiFastEditsConfig = {
  overrideBuiltInEditTools: boolean;
  confirmation: ConfirmationMode;
  /** When true (default), edit tools require the exact anchor line content (startAnchorLine/endAnchorLine/anchorLine) on every edit. */
  requireAnchorLines: boolean;
  maxRangeReadLines: number;
  protectedPaths: string[];
};

export type LineEnding = "\n" | "\r\n";

export type AnchoredLine = {
  anchor: string;
  text: string;
  lineNo: number;
};

export type FileAnchorState = {
  path: string;
  revisionHash: string;
  lineEnding: LineEnding;
  hadFinalNewline: boolean;
  hadBom: boolean;
  lines: AnchoredLine[];
  retiredAnchors: Set<string>;
};

/**
 * A Map bounded to `maxSize` entries that evicts the least-recently-used key
 * when full. `loadStateForPath` rebuilds evicted entries from disk on the next
 * touch, so eviction is safe and keeps the session cache from growing unbounded.
 */
export class LRUMap<K, V> extends Map<K, V> {
  private readonly maxSize: number;
  private readonly order: K[] = [];

  constructor(maxSize = 50) {
    super();
    this.maxSize = maxSize;
  }

  override get(key: K): V | undefined {
    const value = super.get(key);
    if (value !== undefined) {
      const idx = this.order.indexOf(key);
      if (idx >= 0) {
        this.order.splice(idx, 1);
        this.order.push(key);
      }
    }
    return value;
  }

  override set(key: K, value: V): this {
    const existing = this.order.indexOf(key);
    if (existing >= 0) {
      this.order.splice(existing, 1);
    } else if (this.order.length >= this.maxSize) {
      const evicted = this.order.shift();
      if (evicted !== undefined) super.delete(evicted);
    }
    super.set(key, value);
    this.order.push(key);
    return this;
  }

  override delete(key: K): boolean {
    const idx = this.order.indexOf(key);
    if (idx >= 0) this.order.splice(idx, 1);
    return super.delete(key);
  }

  override clear(): void {
    this.order.length = 0;
    super.clear();
  }
}

export type SessionState = {
  files: LRUMap<string, FileAnchorState>;
};

export type ReadMode = "auto" | "full" | "range";

type RevisionGuard = {
  /** Optional read_anchored revision hash. If provided, edits fail when the file changed since the read. */
  expectedRevision?: string;
};

type ReplaceEdit = RevisionGuard & {
  type: "replace";
  path: string;
  startAnchor: string;
  endAnchor: string;
  /** Expected current source line at startAnchor, verified before editing (strict) or when provided (lenient). */
  startAnchorLine?: string;
  /** Expected current source line at endAnchor, verified before editing (strict) or when provided (lenient). */
  endAnchorLine?: string;
  /** Accept anchor-marked text (`Word§...`) inside the replacement as genuine content. Default false — rejected. */
  allowAnchoredLines?: boolean;
  replacement: string;
  includeStart?: boolean;
  includeEnd?: boolean;
};

type InsertEdit = RevisionGuard & {
  type: "insert";
  path: string;
  anchor: string;
  /** Expected current source line at anchor, verified before editing (strict) or when provided (lenient). */
  anchorLine?: string;
  position: "before" | "after";
  content: string;
  /** Accept anchor-marked text (`Word§...`) inside the content as genuine content. Default false — rejected. */
  allowAnchoredLines?: boolean;
};

type DeleteEdit = RevisionGuard & {
  type: "delete";
  path: string;
  startAnchor: string;
  endAnchor: string;
  /** Expected current source line at startAnchor, verified before editing (strict) or when provided (lenient). */
  startAnchorLine?: string;
  /** Expected current source line at endAnchor, verified before editing (strict) or when provided (lenient). */
  endAnchorLine?: string;
};

export type AnchoredEdit = ReplaceEdit | InsertEdit | DeleteEdit;

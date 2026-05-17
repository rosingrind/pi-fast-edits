export type ConfirmationMode = "always" | "protected-paths" | "never";

export type PiFastEditsConfig = {
  overrideBuiltInEditTools: boolean;
  confirmation: ConfirmationMode;
  largeFileMode: "dirac-like";
  maxFullReadBytes: number;
  maxFullReadLines: number;
  maxRangeReadLines: number;
  maxSkeletonItems: number;
  protectedPaths: string[];
  returnDiffsAfterEdit: boolean;
  returnUpdatedAnchorsAfterEdit: boolean;
};

export type LineEnding = "\n" | "\r\n";

export type AnchoredLine = {
  anchor: string;
  text: string;
  lineNo: number;
  lineHash: string;
};

export type FileAnchorState = {
  path: string;
  revisionHash: string;
  lineEnding: LineEnding;
  hadFinalNewline: boolean;
  lines: AnchoredLine[];
  retiredAnchors: Set<string>;
};

export type SessionState = {
  files: Map<string, FileAnchorState>;
};

export type ReadMode = "auto" | "full" | "range" | "skeleton";

export type RevisionGuard = {
  /** Optional read_anchored_file revision hash. If provided, edits fail when the file changed since the read. */
  expectedRevision?: string;
};

export type ReplaceEdit = RevisionGuard & {
  type: "replace";
  path: string;
  startAnchor: string;
  endAnchor: string;
  replacement: string;
  includeStart?: boolean;
  includeEnd?: boolean;
};

export type InsertEdit = RevisionGuard & {
  type: "insert";
  path: string;
  anchor: string;
  position: "before" | "after";
  content: string;
};

export type DeleteEdit = RevisionGuard & {
  type: "delete";
  path: string;
  startAnchor: string;
  endAnchor: string;
};

export type AnchoredEdit = ReplaceEdit | InsertEdit | DeleteEdit;

export type ToolTextResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
};

import { Type } from "typebox";

/**
 * Shared edit-payload schemas, built per registration so strictness follows the
 * live `requireAnchorLines` setting. Each single-edit tool reuses the schema
 * for its edit kind (its kind is implicit), while the batch tool reuses the
 * same payloads wrapped with an explicit `type` discriminator.
 *
 * Param types are hand-written (not `Static<typeof schema>`) because the
 * `*Line` fields are conditionally optional — deriving them from the schema
 * would require picking the schema variant.
 */

export type ReplaceEditParams = {
  path: string;
  startAnchor: string;
  endAnchor: string;
  replacement: string;
  startAnchorLine?: string;
  endAnchorLine?: string;
  includeStart?: boolean;
  includeEnd?: boolean;
  allowAnchoredLines?: boolean;
  expectedRevision?: string;
};

export type InsertEditParams = {
  path: string;
  anchor: string;
  position: "before" | "after";
  content: string;
  anchorLine?: string;
  allowAnchoredLines?: boolean;
  expectedRevision?: string;
};

export type DeleteEditParams = {
  path: string;
  startAnchor: string;
  endAnchor: string;
  startAnchorLine?: string;
  endAnchorLine?: string;
  expectedRevision?: string;
};

export type BatchEditParams =
  | ({ type: "replace" } & ReplaceEditParams)
  | ({ type: "insert" } & InsertEditParams)
  | ({ type: "delete" } & DeleteEditParams);

export type BatchEditsParams = { edits: BatchEditParams[] };

/** The anchor's `*Line` companion: required (strict) or optional (lenient). */
function anchorLineSchema(requireAnchorLines: boolean, at: string) {
  const description = requireAnchorLines
    ? `The exact current source line at ${at}, copied verbatim from read/grep output. Verified before editing; mismatch rejects the edit.`
    : `Optional. When provided, verified against the anchor's current line; mismatch rejects the edit.`;
  return requireAnchorLines
    ? Type.String({ description })
    : Type.Optional(Type.String({ description }));
}

export function replaceEditSchema(requireAnchorLines: boolean) {
  return Type.Object({
    path: Type.String({ description: "Path to the file to edit." }),
    startAnchor: Type.String({
      description: "Start anchor of the range to replace (anchor word from read/grep output).",
    }),
    endAnchor: Type.String({
      description: "End anchor of the range to replace (anchor word from read/grep output).",
    }),
    startAnchorLine: anchorLineSchema(requireAnchorLines, "startAnchor"),
    endAnchorLine: anchorLineSchema(requireAnchorLines, "endAnchor"),
    replacement: Type.String({
      description:
        "New content to replace the anchor range. Raw text only — anchor-marked text (`Word§...`) is rejected unless allowAnchoredLines is true.",
    }),
    includeStart: Type.Optional(Type.Boolean({ description: "Include the start anchor line." })),
    includeEnd: Type.Optional(Type.Boolean({ description: "Include the end anchor line." })),
    expectedRevision: Type.Optional(
      Type.String({
        description: "Current revision hash for the file; a stale value rejects the edit.",
      }),
    ),
  });
}

export function insertEditSchema(requireAnchorLines: boolean) {
  return Type.Object({
    path: Type.String({ description: "Path to the file to edit." }),
    anchor: Type.String({
      description: "Anchor to insert before or after (anchor word from read/grep output).",
    }),
    anchorLine: anchorLineSchema(requireAnchorLines, "anchor"),
    position: Type.Union([Type.Literal("before"), Type.Literal("after")], {
      description: "Insert before or after the anchor.",
    }),
    content: Type.String({
      description:
        "Content to insert. Raw text only — anchor-marked text (`Word§...`) is rejected unless allowAnchoredLines is true.",
    }),
    allowAnchoredLines: Type.Optional(
      Type.Boolean({
        description:
          "Accept anchor-marked text (`Word§...`) inside the content as genuine content. Default false (rejected).",
      }),
    ),
    expectedRevision: Type.Optional(
      Type.String({
        description: "Current revision hash for the file; a stale value rejects the edit.",
      }),
    ),
  });
}

export function deleteEditSchema(requireAnchorLines: boolean) {
  return Type.Object({
    path: Type.String({ description: "Path to the file to edit." }),
    startAnchor: Type.String({
      description: "Start anchor of the range to delete (anchor word from read/grep output).",
    }),
    endAnchor: Type.String({
      description: "End anchor of the range to delete (anchor word from read/grep output).",
    }),
    startAnchorLine: anchorLineSchema(requireAnchorLines, "startAnchor"),
    endAnchorLine: anchorLineSchema(requireAnchorLines, "endAnchor"),
    expectedRevision: Type.Optional(
      Type.String({
        description: "Current revision hash for the file; a stale value rejects the edit.",
      }),
    ),
  });
}

function taggedReplace(requireAnchorLines: boolean) {
  return Type.Intersect([
    Type.Object({ type: Type.Literal("replace") }),
    replaceEditSchema(requireAnchorLines),
  ]);
}

function taggedInsert(requireAnchorLines: boolean) {
  return Type.Intersect([
    Type.Object({ type: Type.Literal("insert") }),
    insertEditSchema(requireAnchorLines),
  ]);
}

function taggedDelete(requireAnchorLines: boolean) {
  return Type.Intersect([
    Type.Object({ type: Type.Literal("delete") }),
    deleteEditSchema(requireAnchorLines),
  ]);
}

export function editSchema(requireAnchorLines: boolean) {
  return Type.Union([
    taggedReplace(requireAnchorLines),
    taggedInsert(requireAnchorLines),
    taggedDelete(requireAnchorLines),
  ]);
}

export function batchEditsSchema(requireAnchorLines: boolean) {
  return Type.Object({ edits: Type.Array(editSchema(requireAnchorLines)) });
}

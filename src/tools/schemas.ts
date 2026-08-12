import { Type } from "typebox";

/**
 * Shared edit-payload schemas. Each single-edit tool reuses the schema for its
 * edit kind (its kind is implicit), while the batch tool reuses the same
 * payloads wrapped with an explicit `type` discriminator.
 */

export const replaceEditSchema = Type.Object({
  path: Type.String({ description: "Path to the file to edit." }),
  startAnchor: Type.String({ description: "Start anchor of the range to replace." }),
  endAnchor: Type.String({ description: "End anchor of the range to replace." }),
  replacement: Type.String({
    description:
      "New content to replace the anchor range. Use raw text only — do NOT include the § anchor marker.",
  }),
  includeStart: Type.Optional(Type.Boolean({ description: "Include the start anchor line." })),
  includeEnd: Type.Optional(Type.Boolean({ description: "Include the end anchor line." })),
  expectedRevision: Type.Optional(
    Type.String({ description: "Revision hash from read_anchored_file to prevent stale edits." }),
  ),
});

export const insertEditSchema = Type.Object({
  path: Type.String({ description: "Path to the file to edit." }),
  anchor: Type.String({ description: "Anchor to insert before or after." }),
  position: Type.Union([Type.Literal("before"), Type.Literal("after")], {
    description: "Insert before or after the anchor.",
  }),
  content: Type.String({
    description: "Content to insert. Use raw text only — do NOT include the § anchor marker.",
  }),
  expectedRevision: Type.Optional(
    Type.String({ description: "Revision hash from read_anchored_file to prevent stale edits." }),
  ),
});

export const deleteEditSchema = Type.Object({
  path: Type.String({ description: "Path to the file to edit." }),
  startAnchor: Type.String({ description: "Start anchor of the range to delete." }),
  endAnchor: Type.String({ description: "End anchor of the range to delete." }),
  expectedRevision: Type.Optional(
    Type.String({ description: "Revision hash from read_anchored_file to prevent stale edits." }),
  ),
});

const taggedReplace = Type.Intersect([
  Type.Object({ type: Type.Literal("replace") }),
  replaceEditSchema,
]);
const taggedInsert = Type.Intersect([
  Type.Object({ type: Type.Literal("insert") }),
  insertEditSchema,
]);
const taggedDelete = Type.Intersect([
  Type.Object({ type: Type.Literal("delete") }),
  deleteEditSchema,
]);

export const editSchema = Type.Union([taggedReplace, taggedInsert, taggedDelete]);
export const batchEditsSchema = Type.Object({ edits: Type.Array(editSchema) });

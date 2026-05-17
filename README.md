# pi-fast-edits

Dirac-style fast file editing tools for the Pi coding agent.

## Attribution

All credit for the core idea behind this extension goes to [Max Trivedi](https://www.linkedin.com/in/max-trivedi-49993aab/), creator of the Dirac agent. This package is an independent Pi extension inspired by his post: [Hash anchors + Myers diff + single-token anchors](https://dirac.run/posts/hash-anchors-myers-diff-single-token).

`pi-fast-edits` adds anchored file-reading and editing tools to Pi. Instead of editing by fragile line numbers or large search/replace blocks, the agent reads files with stable word anchors and then edits by referencing those anchors.

```text
Apple§ import { foo } from "./foo";
Brave§
Cider§ export function run() {
Delta§   return foo();
Eagle§ }
```

The agent can then replace `Cider§..Eagle§` with new code. The extension validates anchors, writes atomically, and lazily reconciles changed files with a Myers line diff.

## Install

```bash
pi install npm:pi-fast-edits
```

## Install from GitHub

```bash
pi install git:github.com/arnaugomez/pi-fast-edits
```

## Development

```bash
npm install
npm run build
pi -e ./dist/index.js
```

Or load the TypeScript source directly during development:

```bash
pi -e ./src/index.ts
```

## Tools

### `read_anchored_file`

Reads a text file with Dirac-style word anchors.

```json
{
  "path": "src/run.ts",
  "mode": "auto"
}
```

For large files, `auto` mode returns a heuristic skeleton instead of dumping the whole file. Use `startLine` and `endLine` for focused range reads.

### `edit_anchored_range`

Replaces a range between two anchors.

```json
{
  "path": "src/run.ts",
  "startAnchor": "Cider",
  "endAnchor": "Eagle",
  "replacement": "export function run() {\n  return foo({ fast: true });\n}",
  "expectedRevision": "optional-revision-from-read_anchored_file"
}
```

### `insert_at_anchor`

Inserts content before or after an anchor.

```json
{
  "path": "src/run.ts",
  "anchor": "Cider",
  "position": "before",
  "content": "// Added by pi-fast-edits"
}
```

### `delete_anchor_range`

Deletes a range from start anchor through end anchor.

```json
{
  "path": "src/run.ts",
  "startAnchor": "Cider",
  "endAnchor": "Eagle"
}
```

### `apply_anchored_edits`

Batches multiple edits. This is the preferred tool for multi-file or multi-region changes.

```json
{
  "edits": [
    {
      "type": "replace",
      "path": "src/run.ts",
      "startAnchor": "Cider",
      "endAnchor": "Eagle",
      "replacement": "export function run() {\n  return foo({ fast: true });\n}"
    }
  ]
}
```

### `preview_anchored_edit`

Returns a diff for a replacement edit without writing files.

## Commands

```text
/pi-fast-edits status
/pi-fast-edits config
/pi-fast-edits override on
/pi-fast-edits override off
/pi-fast-edits confirmations always
/pi-fast-edits confirmations protected-paths
/pi-fast-edits confirmations never
```

## Defaults

```json
{
  "overrideBuiltInEditTools": false,
  "confirmation": "protected-paths",
  "largeFileMode": "dirac-like",
  "maxFullReadBytes": 80000,
  "maxFullReadLines": 1500,
  "maxRangeReadLines": 400,
  "maxSkeletonItems": 120,
  "returnDiffsAfterEdit": true,
  "returnUpdatedAnchorsAfterEdit": true
}
```

## Safety

- Rejects paths outside the workspace.
- Rejects likely binary files.
- Writes atomically through a same-directory temporary file and rename.
- Preserves line endings and final-newline behavior.
- Supports optional `expectedRevision` guards to fail safely if a file changed after reading.
- Confirms edits to protected paths by default.

Protected paths include `.env`, `.git/**`, `.github/workflows/**`, lockfiles, and `migrations/**`.

## State model

Anchor state is session-local. If Pi reloads the extension, read files again to refresh anchors.

## License

MIT

# pi-fast-edits

Fast file editing tools with word anchors for the Pi coding agent.

## Attribution

All credit for the core idea behind this extension goes to [Max Trivedi](https://www.linkedin.com/in/max-trivedi-49993aab/), creator of the Dirac agent. This package is an independent Pi extension inspired by his post: [Hash anchors + Myers diff + single-token anchors: 60% cheaper AI code edits](https://dirac.run/posts/hash-anchors-myers-diff-single-token).

`pi-fast-edits` adds anchored file-reading and editing tools to Pi. Instead of editing by fragile line numbers or large search/replace blocks, the agent reads files with stable word anchors and then edits by referencing those anchors.

```text
Apple§ import { foo } from "./foo";
Brave§
Cider§ export function run() {
Delta§   return foo();
Eagle§ }
```

The agent can then replace the `Cider..Eagle` range with new code. The extension validates anchors, writes atomically, and lazily reconciles changed files with a Myers line diff.

## Usage notes

- Anchor names (e.g., `Cider`) are used in tool parameters to reference lines
- Anchor parameters take the bare anchor word copied from `read_anchored_file`/`grep_anchored_files` output
- With `requireAnchorLines` on (the default), every edit must also pass the exact current source line at each anchor — `startAnchorLine`/`endAnchorLine` (or `anchorLine` for inserts) — copied verbatim from read/grep output. The line is verified against the file before editing; a mismatch rejects the edit with a corrective message
- When `requireAnchorLines` is off, the line args are optional but still verified whenever they are provided
- The `§` marker shown in file output is internal metadata only — it is NOT part of the actual file content
- When providing `replacement` or `content`, use raw text only — do NOT include the `§` anchor marker

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

Reads a text file with stable word anchors.

```json
{
  "path": "src/run.ts",
  "mode": "auto"
}
```

For large files, `auto` mode returns a heuristic skeleton instead of dumping the whole file. Use `startLine` and `endLine` for focused range reads.

### `grep_anchored_files`

Searches file contents with a regex and returns matching lines with the same anchors and revision hashes as `read_anchored_file`, ready to feed into the edit tools: pass the per-file `Revision` as `expectedRevision`, and copy the matching line text verbatim into `startAnchorLine`/`endAnchorLine`/`anchorLine`.

```json
{
  "pattern": "TODO",
  "path": "src",
  "glob": "**/*.ts",
  "ignoreCase": true,
  "context": 2,
  "maxMatches": 50
}
```

- `pattern` — regular expression to search for (required)
- `path` — file or directory to search, inside the workspace; defaults to the workspace root
- `glob` — only search files whose workspace-relative path matches, e.g. `**/*.ts`
- `ignoreCase` — case-insensitive matching
- `context` — anchored context lines around each match (default 0, max 10)
- `maxMatches` — maximum matching lines shown per file (default 50)

Searches skip `.git`, `node_modules`, protected paths, and binary files. Results are capped at 100KB with an explicit truncation note, and files that change during the search are omitted with a drift notice instead of returning stale coordinates. The search always runs through ripgrep, resolved from pi's tool cache (`~/.pi/agent/bin/rg`) or PATH; if ripgrep is missing the tool errors out rather than degrading.

### `edit_anchored_range`

Replaces a range between two anchors.

```json
{
  "path": "src/run.ts",
  "startAnchor": "Cider",
  "startAnchorLine": "export function run() {",
  "endAnchor": "Eagle",
  "endAnchorLine": "}",
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
  "anchorLine": "export function run() {",
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
  "startAnchorLine": "export function run() {",
  "endAnchor": "Eagle",
  "endAnchorLine": "}"
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
      "startAnchorLine": "export function run() {",
      "endAnchor": "Eagle",
      "endAnchorLine": "}",
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
```

- `status` shows the current runtime state (override flag, confirmation mode, tracked files/anchors).
- `config` opens an interactive `/settings`-style menu (blue borders, fuzzy-searchable list) to edit the extension's configuration, including the `requireAnchorLines` toggle (see [Defaults](#defaults)). Changes take effect immediately — edit tools re-register so their schemas follow the new setting — and are persisted to `~/.pi/agent/pi-fast-edits.json`, surviving restarts.

## Defaults

```json
{
  "overrideBuiltInEditTools": false,
  "confirmation": "protected-paths",
  "requireAnchorLines": true,
  "maxFullReadBytes": 80000,
  "maxFullReadLines": 1500,
  "maxRangeReadLines": 400,
  "maxSkeletonItems": 120,
  "protectedPaths": [
    ".env",
    ".env.*",
    ".git",
    ".git/**",
    ".github/workflows/**",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "migrations/**"
  ]
}
```

- `requireAnchorLines` (default `true`) — require the exact anchor line content (`startAnchorLine`/`endAnchorLine`/`anchorLine`) on every edit; set to `false` to make them optional (still verified when provided)

## Safety

- Rejects paths outside the workspace.
- Rejects likely binary files.
- Writes atomically through a same-directory temporary file and rename.
- Preserves line endings and final-newline behavior.
- Supports optional `expectedRevision` guards to fail safely if a file changed after reading.
- Confirms edits to protected paths by default.

Protected paths include `.env`, `.git`, `.git/**`, `.github/workflows/**`, lockfiles, and `migrations/**`.

## State model

Anchor state is persisted to `~/.pi/agent/pi-fast-edits/anchor-state.json` on session shutdown and restored at session start, so anchors survive extension reloads.

The session cache is bounded: up to 50 files are held in memory, and the least-recently-used entry is evicted (and re-read from disk on the next touch) when the limit is exceeded.

## License

MIT

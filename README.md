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
- Anchor parameters take the bare anchor word copied from `read_anchored`/`grep_anchored` output
- With `requireAnchorLines` on (the default), every edit must also pass the exact current source line at each anchor — `startAnchorLine`/`endAnchorLine` (or `anchorLine` for inserts) — copied verbatim from read/grep output. The line is verified against the file before editing; a mismatch rejects the edit with a corrective message
- Rendered lines end with a `line N` (grep) or `lines N` (skeleton) positional suffix — it is metadata, not part of the line, and must NOT be copied into `startAnchorLine`/`endAnchorLine`/`anchorLine` values
- When `requireAnchorLines` is off, the line args are optional but still verified whenever they are provided
- The `§` marker shown in file output is internal metadata only — it is NOT part of the actual file content
- When providing `replacement` or `content`, use raw text only — anchor-marked text (`Word§...`, i.e. a rendered anchored line) is rejected by default; if the `§` is genuine content, pass `allowAnchoredLines: true`

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

### `read_anchored`

Reads a text file with stable word anchors.

```json
{
  "path": "src/run.ts",
  "mode": "auto"
}
```

For large files, `auto` mode returns a heuristic skeleton instead of dumping the whole file. Use `startLine` and `endLine` for focused range reads.

- `anchored` — set to `false` for plain `lineNo: text` lines without anchor prefixes or the revision header (default: anchored, edit-ready output); `details` still carries `revision` and `lines` in both modes

### `write_anchored`

Writes a full file and seeds its anchor state in one call, returning the revision hash plus an anchored preview of the first 5 lines so the anchored edit tools work immediately without a `read_anchored` call.

```json
{
  "path": "src/run.ts",
  "content": "export function run() {\n  return foo();\n}\n"
}
```

- `path` — file to write, inside the workspace (a leading `@` is accepted like the other tools)
- `content` — full content to write

Rejects protected paths before any write; overwriting an existing file replaces its content and refreshes the revision. This is the same behavior `write` gets in [override mode](#override-mode).

### `grep_anchored`

Searches file contents with a regex and returns matching lines with the same anchors and revision hashes as `read_anchored`, ready to feed into the edit tools: pass the per-file `Revision` as `expectedRevision`, and copy the matching line text verbatim into `startAnchorLine`/`endAnchorLine`/`anchorLine` — dropping the trailing `line N` suffix, which is positional metadata and not part of the line.

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

## Override mode

`overrideBuiltInEditTools` (default `false`) controls whether pi's built-in `read`, `edit`, `write`, and `grep` are **replaced** by the anchored implementations under the same names, instead of coexisting with the suffixed tools.

When enabled, a load-time safety check fingerprints pi's built-in tool definitions (`edit` exposes `parameters.properties.edits`; `write` exposes `path`/`content`; `read`/`grep` are registered; our own definitions have non-empty schemas and handlers). The outcome decides the surface the model sees:

| Setting                                     | Tool list the model sees                                                                                                                                             | Failed-call cost                                  |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `overrideBuiltInEditTools: false` (default) | pi `read`/`edit`/`write`/`grep` (originals) + the suffixed anchored tools                                                                                            | n/a — two surfaces, the model chooses             |
| override on, safety check passes            | `read` (anchored by default, `anchored: false` escape), `edit` (anchored multi-edit), `write` (anchor-seeding), `grep` (anchored search); suffixed names deactivated | none — the anchored workflow is the only workflow |
| override on, safety check fails             | originals + suffixed tools, plus a visible warning; `write`/`edit` calls intercepted with a steering message                                                         | one blocked call (teaching message)               |

The four replaced names:

- `read` — `read_anchored` under the built-in name, anchored by default. Pass `anchored: false` for plain `lineNo: text` output without anchors or the revision header; schema, caps, and `details` are unchanged.
- `edit` — anchored multi-edit (`edit_anchored` behavior) under the built-in name.
- `write` — anchor-seeding write (`write_anchored`): full-file writes that seed anchor state and return the revision plus an anchored preview, so subsequent edits need no re-read. Protection checks (`protectedPaths`), workspace bounds, and atomic writes apply exactly as elsewhere.
- `grep` — anchored search (`grep_anchored`) under the built-in name, edit-ready by construction.

While override is on, the five suffixed names (`read_anchored`, `grep_anchored`, `write_anchored`, `preview_anchored`, `edit_anchored`) are deactivated via `setActiveTools` — the same behavior is never exposed under two names. Each overridden description carries a prefix ("Anchored read (default).", "Anchored edit (batch).", etc.) so the model can tell the definitions apart.

Toggling the setting from the config menu re-registers the surface immediately and injects a one-shot notice into the conversation announcing the change in both directions. On the disable direction, the overridden names keep their anchored definitions until pi reloads the extension (pi has no unregister API); the suffixed tools re-activate alongside, so the surface works immediately but is fully native only after a reload.

If the safety check fails (e.g. pi redesigns a built-in), the extension falls back to the interception tier with a visible warning instead of failing silently: built-in `write`/`edit` calls are blocked and steered toward the anchored tools. The former always-on runtime interception is now only this fallback.

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

- `overrideBuiltInEditTools` (default `false`) — replace pi's built-in `read`/`edit`/`write`/`grep` with the anchored implementations under the same names (see [Override mode](#override-mode))
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

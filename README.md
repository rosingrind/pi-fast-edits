# pi-fast-edits

Fast file editing tools with word anchors for the Pi coding agent.

## About this fork

This extension began as a fork of `arnaugomez/pi-fast-edits` and has since diverged into an independently maintained extension — the upstream is no longer maintained. The anchored-tools architecture follows the **dirac way** (host-sanctioned trust roots, hash-guarded revisions, single-token anchors, batch-atomic edits), reworked for pi's extension model.

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
- With `requireAnchorLines` on (the default), every edit must also pass the exact current source line at each anchor — `startAnchorLine`/`endAnchorLine` (or `anchorLine` for inserts) — copied verbatim from read/grep output. The line is verified against the file before editing; a mismatch rejects the edit with a corrective message. Revision mismatches additionally carry fresh coordinates (current text + line) for every named anchor, so a stale batch can be retried without re-reading; re-read only when the error reports missing anchors
- Rendered `grep_anchored` lines end with a `line N` positional suffix — it is metadata, not part of the line, and must NOT be copied into `startAnchorLine`/`endAnchorLine`/`anchorLine` values
- When `requireAnchorLines` is off, the line args are optional but still verified whenever they are provided
- The `§` marker shown in file output is internal metadata only — it is NOT part of the actual file content
- When providing `replacement` or `content`, use raw text only — anchor-marked text (`Word§...`, i.e. a rendered anchored line) is rejected by default; if the `§` is genuine content, pass `allowAnchoredLines: true`

## Install from GitHub

```bash
pi install git:github.com/rosingrind/pi-fast-edits
```

> An npm release is pending; until then install from this repository (the npm `pi-fast-edits` package is the unmaintained upstream).

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

For large files, use `startLine` and `endLine` for focused range reads (`auto` resolves to `range` when a window is given, otherwise `full`). For orientation in an unknown file, `grep_anchored` a declaration regex — see the skill.

Skill and pi-docs reads: `read_anchored` may also read files under **host-sanctioned roots** — the skill directories pi has loaded (announced each turn via `before_agent_start`) and pi's own package docs. Skill loading therefore works without the `-1`-turn `cat` fallback, while everything else outside the workspace stays rejected (the error suggests `bash cat`). A collapsed call on a `SKILL.md` renders pi's purple `[skill] <name>` box, matching the built-in read.

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

Rejects protected paths before any write; overwriting an existing file replaces its content and refreshes the revision. The anchored tools are always registered under their suffixed names.

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
- `literal` — treat the pattern as a fixed string (`rg -F`) instead of a regular expression

Searches skip `.git`, `node_modules`, protected paths, and binary files; explicitly targeting a protected file (e.g. `path: ".env"`) is refused with an error rather than searched. Results are capped at 100KB with an explicit truncation note, and files that change during the search are re-scanned once against their current content so you get fresh verified coordinates; only still-changing files are omitted with a drift notice. The `literal` parameter treats the pattern as a fixed string (`rg -F`), so regex metacharacters in paths or snippets match themselves. The search always runs through ripgrep, resolved from pi's tool cache (`~/.pi/agent/bin/rg`) or PATH; if ripgrep is missing the tool errors out rather than degrading.

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

## Tool surface

The anchored tools are always registered under their suffixed names — `read_anchored`, `grep_anchored`, `write_anchored`, `edit_anchored` — and are the canonical workflow. The only surface control is `suppressNativeTools` (default `false`):

- **`suppressNativeTools: false` (default)** — pi's native `read`/`edit`/`write`/`grep` coexist with the suffixed anchored tools; the model picks per task.
- **`suppressNativeTools: true`** — the native names are removed from the active tool set via `setActiveTools`. The model can only call the anchored tools, and a hidden tool never executes — which also sidesteps the pi built-in-`edit` dispatch bug below entirely.

Previously the extension could rename its anchored implementations over the built-in names (`overrideBuiltInEditTools`). That mechanism was removed: newer pi versions split dispatch for shadowed built-in names — validation/prompt come from the extension def but execution runs the built-in body, so anchored-shaped arguments crash inside the built-in edit (`Cannot read properties of undefined (reading 'replace')`). Renaming was therefore a dead end; hiding the natives is the working equivalent.

Toggling `suppressNativeTools` from the config menu (or the config file) takes effect immediately — the surface re-applies on the next `session_start`/config change — and injects a one-shot notice into the conversation announcing the change (hide: "use the anchored tools"; restore: "prefer the anchored tools").

## Commands## Commands

```text
/pi-fast-edits status
/pi-fast-edits config
```

- `status` shows the current runtime state (native tool visibility, confirmation mode, tracked files/anchors).
- `config` opens an interactive `/settings`-style menu (blue borders, fuzzy-searchable list) to edit the extension's configuration, including the `requireAnchorLines` toggle (see [Defaults](#defaults)). Changes take effect immediately — edit tools re-register so their schemas follow the new setting — and are persisted to `~/.pi/agent/pi-fast-edits.json`, surviving restarts.

## Defaults

```json
{
  "confirmation": "protected-paths",
  "requireAnchorLines": true,
  "suppressNativeTools": false,
  "maxRangeReadLines": 400,
  "maxReadLines": 2000,
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

- `suppressNativeTools` (default `false`) — hide pi's native `read`/`edit`/`write`/`grep` from the model's active tool set, leaving only the anchored tools (see [Tool surface](#tool-surface))
- `requireAnchorLines` (default `true`) — require the exact anchor line content (`startAnchorLine`/`endAnchorLine`/`anchorLine`) on every edit; set to `false` to make them optional (still verified when provided)

## Troubleshooting

**`edit` crashes with `Cannot read properties of undefined (reading 'replace')`** — on newer pi versions, a tool registered over the built-in name `edit` gets its **schema/prompt from the extension but its execution from pi's built-in edit body**, which requires `edits[].oldText`/`newText`. Anchored edits carry `startAnchor`/`anchorLine` instead, so the built-in's `normalizeToLF(edit.oldText)` crashes on `undefined`. Verified behaviorally: anchored-shaped args validate against the extension schema then crash; built-in-shaped args (`oldText`/`newText`) are rejected by the extension schema — the name is split at dispatch. A pi restart does **not** fix it.

This mechanism no longer exists in pi-fast-edits: the rename was removed and the anchored tools are always the suffixed names, so a shadowed `edit` can never occur. To keep the model on the anchored tools exclusively, set `suppressNativeTools: true`. Long-term: if a future pi reintroduces name shadowing, report to `earendil-works/pi` with an anchored-args repro.

## Safety

- Rejects paths outside the workspace, with one evidence-based exception: reads (never writes or greps) may target host-sanctioned roots — the skill directories pi has loaded and pi's package docs, i.e. exactly the outside paths pi itself already sanctions.
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

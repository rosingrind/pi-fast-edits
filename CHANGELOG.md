# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`startAnchorLine`/`endAnchorLine`/`anchorLine` args** — Edit tools (`edit_anchored_range`, `insert_at_anchor`, `delete_anchor_range`, `preview_anchored_edit`, `apply_anchored_edits`) accept the exact current source line at each anchor, copied verbatim from `read_anchored_file`/`grep_anchored_files` output and verified against the file before editing; mismatch rejects the edit with a corrective message
- **`requireAnchorLines` setting** — New config option (default `on`) that makes the anchor line args required; when `off` they are optional but still verified when provided. The config menu re-registers the edit tools live, so schema strictness follows the setting without a reload
- **Ripgrep-backed `grep_anchored_files`** — Searches via `rg --json`, resolved from `~/.pi/agent/bin/rg` or PATH (errors out when ripgrep is unavailable — no fallback scanner); `filterDrifted` omits files that changed between scan and read, output is capped at 100KB with an explicit truncation note, and hit lines are capped at 300 characters with 500 total matches
- **`context` parameter** — `grep_anchored_files` accepts anchored context lines (0–10, default 0) around each match
- **Anchor-state persistence** — Anchor state is exported to `~/.pi/agent/pi-fast-edits/anchor-state.json` on `session_shutdown` and hydrated on `session_start`

### Changed

- **Breaking: anchor line args are required when strict** — With `requireAnchorLines` on (the default), every edit must pass `startAnchorLine`/`endAnchorLine` (or `anchorLine` for inserts); omitting them rejects the edit before any write. Tools re-register live when the setting changes
- **Random per-file anchor allocation** — Anchors are drawn from Fisher–Yates-shuffled pools seeded per file path: stable across LRU eviction, but non-guessable across files

### Removed

- **`ANCHOR§content` echo coordinates** — Passing the echoed line content embedded in the anchor string (`Sunny§export function run()`) is no longer supported; pass the anchor word plus the matching `*Line` arg instead

## [0.2.0] - 2026-08-12

### Added

- **`src/tools/render.ts`** — New TUI rendering layer with `ToolResult`, `RenderOptions`, `RenderContext` types and `renderToolCall` helper
- **`src/tools/theme.ts`** — Minimal Theme interface (fg, bold) for renderers
- **`src/tools/schemas.ts`** — Shared TypeBox schemas: `replaceEditSchema`, `insertEditSchema`, `deleteEditSchema`, `batchEditsSchema`
- **6 new test files** (now 26 total) covering concurrency, performance, config, path safety, glob matching, atomic writes, commands, I/O errors, TUI rendering, and config persistence
- **`.prettierrc`** and **`.prettierignore`** — Prettier configuration for consistent code style
- **`src/config-persistence.ts`** — `loadConfig()` and `saveConfig()` for persistent config storage at `~/.pi/agent/pi-fast-edits.json`
- **`src/config-ui.ts`** — Interactive config menu via `ctx.ui.custom()` with `SettingsList` (fuzzy search, blue borders, submenus)
- **`test/config-persistence.test.ts`** — Round-trip test for config persistence
- **Test isolation** — `test/setup.ts` sets `PI_CODING_AGENT_DIR` to temp dir; `vitest.config.ts` registers setup
- **`LRUMap` class** in types with 50-entry memory bound
- **AbortSignal support** for all edit tools — respects cancellation
- **Parallel file reads** in batch edits — uses `Promise.all` over unique paths
- **`mkdir` recursive** in atomic write — creates parent directories before writing
- **Retired-anchor cap** — `MAX_RETIRED_ANCHORS` (10,000) bounds the retired-anchor set to prevent unbounded memory growth under heavy anchor churn
- **Usage notes** — README documents that `§` is internal metadata only and replacement/content must use raw text
- **Schema clarifications** — Tool descriptions now explicitly state "Use raw text only — do NOT include the `§` anchor marker"
- **Zero-width insert** — `includeStart=true` + `includeEnd=false` on a single anchor inserts immediately before that line

### Changed

- **Anchored tool output now matches built-in tools** — `edit_anchored_range`, `insert_at_anchor`, `delete_anchor_range`, and `preview_anchored_edit` now render colored unified diffs (with `+`/`-` markers) instead of plain success messages like "Successfully replaced 1 block". `apply_anchored_edits` renders colored unified diffs with per-file path prefixes instead of anchor-change summaries. `read_anchored_file` tool call no longer shows `(full)`, `(range)`, or `(skeleton)` suffix.
- **Pipe-tolerant anchor normalization** — `normalizeAnchor` now accepts trailing `|` in addition to `§`
- **Tool schemas** — Extracted to shared `schemas.ts`, reduced duplication across edit tools
- **Myers diff threshold** — Lowered from 6000 to 4000 lines (n + m) to avoid ~128 MB memory usage at scale
- **Myers diff** — Uses flat `Int32Array` instead of `Array<Map>` for trace; throws on failure instead of silently returning []
- **Unified diff** — New pi-style format with line numbers, padding, and context collapsing; removed `path` parameter (no longer emits `--- a/`/`+++ b/` headers)
- **Reconciliation** — Accepts pre-computed `diffOps` to skip redundant Myers diff calls
- **Session state** — Uses `LRUMap` instead of `Map` for file cache (50-entry limit)
- **README** — Updated to reflect current behavior, removed deprecated config options
- **Entry point** — Added `overrides` parameter; no longer intercepts `write_file`/`edit_file`
- **Protected paths** — Added `.git` to default list
- **CI** — Added `format:check` step
- **`/pi-fast-edits` reduced to 2 subcommands** — `status` and `config` only (removed `override on/off` and `confirmations always/protected-paths/never`)
- **`/pi-fast-edits status` renders inline** — Uses `ctx.ui.notify()` to show output in chat transcript
- **`/pi-fast-edits config` opens interactive menu** — Replaces previous JSON-printing behavior with a SettingsList-style menu
- **Factory is now async** — `piFastEdits()` now `async` to support loading persisted config at startup
- **Config changes apply live** — Menu mutations update the runtime config object directly (no `/reload` needed)
- **`getArgumentCompletions`** — Returns subcommand completions (`status`, `config`) for slash command autocomplete

### Fixed

- **OOM crash** — Myers diff now has 4k-line threshold (n + m), falls back to delete-all + insert-all script
- **BOM handling** — Text files properly detect, strip, and re-add BOM across edits
- **Symlink protection** — Now validates symlink target is a regular file
- **Empty file edits** — Any edit on empty file creates content from scratch
- **Skeleton cache** — Cleared on reconcile to prevent stale data
- **Error messages** — All end with periods consistently
- **Duplicate output bug** — Fixed `ui?.notify?.(message, "info") ?? console.log(message)` always falling through to `console.log` because `notify()` returns `void`

### Optimized

- **Memory** — Myers trace uses `Int32Array` instead of nested Maps (40-50x reduction)
- **CPU** — Common prefix/suffix trim eliminates wasted diff work on common cases
- **CPU** — Diff operations reused between preview and reconcile (runs Myers once, not twice)
- **CPU** — Skeleton items cached keyed by `revisionHash`
- **I/O** — Batch edits read files in parallel via `Promise.all`

### Removed

- **`src/shims.d.ts`** — No longer needed (real types now available)
- **`returnDiffsAfterEdit`** config option
- **`returnUpdatedAnchorsAfterEdit`** config option
- **`largeFileMode`** config option
- **`lineHash`** from `AnchoredLine` type
- **`ToolTextResult`** type (replaced by pi's `AgentToolResult`)
- **`hashLine`** function from `fs/text-file.ts` (folded into `hashText`)
- **`refreshLineNumbers`** function (dead code)
- **`buildPoolFromAnchors`** function (replaced by `poolFromState`)
- **`normalizeEdits`** function in apply-anchored-edits (params now strongly typed)
- **`override on/off` subcommand** — Replaced by interactive config menu
- **`confirmations always/protected-paths/never` subcommand** — Replaced by interactive config menu

### Tests

- **246 total tests** across 26 test files (updated for unified-diff output, added retired-anchor cap test, added zero-width insert edge case, added config persistence round-trip)
- **Concurrency tests** — Parallel reads, batch parallel, empty file concurrency
- **Performance tests** — Anchor pool cycling, large files (10k lines), diff performance, I/O errors
- **Config boundary tests** — NaN/negative values, auto mode thresholds
- **Unit tests** — Anchor pool, renderer, config parsing, glob matching, atomic writes

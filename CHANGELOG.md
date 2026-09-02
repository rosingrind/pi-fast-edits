# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **O(1) anchor lookups for batch edits** — Anchor verification no longer linearly scans the file per anchor: each batch builds an `AnchorIndex` (first-wins anchor→line map, rebuilt fresh per call so it can never go stale). Worst case measured ~205ms → <20ms for a 50-edit batch on a 10k-line file; pinned by a perf regression test
- **`/pi-fast-edits status` shows read limits** — surfaces `Require anchor lines`, the range-read limit, and the full-read limit alongside override and anchor-state counts
- **Error-text self-description (model-ergonomics audit)** — the anchor surface is now self-describing at the failure point: fresh-coordinate rows beyond 160 chars say "(truncated — re-read with `anchored: false` to copy verbatim)"; grep match lines beyond 300 chars render "(truncated at 300 chars — re-read with anchored: false for the full line)" instead of a bare `...`; did-you-mean retry instructions name the correct `*Line` field (`anchorLine` for inserts) and cap the suggested line text at the display limit. A model reading any rejection cold knows the exact next action
- **Revision-mismatch rejections carry fresh coordinates** — a stale `expectedRevision` no longer dead-ends with "re-read the file": the rejection resolves every anchor named by the batch against the current (reconciled) file and attaches a bounded fresh-coordinates block — anchor word, current text, line number, and a "(content unchanged)" marker when the text still matches what the edit expected. Anchors whose lines no longer exist are counted, not invented; the block is capped at 8 rows. Changed content is shown, never hidden — the model re-decides with full visibility, turning the two-turn conflict loop into one turn
- **`overrideBuiltInEditTools` removed; `suppressNativeTools` is the tool-surface control** — newer pi versions split dispatch for shadowed built-in names (extension def supplies schema/prompt, built-in supplies execution), so the rename mechanism crashed anchored edits inside the built-in body (`Cannot read properties of undefined (reading 'replace')`). The rename is gone: the anchored tools are always the suffixed names, and `suppressNativeTools` (default `false`) hides native `read`/`edit`/`write`/`grep` from the active set so the model can only call the anchored tools — which also makes the dispatch bug unreachable. Surface-mode notices (hide/restore) are injected on toggle
- **Anchor not-found errors now teach recovery** — a typo'd or case-flipped anchor ("Goldn", "golden") no longer dead-ends: the error suggests the nearest existing anchor by edit distance, flags case-only mismatches explicitly, and names the suggested anchor's line number + text so the edit can be retried correctly in one turn. Unrelated anchors keep the plain error (no invented suggestions)

## [0.3.0] - 2026-08-31

### Added

- **Host-sanctioned skill reads (workspace-bound everywhere else)** — The read tool may now read files under roots pi itself already sanctions: the `baseDir` of every skill pi has loaded (collected each turn from `before_agent_start` → `systemPromptOptions.skills`) plus pi's package docs root (derived via `import.meta.resolve`, no version-coupled named imports). Skill loading no longer costs the `-1`-turn `bash cat` fallback, agents can follow skill references under the same root, and outside-root paths keep the strict rejection — now with a message that teaches the `cat` escape. Writes and greps remain strictly workspace-bound; no new settings field. Pattern transplanted from dirac's architecture (host preloads skills; sandbox = fixed root set). New `src/fs/read-roots.ts` (`collectReadRoots`, `displayPathFor`, `piDocsRoot`), `resolveReadPath` in `src/fs/path-safety.ts`, `readRoots` on `SessionState`

- **`[skill]` call-box parity with pi's built-in read** — A collapsed call on a `SKILL.md` renders pi's purple `[skill] <skill-name>` title (`customMessageLabel`), mirroring `getCompactReadClassification` in pi's read tool; expanded calls keep the normal title. Works for `read_anchored` and the overridden `read` alike, so override mode no longer loses the box

- **Grep/read result rendering polish (UI-only; model-facing text unchanged)** — `grep_anchored` expanded view now matches the built-ins' spacing conventions: leading blank line, indentation preserved (shared `stripAnchorPrefix` replaces the local `trimStart` variant that flattened code indentation), the positional `line N` suffix stripped for display, lines colored `toolOutput`; collapsed view shows the first 15 lines plus pi's `... (N more lines, ctrl+o to expand)` hint instead of only the summary. `read` expanded output gains the same leading newline

- **Anchor-seeding `write_anchored` tool** — Writes a full file and seeds its anchor state in one call, returning the revision hash plus an anchored preview of the first 5 lines so `edit_anchored` works immediately without a `read_anchored` call. Rejects protected paths (before any write) and paths outside the workspace; accepts a leading `@` on `path` like the other tools; overwriting an existing file replaces content and refreshes the revision. Shared `DEFAULT_PROTECTED_SKIP` extracted to `src/fs/path-safety.ts` (grep reuses it, behavior unchanged)

- **Anchor-marked text rejection with `allowAnchoredLines`** — `replacement`/`content` containing anchor-marked lines (`Word§...`, matching rendered anchored output) is rejected by default with a corrective error; pass `allowAnchoredLines: true` to accept genuine `§` content. Applies across the edit tool's batch, verified in `planEdit` before any write

- **`startAnchorLine`/`endAnchorLine`/`anchorLine` args** — `edit_anchored` accepts the exact current source line at each anchor, copied verbatim from `read_anchored`/`grep_anchored` output and verified against the file before editing; mismatch rejects the edit with a corrective message
- **`requireAnchorLines` setting** — New config option (default `on`) that makes the anchor line args required; when `off` they are optional but still verified when provided. The config menu re-registers the edit tools live, so schema strictness follows the setting without a reload
- **Ripgrep-backed `grep_anchored`** — Searches via `rg --json`, resolved from `~/.pi/agent/bin/rg` or PATH (errors out when ripgrep is unavailable — no fallback scanner); `filterDrifted` omits files that changed between scan and read, output is capped at 100KB with an explicit truncation note, and hit lines are capped at 300 characters with 500 total matches
- **`context` parameter** — `grep_anchored` accepts anchored context lines (0–10, default 0) around each match
- **`anchored` parameter** — `read_anchored` accepts `anchored: false` to return plain `lineNo: text` lines without anchor prefixes or the revision header (default: anchored, edit-ready output); `details` still carries `revision` and `lines` in both modes for programmatic consumers
- **Override mode for built-in `read`/`edit`/`write`/`grep`** — When `overrideBuiltInEditTools` is enabled, a load-time safety check fingerprints pi's built-in definitions (`edit.parameters.edits`, `write.parameters.path`/`content`, `read`/`grep` registered) plus our own; on success the anchored implementations are re-registered under the built-in names (`read` anchored by default with the `anchored: false` escape, `edit` as anchored multi-edit, `write` as anchor-seeding, `grep` as anchored search) and the four suffixed names are deactivated via `setActiveTools`, leaving the anchored workflow as the only surface
- **Mid-session override toggle notice** — Toggling `overrideBuiltInEditTools` from the config menu re-registers the tool surface immediately and injects a one-shot notice into the conversation announcing the new contract (both directions); the disable direction keeps the overridden names anchored until pi reloads the extension, with the suffixed tools re-activated alongside
- **Anchor-state persistence** — Anchor state is exported to `~/.pi/agent/pi-fast-edits/anchor-state.json` on `session_shutdown` and hydrated on `session_start`
- **Full-read caps (context-bomb guard)** — `read_anchored` full reads are capped at `maxReadLines` (new setting, default 2000 — pi's built-in read parity) and a 50KB byte budget, with a `[N more lines in file. Use startLine=X to continue.]` continuation notice; over-long lines are display-truncated at 300 characters and the anchorLine mismatch error now teaches the `anchored: false` verbatim re-read (closing the same latent hole in grep's line cap)
- **`literal` search parameter** — `grep_anchored` accepts `literal: true` (`rg -F`) to treat the pattern as a fixed string, matching pi's built-in grep; regex metacharacters in paths or snippets no longer silently match nothing
- **Provider-side constrained sampling (pi 0.84+)** — All four anchored tools set `constrainedSampling: { type: "json_schema", strict: "prefer" }` when `PI_EXPERIMENTAL=1` (mirroring pi's built-ins); on supporting providers malformed arguments become structurally impossible instead of rejected after the fact. Ignored by older pi hosts

### Changed

- **Interception is now fallback-only** — The `tool_call` interception that blocks built-in `write`/`edit` calls is installed only when the override safety check fails (with a visible warning); when the check passes, the anchored tools replace the built-ins instead of being blocked at runtime
- **Grep drift self-heals** — When a file changes between rg's scan and the anchor-state read, the tool re-scans that file once against its current content and returns fresh verified coordinates instead of a dead-end drift notice; only still-changing files fall back to the notice
- **Breaking: anchor line args are required when strict** — With `requireAnchorLines` on (the default), every edit must pass `startAnchorLine`/`endAnchorLine` (or `anchorLine` for inserts); omitting them rejects the edit before any write. Tools re-register live when the setting changes
- **Random per-file anchor allocation** — Anchors are drawn from Fisher–Yates-shuffled pools seeded per file path: stable across LRU eviction, but non-guessable across files

### Removed

- **`ANCHOR§content` echo coordinates** — Passing the echoed line content embedded in the anchor string (`Sunny§export function run()`) is no longer supported; pass the anchor word plus the matching `*Line` arg instead

### Fixed

- **No main-thread regex compilation for grep patterns** — Pattern validation now happens inside rg (linear-time regex engine); a pathological model-supplied pattern can no longer hang the extension host via catastrophic JS backtracking (CWE-1333)
- **CI supply-chain hardening** — GitHub Actions pinned to commit SHAs, least-privilege `permissions`, and checkout credential persistence disabled (zizmor/opengrep clean)
- **Tests are type-checked** — `test/tsconfig.json` added and wired into `npm run check`; fixes stale tool names silently bound to `undefined` in the override-toggle suite and `readRoots`-missing session literals
- **`saveConfig` reports persistence failures** — resolves success and the config menu surfaces a warning when the disk write fails
- **Grep result UI is presentation-clean in both states** — Collapsed and expanded views strip anchor prefixes and the positional `line N` suffix from every line and drop `Revision:` hashes plus the model-facing `... showing N of M matches` cap note; collapsed now cleans BEFORE capping at 15 lines (the preview can no longer leak anchors, and the remaining-count is correct), `File:` section headers are kept (dimmed) for multi-file grouping, and the renderer no longer throws into the TUI's unstyled raw-text fallback. Model-facing text is unchanged
- **Single-file grep respects protected paths** — `grep_anchored` on an explicitly targeted protected file (`.env`, `package-lock.json`, …) is refused with a teaching error instead of silently searched, matching the documented “searches skip protected paths” behavior; directory walks were already skipping them, the explicit-target carve-out is gone
- **Read/grep collapsed previews match pi exactly** — collapsed `read_anchored` (and overridden `read`) shows pi's 10-line preview + expand hint for regular files and stays empty only for skill-classified reads (where the `[skill]` call box carries identity); collapsed grep gains pi's leading blank line. UI-only; model-facing text unchanged
- **Docs accuracy sweep** — CHANGELOG [Unreleased] renamed to the final four-tool surface (`read_anchored`/`grep_anchored`/`write_anchored`/`edit_anchored`), the skill's batch-atomicity wording now distinguishes validation failures from mid-batch I/O or abort, and the override safety-check comment matches pi 0.74.1's `ToolInfo` shape
- **Override mode engages in restricted child sessions** — In subagent sessions whose agent-type allowlist filters out some built-ins (e.g. read-only agents without `edit`/`write`), `applyOverrideMode` no longer treats a missing built-in as a fingerprint failure. The safety check now classifies each built-in as `eligible` (present and structurally clean — its name is claimed) or `absent` (not registered — skipped; that was the agent type's own choice), and only genuine shape/fingerprint mismatches trigger the interception fallback. A read-only child therefore gets anchored `read`/`grep` under the built-in names while keeping its allowlisted suffixed tools, instead of silently falling back to plain built-ins
- **Interception fallback respects the live override toggle** — The fail-path `tool_call` interception now reads `config.overrideBuiltInEditTools` at call time: toggling override off from the menu un-blocks `write`/`edit` immediately (re-blocking on re-enable), and the handler is installed at most once per runtime, so repeated `applyOverrideMode` runs no longer stack duplicate `tool_call` handlers
- **Overridden tools refresh schemas on any config change** — While override mode is active, `onConfigChanged` re-runs the override wiring for every config-menu change (not just the override toggle), so the overridden `read`/`edit`/`write`/`grep` definitions are rebuilt with fresh schemas (e.g. a `requireAnchorLines` toggle is picked up immediately)
- **Write guidance is mode-neutral** — The `write`/`write_anchored` result text and description no longer name the other suffixed anchored tools, which are deactivated in override mode; the copy now says “the anchored edit tools” / “the anchored read tool”
- **Teaching error for copied `line N` suffixes** — When a `startAnchorLine`/`endAnchorLine`/`anchorLine` value differs from the current line only by the rendered positional `line N`/`lines N` suffix (grep/read output), the mismatch error now tells the model to drop it — the value is still rejected, the model must correct itself. Tool guidelines and README now document that the suffix is positional metadata, not part of the line
- **`anchored: false` is now truly verbatim** — plain reads no longer display-truncate lines (the 300-char cap is anchored-only), so the anchorLine mismatch teaching for over-long lines ("re-read with `anchored: false`") actually works; an over-budget single line shows its head with an explicit truncation marker instead of a nonsensical continuation
- **Drift re-scan wording** — when a changed file no longer matches the pattern at all, the result says so instead of misdirecting the model to re-search
- **Batch edit results are byte-capped** — combined unified diffs cap at 100KB with an "all edits were applied" note; a huge rewrite can no longer dump megabytes of diff into context
- **Config file type-validation** — hand-edited configs keep only well-typed fields (wrong-typed scalars fall back to defaults; junk entries in `protectedPaths` are dropped)
- **Leaner `edit_anchored` metadata** — promptGuidelines trimmed to the essential pair (the skill carries the detail), saving per-session system-prompt tokens
- **Fork identity** — README states this is an independently maintained divergence from the unmaintained upstream, install instructions point at this repository, the `repository` package field is corrected, and development-internal `docs/` was removed from the repository

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

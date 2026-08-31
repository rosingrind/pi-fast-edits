import { stat, writeFile } from "node:fs/promises";
import { experimentalToolSampling } from "./experimental-sampling.js";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { PiFastEditsConfig, SessionState } from "../types.js";
import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ANCHOR_DELIMITER, stripAnchorPrefix } from "../anchor/anchor-renderer.js";
import { resolveToolDisplayName } from "./render.js";
import { DEFAULT_PROTECTED_SKIP, isProtectedPath } from "../fs/path-safety.js";
import { resolveRg } from "../fs/rg-resolver.js";
import { runRg, type RgHit } from "../fs/rg-search.js";
import {
  toolResultText,
  errorResultComponent,
  collapsedPreview,
  type ToolResult,
  type RenderOptions,
  type RenderContext,
} from "./render.js";
import { getCwd, loadStateForPath, textResult, type PiContext } from "./shared.js";
import type { Theme } from "./theme.js";

const DEFAULT_MAX_MATCHES_PER_FILE = 50;
const MAX_TOTAL_MATCHES = 500;
const MAX_FILE_BYTES = 1024 * 1024;
/** Hard cap on rendered output; sections beyond it are dropped. */
const MAX_OUTPUT_BYTES = 100_000;
/** Rendered match lines longer than this are truncated with an ellipsis. */
const MAX_LINE_LENGTH = 300;

/** Error thrown when the ripgrep binary cannot be resolved. */
const RG_MISSING_ERROR =
  "ripgrep (rg) is required for this tool but was not found in ~/.pi/agent/bin or PATH.";

/** Directories never searched — VCS internals and dependency trees. */
const SKIPPED_DIRS = new Set([".git", "node_modules"]);

const grepSchema = Type.Object({
  pattern: Type.String({
    description: "Regular expression to search for (JavaScript regex syntax).",
  }),
  path: Type.Optional(
    Type.String({
      description:
        "File or directory to search, inside the workspace. Defaults to the workspace root.",
    }),
  ),
  glob: Type.Optional(
    Type.String({
      description:
        "Only search files whose workspace-relative path matches this glob, e.g. '**/*.ts' or '*.md'.",
    }),
  ),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive matching." })),
  context: Type.Optional(
    Type.Number({
      description: "Anchored context lines around each match (default 0, max 10).",
    }),
  ),
  literal: Type.Optional(
    Type.Boolean({
      description:
        "Treat pattern as a literal string instead of a regular expression (rg -F). Default: false.",
    }),
  ),
  maxMatches: Type.Optional(
    Type.Number({
      description: `Maximum matching lines shown per file (default ${DEFAULT_MAX_MATCHES_PER_FILE}).`,
    }),
  ),
});
type GrepParams = Static<typeof grepSchema>;

export function registerGrepAnchored(
  pi: ExtensionAPI,
  session: SessionState,
  config: PiFastEditsConfig,
) {
  const tool = {
    name: "grep_anchored",
    label: "Grep Anchored Files",
    constrainedSampling: experimentalToolSampling(),
    description:
      "Search file contents with a regex and get matching lines back with stable word anchors and revision hashes, " +
      "exactly as read_anchored renders them. Results can be fed straight into the anchored edit tools " +
      "(use the per-file Revision as expectedRevision). Searches the workspace or a subpath; skips .git, node_modules, protected paths, and binary files.",
    renderCall: (args: Record<string, unknown>, theme: Theme, context: RenderContext) => {
      // Mirrors pi's built-in grep call title (name + /pattern/ in path), with
      // the name resolved through override-mode display names.
      const pattern = args.pattern as string | undefined;
      const glob = args.glob as string | undefined;
      const path = args.path as string | undefined;
      const text =
        theme.fg("toolTitle", theme.bold(resolveToolDisplayName("grep_anchored"))) +
        " " +
        theme.fg("accent", pattern === undefined ? "..." : `/${pattern}/`) +
        theme.fg("toolOutput", ` in ${path ?? "..."}`) +
        (glob ? theme.fg("toolOutput", ` (${glob})`) : "");
      const base =
        context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      base.setText(text);
      return base;
    },
    renderResult: renderGrepResult,
    promptSnippet: "Search files with a regex and get anchored, editable results",
    promptGuidelines: [
      "Results carry the same anchors and revision hashes as read_anchored",
      "Pass the per-file Revision header as expectedRevision when editing matches",
      "Use glob to narrow file types, e.g. '**/*.ts'",
      "The `    line N` suffix after each rendered line is positional metadata, not part of the line — do NOT include it in startAnchorLine/endAnchorLine/anchorLine values",
    ],
    renderShell: "default" as const,
    executionMode: "parallel" as const,
    parameters: grepSchema,
    async execute(
      _toolCallId: string,
      params: GrepParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: PiContext,
    ) {
      if (signal?.aborted) return textResult("Search cancelled (aborted).");
      const cwd = getCwd(ctx);

      // Resolve the search root: a single file short-circuits the directory walk.
      let rootAbs = cwd;
      if (params.path !== undefined && params.path.trim() !== "") {
        const { resolveWorkspacePath } = await import("../fs/path-safety.js");
        rootAbs = await resolveWorkspacePath(cwd, params.path.replace(/^@/, ""));
      }
      const rootStat = await stat(rootAbs);
      const singleFile = rootStat.isFile();

      const perFileCap = Math.max(1, Math.floor(params.maxMatches ?? DEFAULT_MAX_MATCHES_PER_FILE));

      // ripgrep is the only scanner. A missing binary errors out; rg reporting
      // zero hits is authoritative.
      const rgPath = await resolveRg();
      if (!rgPath) throw new Error(RG_MISSING_ERROR);
      return grepWithRg(
        session,
        cwd,
        rgPath,
        params,
        singleFile,
        rootAbs,
        perFileCap,
        signal,
        config.protectedPaths,
      );
    },
  };
  pi.registerTool(tool);
  return tool;
}

/** Message used when a hit file no longer matches its freshly re-read state. */
const DRIFT_MESSAGE = "[file changed during search — rerun for current coordinates.]";

/**
 * Run the search through ripgrep and render anchored results. A failed rg run
 * (spawn/parse/regex error) propagates as a thrown error — there is no JS
 * fallback; a successful rg run with zero hits is authoritative.
 */
async function grepWithRg(
  session: SessionState,
  cwd: string,
  rgPath: string,
  params: GrepParams,
  singleFile: boolean,
  rootAbs: string,
  perFileCap: number,
  signal: AbortSignal | undefined,
  protectedPaths: string[],
): Promise<ReturnType<typeof textResult>> {
  const context = Math.max(0, Math.min(10, Math.floor(params.context ?? 0)));
  const args = ["--json", "-e", params.pattern];
  if (params.ignoreCase) args.push("-i");
  if (params.glob) args.push("--glob", params.glob);
  // Literal search (rg -F): the pattern is a fixed string, so regex
  // metacharacters match themselves — parity with pi's built-in grep.
  if (params.literal) args.push("-F");
  if (context > 0) args.push("--context", String(context));
  // rg has no built-in knowledge of dependency trees: in non-git workspaces
  // it surfaces node_modules and .git dirs at any depth (only top-level
  // segments were filtered before), so exclude them at the source.
  args.push("--glob", "!**/node_modules/**", "--glob", "!**/.git/**");
  // Always pass the absolute root so rg searches the right directory even when
  // the host process cwd differs from the workspace being searched. baseArgs
  // (without the root) is reused for single-file drift re-scans.
  args.push(rootAbs);

  let hits: RgHit[];
  try {
    hits = await runRg(rgPath, args, signal);
  } catch (error) {
    if (signal?.aborted) return textResult("Search cancelled (aborted).");
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`ripgrep search failed: ${message}`);
  }

  if (hits.length === 0) {
    const scope = singleFile ? relative(cwd, rootAbs) : params.path ? params.path : "workspace";
    return textResult(`No matches for /${params.pattern}/ in ${scope}.`, { matches: 0 });
  }

  // Group hits by file so each file is validated and rendered once.
  const byFile = new Map<string, RgHit[]>();
  for (const hit of hits) {
    let group = byFile.get(hit.file);
    if (!group) {
      group = [];
      byFile.set(hit.file, group);
    }
    group.push(hit);
  }

  const sections: string[] = [];
  let outputLength = 0;
  let totalMatches = 0;
  let filesWithMatches = 0;
  let omittedFiles = 0;
  let truncatedByBudget = false;
  const droppedSections: string[] = [];

  for (const file of [...byFile.keys()].sort()) {
    if (totalMatches >= MAX_TOTAL_MATCHES) break;
    if (signal?.aborted) break;

    const absPath = isAbsolute(file) ? file : resolve(cwd, file);
    let relativePath = relative(cwd, absPath).replace(/\\/g, "/");

    // Directory searches skip the same trees as the JS walker. rg honors
    // gitignore natively, but non-git workspaces still surface dependency
    // and protected files, so re-apply our own filters. An explicitly
    // targeted single file gets the same protection — as a loud refusal
    // rather than a silent skip (skipping would report a bogus "No matches"
    // for a file the caller named explicitly).
    if (SKIPPED_DIRS.has(relativePath.split("/")[0] ?? "")) {
      if (singleFile) throw new Error(`Refusing to search protected path: ${relativePath}.`);
      continue;
    }
    if (isProtectedPath(relativePath, [...DEFAULT_PROTECTED_SKIP, ...protectedPaths])) {
      if (singleFile) throw new Error(`Refusing to search protected path: ${relativePath}.`);
      continue;
    }

    // Skip files too large to index: same cap as the JS scanner, so the rg
    // path cannot churn the anchor LRU with multi-megabyte files.
    const fileStat = await stat(absPath).catch(() => undefined);
    if (!fileStat || !fileStat.isFile() || fileStat.size > MAX_FILE_BYTES) continue;

    let loaded: Awaited<ReturnType<typeof loadStateForPath>>;
    try {
      loaded = await loadStateForPath(session, cwd, absPath);
    } catch {
      // Deleted or unreadable mid-search — treat as drifted.
      omittedFiles++;
      sections.push(`${relativePath}\n${DRIFT_MESSAGE}`);
      outputLength += relativePath.length;
      continue;
    }
    ({ relativePath, state: loaded.state } = loaded);
    const state = loaded.state;

    let kept = filterDrifted(byFile.get(file)!, state.lines);
    if (kept.drifted) {
      // The file changed between rg's scan and our anchor-state read. Re-scan
      // just this file once (bounded) so the model gets fresh, re-verified
      // coordinates instead of a dead-end drift notice — mirroring the read
      // tool's reconcile-on-drift behavior. If it drifts again (still being
      // written, say), fall back to the notice.
      let freshHits: RgHit[] = [];
      try {
        freshHits = await runRg(rgPath, [...args.slice(0, -1), absPath], signal);
      } catch {
        // rg failure during the recovery scan — keep the drift notice.
      }
      const refiltered = filterDrifted(freshHits, state.lines);
      if (!refiltered.drifted && refiltered.kept.length > 0) {
        kept = refiltered;
      } else {
        omittedFiles++;
        sections.push(`${relativePath}\n${DRIFT_MESSAGE}`);
        outputLength += relativePath.length;
        continue;
      }
    }
    const { kept: verifiedHits } = kept;

    // Context events can duplicate line numbers (overlapping match windows);
    // render each line once, preferring match hits over context.
    const deduped = new Map<number, RgHit>();
    for (const hit of verifiedHits) {
      const existing = deduped.get(hit.lineNo);
      if (existing === undefined || (!existing.isMatch && hit.isMatch)) {
        deduped.set(hit.lineNo, hit);
      }
    }
    const ordered = [...deduped.values()].sort((a, b) => a.lineNo - b.lineNo);
    const matchCount = ordered.filter((hit) => hit.isMatch).length;
    if (matchCount === 0) continue;

    // Per-file cap applies to matches; context of truncated matches is dropped.
    const shownMatches: RgHit[] = [];
    const lines: string[] = [];
    for (const hit of ordered) {
      if (hit.isMatch) {
        if (shownMatches.length >= perFileCap) break;
        shownMatches.push(hit);
      }
      const line = state.lines[hit.lineNo - 1];
      if (!line) continue;
      lines.push(renderHitLine(line, hit.lineNo));
    }
    if (lines.length === 0) continue;

    filesWithMatches++;
    totalMatches += shownMatches.length;
    const truncated =
      matchCount > shownMatches.length
        ? `\n... showing ${shownMatches.length} of ${matchCount} matches`
        : "";
    const section = `File: ${relativePath}\nRevision: ${state.revisionHash}\n${lines.join("\n")}${truncated}`;

    if (outputLength + section.length > MAX_OUTPUT_BYTES) {
      truncatedByBudget = true;
      // Switch to dump mode: keep rendering remaining files into the dropped
      // log (unbounded by the budget) so the model can access the full output.
      droppedSections.push(section);
      continue;
    }
    sections.push(section);
    outputLength += section.length;

    if (totalMatches >= MAX_TOTAL_MATCHES) {
      sections.push(`... stopped at ${MAX_TOTAL_MATCHES} total matches.`);
      break;
    }
  }

  const droppedNote = await buildTruncationNote(droppedSections);

  if (sections.length === 0) {
    // Real hits existed but the byte budget cut the very first file's section.
    // Report the truncation (with hit counts) instead of a bogus "No matches".
    if (truncatedByBudget) {
      const header = `${filesWithMatches} file${filesWithMatches === 1 ? "" : "s"} matched, ${totalMatches} line${totalMatches === 1 ? "" : "s"} shown.`;
      return textResult(`${header}\n\n... results truncated at 100KB${droppedNote}.`, {
        pattern: params.pattern,
        files: filesWithMatches,
        matches: totalMatches,
      });
    }
    const scope = singleFile ? relative(cwd, rootAbs) : params.path ? params.path : "workspace";
    return textResult(`No matches for /${params.pattern}/ in ${scope}.`, { matches: 0 });
  }

  const omittedNote =
    omittedFiles > 0
      ? `\n... ${omittedFiles} file(s) omitted because they changed during search.`
      : "";
  const budgetNote = truncatedByBudget ? `\n... results truncated at 100KB${droppedNote}.` : "";
  const header = `${filesWithMatches} file${filesWithMatches === 1 ? "" : "s"} matched, ${totalMatches} line${totalMatches === 1 ? "" : "s"} shown.`;
  return textResult(`${header}\n\n${sections.join("\n\n")}${omittedNote}${budgetNote}`, {
    pattern: params.pattern,
    files: filesWithMatches,
    matches: totalMatches,
  });
}

/**
 * Drop hits whose content no longer matches the freshly re-read file. A file
 * is reported as drifted when any of its hits disagree with the current state;
 * the caller omits the whole file in that case.
 */
export function filterDrifted(
  hits: RgHit[],
  lines: Array<{ text: string }>,
): { kept: RgHit[]; drifted: boolean } {
  const kept: RgHit[] = [];
  let drifted = false;
  for (const hit of hits) {
    const line = lines[hit.lineNo - 1];
    if (line === undefined || line.text !== hit.content.replace(/\r?\n$/, "")) {
      drifted = true;
      continue;
    }
    kept.push(hit);
  }
  return { kept, drifted };
}

/** Render one anchored line, truncating overlong content but keeping the anchor prefix. */
function renderHitLine(line: { anchor: string; text: string }, lineNo: number): string {
  const text =
    line.text.length > MAX_LINE_LENGTH ? `${line.text.slice(0, MAX_LINE_LENGTH)}...` : line.text;
  return `${line.anchor}${ANCHOR_DELIMITER} ${text}    line ${lineNo}`;
}

/** Collapsed preview cap, matching pi's built-in grep rendering. */
const MAX_COLLAPSED_LINES = 15;

/** Model-facing cap bookkeeping — redundant with the summary line; hidden from the UI. */
const MODEL_CAP_NOTE_RE = /^\.\.\. showing \d+ of \d+ matches$/;

export function renderGrepResult(
  result: ToolResult,
  options: RenderOptions,
  theme: Theme,
  context: RenderContext,
): Component {
  const errorComponent = errorResultComponent(result, theme, context);
  if (errorComponent) return errorComponent;
  const raw = toolResultText(result);
  try {
    const cleaned = cleanDisplayLines(raw, theme);
    if (!options.expanded) {
      // Collapsed: first 15 presentation-clean lines plus pi's "more lines"
      // hint. Cleaning happens BEFORE capping — the raw model text carries
      // anchor prefixes, hashes, and positional suffixes the UI must never
      // show, and capping raw would both leak them and under-count.
      // pi's collapsed grep prepends the same blank line as expanded.
      return new Text("\n" + collapsedPreview(cleaned, MAX_COLLAPSED_LINES, theme), 0, 0);
    }
    // Expanded: everything the model got, presentation-clean, with pi's
    // leading-newline spacing convention.
    return new Text("\n" + cleaned.join("\n"), 0, 0);
  } catch {
    // The TUI silently replaces a throwing renderer with an unstyled raw
    // fallback; prefer a degraded-but-intentional rendering instead.
    return new Text(raw, 0, 0);
  }
}

/**
 * Model text → UI lines. Drops `Revision:` hashes and the `... showing N of M
 * matches` cap note (model bookkeeping); dims `File:` section headers (kept —
 * they group multi-file results); strips anchor prefixes (indentation
 * preserved) and the positional `    line N` suffix from every content line.
 */
function cleanDisplayLines(raw: string, theme: Theme): string[] {
  const cleaned: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("Revision:")) continue;
    if (MODEL_CAP_NOTE_RE.test(line)) continue;
    if (line.startsWith("File:")) {
      cleaned.push(theme.fg("muted", line));
      continue;
    }
    cleaned.push(theme.fg("toolOutput", stripLineDisplay(stripAnchorPrefix(line))));
  }
  return cleaned;
}

/** Drop the trailing positional `    line N` suffix for UI display only. */
function stripLineDisplay(line: string): string {
  return line.replace(/ {4}line \d+$/, "");
}

/**
 * Persist dropped sections to a temp log (pi's bash-truncation convention:
 * the model gets a pointer to the full output instead of a dead-end note).
 * Returns the ` — full output: <path> (N lines)` suffix, or "" when nothing
 * was dropped.
 */
async function buildTruncationNote(dropped: string[]): Promise<string> {
  if (dropped.length === 0) return "";
  const text = dropped.join("\n\n") + "\n";
  const path = joinPath(tmpdir(), `pi-fast-edits-grep-${randomBytes(6).toString("hex")}.log`);
  try {
    await writeFile(path, text, "utf8");
    const lines = text.split("\n").length;
    return ` — full output: ${path} (${lines} lines)`;
  } catch {
    return " — results truncated; full output could not be written";
  }
}

function joinPath(a: string, b: string): string {
  // local join to avoid importing node:path twice (path module already imported)
  return a.endsWith("/") ? a + b : a + "/" + b;
}

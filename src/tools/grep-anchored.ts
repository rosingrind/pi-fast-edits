import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { PiFastEditsConfig, SessionState } from "../types.js";
import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ANCHOR_DELIMITER } from "../anchor/anchor-renderer.js";
import { isProtectedPath } from "../fs/path-safety.js";
import { resolveRg } from "../fs/rg-resolver.js";
import { runRg, type RgHit } from "../fs/rg-search.js";
import {
  renderToolCall,
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
  maxMatches: Type.Optional(
    Type.Number({
      description: `Maximum matching lines shown per file (default ${DEFAULT_MAX_MATCHES_PER_FILE}).`,
    }),
  ),
});
type GrepParams = Static<typeof grepSchema>;

export function registerGrepAnchoredFiles(
  pi: ExtensionAPI,
  session: SessionState,
  config: PiFastEditsConfig,
): void {
  pi.registerTool({
    name: "grep_anchored_files",
    label: "Grep Anchored Files",
    description:
      "Search file contents with a regex and get matching lines back with stable word anchors and revision hashes, " +
      "exactly as read_anchored_file renders them. Results can be fed straight into the anchored edit tools " +
      "(use the per-file Revision as expectedRevision). Searches the workspace or a subpath; skips .git, node_modules, protected paths, and binary files.",
    renderCall: renderToolCall("grep_anchored_files", (args, theme) => {
      const pattern = args.pattern as string | undefined;
      if (pattern === undefined) return "";
      const glob = args.glob as string | undefined;
      const path = args.path as string | undefined;
      const suffix = [path ? path : "", glob ? ` ${glob}` : ""].join("").trim();
      return theme.fg("warning", ` /${pattern}/${suffix ? ` in ${suffix}` : ""}`);
    }),
    renderResult: renderGrepResult,
    promptSnippet: "Search files with a regex and get anchored, editable results",
    promptGuidelines: [
      "Results carry the same anchors and revision hashes as read_anchored_file",
      "Pass the per-file Revision header as expectedRevision when editing matches",
      "Use glob to narrow file types, e.g. '**/*.ts'",
      "The `    line N` suffix after each rendered line is positional metadata, not part of the line — do NOT include it in startAnchorLine/endAnchorLine/anchorLine values",
    ],
    renderShell: "default",
    executionMode: "parallel",
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

      // Validate the pattern up front with a friendly message; the real scan
      // is done by rg (Rust regex syntax), which re-validates on its own.
      try {
        new RegExp(params.pattern, params.ignoreCase ? "i" : "");
      } catch (error) {
        throw new Error(
          `Invalid regex pattern: ${params.pattern}. ${error instanceof Error ? error.message : String(error)}`,
        );
      }

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
  });
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
  if (context > 0) args.push("--context", String(context));
  // rg has no built-in knowledge of dependency trees: in non-git workspaces
  // it surfaces node_modules and .git dirs at any depth (only top-level
  // segments were filtered before), so exclude them at the source.
  args.push("--glob", "!**/node_modules/**", "--glob", "!**/.git/**");
  // Always pass the absolute root so rg searches the right directory even when
  // the host process cwd differs from the workspace being searched.
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

  for (const file of [...byFile.keys()].sort()) {
    if (totalMatches >= MAX_TOTAL_MATCHES) break;
    if (signal?.aborted) break;

    const absPath = isAbsolute(file) ? file : resolve(cwd, file);
    let relativePath = relative(cwd, absPath).replace(/\\/g, "/");

    // Directory searches skip the same trees as the JS walker. rg honors
    // gitignore natively, but non-git workspaces still surface dependency
    // and protected files, so re-apply our own filters.
    if (!singleFile) {
      if (SKIPPED_DIRS.has(relativePath.split("/")[0] ?? "")) continue;
      if (isProtectedPath(relativePath, [...PROTECTED_SKIP, ...protectedPaths])) continue;
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

    const { kept, drifted } = filterDrifted(byFile.get(file)!, state.lines);
    if (drifted) {
      omittedFiles++;
      sections.push(`${relativePath}\n${DRIFT_MESSAGE}`);
      outputLength += relativePath.length;
      continue;
    }

    // Context events can duplicate line numbers (overlapping match windows);
    // render each line once, preferring match hits over context.
    const deduped = new Map<number, RgHit>();
    for (const hit of kept) {
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
      break;
    }
    sections.push(section);
    outputLength += section.length;

    if (totalMatches >= MAX_TOTAL_MATCHES) {
      sections.push(`... stopped at ${MAX_TOTAL_MATCHES} total matches.`);
      break;
    }
  }

  if (sections.length === 0) {
    // Real hits existed but the byte budget cut the very first file's section.
    // Report the truncation (with hit counts) instead of a bogus "No matches".
    if (truncatedByBudget) {
      const header = `${filesWithMatches} file${filesWithMatches === 1 ? "" : "s"} matched, ${totalMatches} line${totalMatches === 1 ? "" : "s"} shown.`;
      return textResult(`${header}\n\n... results truncated at 100KB — narrow the search.`, {
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
  const budgetNote = truncatedByBudget
    ? `\n... results truncated at 100KB — narrow the search.`
    : "";
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

/** Protected-path patterns to exclude from directory searches. Kept in sync
 * with the default config's list so grep never surfaces secrets (e.g. .env)
 * that the edit tools guard. */
const PROTECTED_SKIP = [
  ".env",
  ".env.*",
  ".git",
  ".git/**",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];

export function renderGrepResult(
  result: ToolResult,
  options: RenderOptions,
  theme: Theme,
  context: RenderContext,
): Component {
  const raw = result.content?.[0]?.text ?? "";
  if (context.isError) {
    return new Text(theme.fg("error", raw), 0, 0);
  }
  if (!options.expanded) {
    // Collapsed shows just the summary line (first line), matching the
    // built-in tools' quiet collapsed rendering.
    return new Text(theme.fg("muted", raw.split("\n")[0]), 0, 0);
  }
  // Expanded strips the File:/Revision: headers and anchor prefixes, leaving
  // the matching content with its line numbers.
  const lines = raw.split("\n");
  const cleaned: string[] = [];
  for (const line of lines) {
    if (line.startsWith("File:") || line.startsWith("Revision:")) continue;
    cleaned.push(stripAnchorPrefix(line));
  }
  return new Text(cleaned.join("\n"), 0, 0);
}

function stripAnchorPrefix(line: string): string {
  const idx = line.indexOf(ANCHOR_DELIMITER);
  if (idx === -1) return line;
  return line.slice(idx + ANCHOR_DELIMITER.length).trimStart();
}

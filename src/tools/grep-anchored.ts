import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { PiFastEditsConfig, SessionState } from "../types.js";
import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ANCHOR_DELIMITER } from "../anchor/anchor-renderer.js";
import { globToRegExp } from "../fs/glob-match.js";
import { isProtectedPath } from "../fs/path-safety.js";
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
const MAX_FILES_SCANNED = 2000;

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
  _config: PiFastEditsConfig,
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

      let regex: RegExp;
      try {
        regex = new RegExp(params.pattern, params.ignoreCase ? "i" : "");
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
      const files = singleFile ? [rootAbs] : await listFiles(rootAbs, cwd, params.glob);

      const sections: string[] = [];
      let totalMatches = 0;
      let filesWithMatches = 0;
      for (const absPath of files) {
        if (totalMatches >= MAX_TOTAL_MATCHES) break;
        if (signal?.aborted) break;

        // Only take a session slot for files that actually match: a cheap raw
        // read first avoids churning the LRU with every scanned file, and
        // loadStateForPath rejects binary files outright so filter them here.
        const fileStat = await stat(absPath).catch(() => undefined);
        if (!fileStat || !fileStat.isFile() || fileStat.size > MAX_FILE_BYTES) continue;
        const bytes = await readFile(absPath).catch(() => undefined);
        if (!bytes || bytes.includes(0)) continue; // binary or unreadable

        const { relativePath, state } = await loadStateForPath(session, cwd, absPath);

        const matches = state.lines.filter((line) => regex.test(line.text));
        if (matches.length === 0) continue;
        filesWithMatches++;

        const shown = matches.slice(0, perFileCap);
        totalMatches += shown.length;
        const lines = shown.map(
          (line) => `${line.anchor}${ANCHOR_DELIMITER} ${line.text}    line ${line.lineNo}`,
        );
        const truncated =
          matches.length > shown.length
            ? `\n... showing ${shown.length} of ${matches.length} matches`
            : "";
        sections.push(
          `File: ${relativePath}\nRevision: ${state.revisionHash}\n${lines.join("\n")}${truncated}`,
        );

        if (totalMatches >= MAX_TOTAL_MATCHES) {
          sections.push(`... stopped at ${MAX_TOTAL_MATCHES} total matches.`);
          break;
        }
      }

      if (sections.length === 0) {
        const scope = singleFile ? relative(cwd, rootAbs) : params.path ? params.path : "workspace";
        return textResult(`No matches for /${params.pattern}/ in ${scope}.`, { matches: 0 });
      }

      const header = `${filesWithMatches} file${filesWithMatches === 1 ? "" : "s"} matched, ${totalMatches} line${totalMatches === 1 ? "" : "s"} shown.`;
      return textResult(`${header}\n\n${sections.join("\n\n")}`, {
        pattern: params.pattern,
        files: filesWithMatches,
        matches: totalMatches,
      });
    },
  });
}

/**
 * Walk `rootAbs` recursively and return absolute file paths to search.
 * Skips VCS/dependency directories, protected paths, and (when `glob` is set)
 * files whose workspace-relative path does not match.
 */
async function listFiles(rootAbs: string, cwd: string, glob?: string): Promise<string[]> {
  const globRe = glob ? globToRegExp(glob) : undefined;
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (out.length >= MAX_FILES_SCANNED) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip silently
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES_SCANNED) return;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(cwd, abs).replace(/\\/g, "/");
      if (isProtectedPath(rel, PROTECTED_SKIP)) continue;
      if (globRe && !globRe.test(rel) && !globRe.test(basename(rel))) continue;
      out.push(abs);
    }
  }

  await walk(rootAbs);
  out.sort();
  return out;
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

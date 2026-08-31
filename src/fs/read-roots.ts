import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { sep } from "node:path";

/**
 * Host-sanctioned read roots: directories outside the workspace that pi itself
 * already trusts. Two sources, both host decisions rather than user config:
 *
 * 1. Loaded skills — pi tells extensions what it loaded via
 *    `before_agent_start` → `event.systemPromptOptions.skills`; every skill
 *    carries a `baseDir`. This mirrors dirac, where the host preloads skill
 *    content so tools never need outside access; pi's equivalent surface is
 *    this loaded-skills set, which we inherit.
 * 2. pi's package root — pi's own read tool classifies README/docs/examples
 *    reads under its install directory as first-class "docs" resources
 *    (dist/core/tools/read.js `getPiDocsClassification`), so agents reading
 *    pi documentation is an expected activity, not an anomaly.
 */

export type SkillRef = { baseDir?: string };

/** Deduplicated root list; falsy entries dropped. Order: skills, then package root. */
export function collectReadRoots(skills: SkillRef[] | undefined, piPackageRoot?: string): string[] {
  const roots: string[] = [];
  for (const skill of skills ?? []) {
    if (skill?.baseDir) roots.push(skill.baseDir);
  }
  if (piPackageRoot) roots.push(piPackageRoot);
  return [...new Set(roots)];
}

/** Display form: `~/…` for paths under the home directory, absolute otherwise. */
export function displayPathFor(absPath: string, homeDir?: string): string {
  if (!homeDir) return absPath;
  if (absPath === homeDir) return "~";
  const prefix = homeDir.endsWith(sep) ? homeDir : homeDir + sep;
  if (absPath.startsWith(prefix)) return "~" + absPath.slice(homeDir.length);
  return absPath;
}

let docsRootCache: string | undefined;
let docsRootResolved = false;

/**
 * pi's package root, derived without version-coupled named imports (older pi
 * builds don't export getPackageDir). Resolves the package's MAIN entry — the
 * one subpath the exports map is guaranteed to expose; asking for
 * `./package.json` directly throws ERR_PACKAGE_PATH_NOT_EXPORTED on pi 0.74.x —
 * then climbs to the directory that owns the package.json. Result is cached
 * (including failure, which simply disables the docs-root escape).
 */
/** Climb ancestor directories looking for pi's hoisted package directory. */
function resolveViaNodeModules(fromFile: string): string | undefined {
  let dir = dirname(fromFile);
  for (let hop = 0; hop < 12; hop++) {
    const candidate = join(
      dir,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "package.json",
    );
    if (existsSync(candidate)) return dirname(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export function piDocsRoot(): string | undefined {
  if (docsRootResolved) return docsRootCache;
  docsRootResolved = true;
  try {
    // 1) Node's own resolver (real pi runtime): the main entry is the one
    // subpath the exports map guarantees; climb to the package.json owner.
    let dir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
    for (let hop = 0; hop < 6; hop++) {
      if (existsSync(join(dir, "package.json"))) {
        docsRootCache = dir;
        return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // import.meta.resolve unavailable (e.g. Vite/vitest SSR transforms) or
    // resolution failed — fall through to the node_modules walk.
  }
  // 2) Ancestor node_modules walk from this module's own location — works
  // under vitest and for installed packages (deps/peers hoisted alongside).
  docsRootCache = resolveViaNodeModules(fileURLToPath(import.meta.url));
  return docsRootCache;
}

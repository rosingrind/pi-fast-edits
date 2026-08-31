import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { matchesGlob } from "./glob-match.js";

export async function resolveWorkspacePath(cwd: string, requestedPath: string): Promise<string> {
  const abs = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(cwd, requestedPath);
  const workspaceReal = await realpath(cwd).catch(() => resolve(cwd));
  const parentReal = await realpath(abs).catch(async () => {
    const parent = resolve(abs, "..");
    return resolve(await realpath(parent).catch(() => parent), abs.split(/[\\/]/).at(-1) ?? "");
  });
  const rel = relative(workspaceReal, parentReal);
  if (rel.startsWith("..") || rel === ".." || rel.includes(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Refusing to access path outside workspace: ${requestedPath}.`);
  }
  return abs;
}

/**
 * Read-oriented resolution: the workspace stays the primary root, but reads may
 * also target files under host-sanctioned extra roots (loaded skill dirs, pi's
 * package docs — see fs/read-roots.ts). Everything else keeps the strict
 * outside-workspace rejection. Writes/greps never use this function.
 *
 * Returns the realpath when allowed via an extra root (canonical state keying
 * across symlinked roots); in-workspace paths keep resolveWorkspacePath's
 * return convention.
 */
export async function resolveReadPath(
  cwd: string,
  requestedPath: string,
  extraRoots: string[],
): Promise<string> {
  try {
    return await resolveWorkspacePath(cwd, requestedPath);
  } catch (error) {
    const abs = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(cwd, requestedPath);
    const absReal = await realpath(abs).catch(async () => {
      const parent = resolve(abs, "..");
      return resolve(await realpath(parent).catch(() => parent), abs.split(/[\\/]/).at(-1) ?? "");
    });
    for (const root of extraRoots) {
      const rootReal = await realpath(root).catch(() => undefined);
      if (!rootReal) continue;
      const rel = relative(rootReal, absReal);
      if (
        rel === "" ||
        rel.startsWith("..") ||
        rel === ".." ||
        rel.includes(`..${sep}`) ||
        isAbsolute(rel)
      ) {
        continue;
      }
      return absReal;
    }
    throw error;
  }
}

export async function assertRegularFile(path: string): Promise<void> {
  const lst = await lstat(path);
  if (lst.isSymbolicLink()) {
    const real = await realpath(path);
    const target = await stat(real);
    if (!target.isFile()) throw new Error(`Path is not a regular file: ${path}.`);
    return;
  }
  if (!lst.isFile()) throw new Error(`Path is not a regular file: ${path}.`);
}

export function toWorkspaceRelative(cwd: string, abs: string): string {
  return relative(cwd, abs).replace(/\\/g, "/");
}

/** Protected-path patterns applied by default (secrets, VCS internals, lockfiles).
 * Kept in sync with the default config's list so searches and writes never
 * surface the same files the edit tools guard. */
export const DEFAULT_PROTECTED_SKIP = [
  ".env",
  ".env.*",
  ".git",
  ".git/**",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];

export function isProtectedPath(relativePath: string, protectedPaths: string[]): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return protectedPaths.some(
    (pattern) => normalized === pattern || matchesGlob(normalized, pattern),
  );
}

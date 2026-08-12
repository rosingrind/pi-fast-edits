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

export function isProtectedPath(relativePath: string, protectedPaths: string[]): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return protectedPaths.some(
    (pattern) => normalized === pattern || matchesGlob(normalized, pattern),
  );
}

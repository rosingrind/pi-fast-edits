import { randomBytes } from "node:crypto";
import { chmod, mkdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  // Respect symlinked targets (e.g. a stowed ~/.pi/agent/pi-fast-edits.json):
  // resolve the link first so the atomic rename updates the target inode
  // instead of replacing the link itself with a regular file — which would
  // silently break dotfiles-style stowing. Also keeps the temp file on the
  // target's filesystem (rename across devices fails with EXDEV).
  let targetPath = filePath;
  try {
    targetPath = await realpath(filePath);
  } catch {
    // ENOENT on first write, or a dangling link — write at the given path.
  }

  const dir = dirname(targetPath);
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let mode: number | undefined;
  try {
    mode = (await stat(targetPath)).mode;
  } catch {
    mode = undefined;
  }

  try {
    await writeFile(temp, content, "utf8");
    if (mode !== undefined) await chmod(temp, mode);
    await rename(temp, targetPath);
  } catch (error) {
    try {
      await unlink(temp);
    } catch {
      // Best-effort cleanup of the temp file; failure here is non-fatal.
    }
    throw error;
  }
}

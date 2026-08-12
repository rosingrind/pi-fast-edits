import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let mode: number | undefined;
  try {
    mode = (await stat(filePath)).mode;
  } catch {
    mode = undefined;
  }

  try {
    await writeFile(temp, content, "utf8");
    if (mode !== undefined) await chmod(temp, mode);
    await rename(temp, filePath);
  } catch (error) {
    try {
      await unlink(temp);
    } catch {
      // Best-effort cleanup of the temp file; failure here is non-fatal.
    }
    throw error;
  }
}

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { LineEnding } from "../types.js";

export type TextFileSnapshot = {
  text: string;
  lines: string[];
  lineEnding: LineEnding;
  hadFinalNewline: boolean;
  hadBom: boolean;
  revisionHash: string;
  byteLength: number;
};

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function detectLineEnding(text: string): LineEnding {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? "\r\n" : "\n";
}

export function splitTextPreserveFinal(text: string): {
  lines: string[];
  hadFinalNewline: boolean;
  lineEnding: LineEnding;
} {
  const lineEnding = detectLineEnding(text);
  const normalized = text.replace(/\r\n/g, "\n");
  const hadFinalNewline = normalized.endsWith("\n");
  const withoutFinal = hadFinalNewline ? normalized.slice(0, -1) : normalized;
  const lines = withoutFinal.length === 0 ? [] : withoutFinal.split("\n");
  return { lines, hadFinalNewline, lineEnding };
}

export function joinLines(
  lines: string[],
  lineEnding: LineEnding,
  hadFinalNewline: boolean,
): string {
  const joined = lines.join(lineEnding);
  return hadFinalNewline ? `${joined}${lineEnding}` : joined;
}

function looksBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true;
  // Scan the whole buffer, not just a sample, so binary content beyond the
  // first 8KB (e.g. trailing invalid UTF-8) is still detected.
  const decoded = buffer.toString("utf8");
  return decoded.includes("\uFFFD");
}

export async function readTextFile(filePath: string): Promise<TextFileSnapshot> {
  const buffer = await readFile(filePath);
  if (looksBinary(buffer)) {
    throw new Error(`Cannot edit ${filePath} because it appears to be a binary file.`);
  }
  let hadBom = false;
  let text = buffer.toString("utf8");
  // Strip a UTF-8 BOM from the working text so it does not get glued to the
  // first line and lost when that line is edited; re-added on write.
  if (text.charCodeAt(0) === 0xfeff) {
    hadBom = true;
    text = text.slice(1);
  }
  const { lines, hadFinalNewline, lineEnding } = splitTextPreserveFinal(text);
  return {
    text,
    lines,
    hadFinalNewline,
    hadBom,
    lineEnding,
    revisionHash: hashText(text),
    byteLength: buffer.byteLength,
  };
}

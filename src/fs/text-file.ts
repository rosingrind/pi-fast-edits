import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { LineEnding } from "../types.js";

export type TextFileSnapshot = {
  text: string;
  lines: string[];
  lineEnding: LineEnding;
  hadFinalNewline: boolean;
  revisionHash: string;
  byteLength: number;
};

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function hashLine(text: string): string {
  return hashText(text);
}

export function detectLineEnding(text: string): LineEnding {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? "\r\n" : "\n";
}

export function splitTextPreserveFinal(text: string): { lines: string[]; hadFinalNewline: boolean; lineEnding: LineEnding } {
  const lineEnding = detectLineEnding(text);
  const normalized = text.replace(/\r\n/g, "\n");
  const hadFinalNewline = normalized.endsWith("\n");
  const withoutFinal = hadFinalNewline ? normalized.slice(0, -1) : normalized;
  const lines = withoutFinal.length === 0 ? [] : withoutFinal.split("\n");
  return { lines, hadFinalNewline, lineEnding };
}

export function joinLines(lines: string[], lineEnding: LineEnding, hadFinalNewline: boolean): string {
  const joined = lines.join(lineEnding);
  return hadFinalNewline ? `${joined}${lineEnding}` : joined;
}

export function looksBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  const decoded = sample.toString("utf8");
  return decoded.includes("\uFFFD");
}

export async function readTextFile(filePath: string): Promise<TextFileSnapshot> {
  const buffer = await readFile(filePath);
  if (looksBinary(buffer)) {
    throw new Error(`Cannot edit ${filePath} because it appears to be a binary file.`);
  }
  const text = buffer.toString("utf8");
  const { lines, hadFinalNewline, lineEnding } = splitTextPreserveFinal(text);
  return {
    text,
    lines,
    hadFinalNewline,
    lineEnding,
    revisionHash: hashText(text),
    byteLength: buffer.byteLength
  };
}

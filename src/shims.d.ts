// Minimal ambient declarations let this repository type-check before npm
// dependencies are installed. The real packages provide richer types in users'
// Pi environments.
declare module "@earendil-works/pi-coding-agent" {
  export type ExtensionAPI = {
    registerTool(tool: any): void;
    registerCommand(name: string, command: any): void;
    on(event: string, handler: (...args: any[]) => any): void;
  };
}

declare module "typebox" {
  export const Type: any;
}

declare const process: { cwd(): string; pid: number };
declare const console: { log(...args: any[]): void };
declare class Buffer extends Uint8Array {
  static byteLength(input: string): number;
  static from(input: string): Buffer;
  includes(value: number | string): boolean;
  subarray(start?: number, end?: number): Buffer;
  toString(encoding?: string): string;
  readonly byteLength: number;
}

declare module "node:crypto" {
  export function createHash(algorithm: string): { update(data: string | Uint8Array): { digest(encoding: "hex"): string } };
  export function randomBytes(size: number): { toString(encoding: "hex"): string };
}

declare module "node:fs/promises" {
  export function readFile(path: string): Promise<Buffer>;
  export function writeFile(path: string, content: string, encoding?: string): Promise<void>;
  export function chmod(path: string, mode: number): Promise<void>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function stat(path: string): Promise<{ mode: number; isFile(): boolean }>;
  export function lstat(path: string): Promise<{ isSymbolicLink(): boolean; isFile(): boolean }>;
  export function realpath(path: string): Promise<string>;
  export function unlink(path: string): Promise<void>;
}

declare module "node:path" {
  export const sep: string;
  export function dirname(path: string): string;
  export function join(...parts: string[]): string;
  export function isAbsolute(path: string): boolean;
  export function relative(from: string, to: string): string;
  export function resolve(...parts: string[]): string;
}

/// <reference types="vite/client" />

declare module "node:fs" {
  /**
   * Vite-bundled browser polyfill for synchronous file reads.
   *
   * Only the two-argument overload is exposed; callers that need the
   * Buffer-returning form must use the full Node.js runtime.
   *
   * @param path - File path or URL to read.
   * @param encoding - The character encoding (e.g. "utf-8").
   * @returns The decoded file contents as a string.
   */
  export function readFileSync(path: string | URL, encoding: string): string;
}

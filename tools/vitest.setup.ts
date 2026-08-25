/**
 * Vitest global setup (`tools/vitest.setup.ts`), loaded by `tools/vitest.config.ts`.
 *
 * Loads jest-dom matchers and provides a deterministic `localStorage` shim
 * that matches the browser Storage contract without requiring a Node.js
 * persistence path (which Node 25 exposes as an incomplete shim).
 *
 * @module vitest.setup
 */

import "@testing-library/jest-dom";

/** Creates an in-memory Storage implementation for deterministic test isolation. */
function createTestStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, String(value));
    },
  };
}

// Node 25 exposes an incomplete localStorage unless a persistence path is
// configured. Tests need the browser Storage contract, not that Node shim.
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  writable: true,
  value: createTestStorage(),
});

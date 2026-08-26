import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

/**
 * The frontend keeps a browser-safe copy of the engine connector contract.
 * Drift between the package source and the frontend copy would silently break
 * Zod parsing on one side of the boundary. Strip import lines and compare the
 * remaining schema body so ordinary path differences do not create false diffs.
 */
it("keeps the frontend directorDccEngineContract body in lockstep with @director/dcc-protocol", () => {
  const packagePath = resolve(
    __dirname,
    "../../../../packages/dcc-protocol/src/directorDccEngineContract.ts",
  );
  const frontendPath = resolve(__dirname, "../../src/dcc/directorDccEngineContract.ts");
  const stripImports = (source: string) =>
    source
      .split("\n")
      .filter((line) => !line.startsWith("import "))
      .join("\n")
      .trim();
  expect(stripImports(readFileSync(frontendPath, "utf8"))).toBe(stripImports(readFileSync(packagePath, "utf8")));
});

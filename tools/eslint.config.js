/**
 * Director ESLint flat config (`tools/eslint.config.js`).
 *
 * Lives under `tools/`. Invoke via `npm run lint` or
 * `npx eslint --config tools/eslint.config.js <path>`. ESLint does not
 * auto-discover this file from the repo root.
 *
 * `basePath` / `tsconfigRootDir` are the repository root so globs stay
 * written as `frontend/director/**` rather than `../frontend/director/**`.
 */
import { fileURLToPath } from "node:url";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

export default tseslint.config(
  {
    basePath: projectRoot,
    ignores: ["dist/", "node_modules/", "integrations/plugins/**/mcp/server.mjs", "vendor/"],
  },
  {
    basePath: projectRoot,
    files: [
      "frontend/director/src/**/*.{ts,tsx}",
      "frontend/director/tests/**/*.{ts,tsx}",
      "backend/gateway/**/*.ts",
      "tools/scripts/**/*.ts",
      "packages/protocol/src/**/*.{ts,tsx}",
      "packages/protocol/tests/**/*.ts",
      "packages/dsh-plugin-workbench/src/**/*.ts",
      "packages/dsh-plugin-workbench/tests/**/*.ts",
      "tools/vite.config.ts",
      "tools/vitest.config.ts",
      "tools/vitest.setup.ts",
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        ecmaVersion: "latest",
        projectService: {
          // Standalone CLI entry points are not reachable from tools/tsconfig.json's
          // program roots; lint them against the default project instead.
          allowDefaultProject: [
            "tools/scripts/asset-ingest.ts",
            "tools/scripts/asset-ingest.test.ts",
            "tools/scripts/assetIngestGates.ts",
            "tools/scripts/assetIngestGates.test.ts",
            "tools/scripts/generate-flick-metadata.test.ts",
            "tools/scripts/i18n-completeness.test.ts",
          ],
        },
        sourceType: "module",
        tsconfigRootDir: projectRoot,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      "react-hooks": reactHooks,
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: false }],
      "@typescript-eslint/no-floating-promises": "error",
      "react-hooks/rules-of-hooks": "warn",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    basePath: projectRoot,
    files: ["packages/agent-engine/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/frontend/director/**", "../../../frontend/**"],
              message:
                "Agent-engine must stay store-free. Browser execution belongs in frontend/director/src/agent/.",
            },
          ],
        },
      ],
    },
  },
  {
    basePath: projectRoot,
    files: ["packages/protocol/src/creativeWorkspaceProtocol.ts", "packages/protocol/src/videoGenerationProtocol.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "node:*",
                "react",
                "react/*",
                "zustand",
                "zustand/*",
                "../../../frontend/director/src/comprehensive/**",
              ],
              message:
                "Shared transport contracts must stay runtime-neutral (no Node, React, Zustand, or editor runtime imports).",
            },
          ],
        },
      ],
    },
  },
  {
    basePath: projectRoot,
    files: ["backend/gateway/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        "window",
        "document",
        "navigator",
        "localStorage",
        "sessionStorage",
        "indexedDB",
        "requestAnimationFrame",
        "cancelAnimationFrame",
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "react",
                "react/**",
                "react-dom",
                "react-dom/**",
                "@react-three/**",
                "zustand",
                "zustand/**",
                "@xterm/**",
                "lucide-react",
                "camera-controls",
                "**/src/components/**",
                "**/src/comprehensive/editor/assistant/**",
                "**/src/comprehensive/editor/canvas/**",
                "**/src/comprehensive/editor/panels/**",
                "**/src/comprehensive/editor/store/**",
                "**/src/comprehensive/editor/workspaces/**",
                "**/src/stage/store",
                "**/src/stage/store.*",
              ],
              message:
                "Server code must stay behind shared protocols and pure schemas; React, browser runtime modules, and browser stores belong in the frontend.",
            },
          ],
        },
      ],
    },
  },
);

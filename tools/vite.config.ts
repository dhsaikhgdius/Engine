/**
 * Director Vite build configuration (`tools/vite.config.ts`).
 *
 * Lives under `tools/` so the repository root is not a config dump. Invoke via
 * `npm run dev:ui` / `npm run build` / `npm run preview`, or
 * `npx vite --config tools/vite.config.ts`. Vite does not auto-discover this
 * file from the repo root.
 *
 * `root` is `frontend/director/`; the production bundle writes to repo-root
 * `dist/`. Gateway-relative paths (`/te-man`, `/dcc-import`, `/native-models`)
 * proxy to the same gateway the bundle targets, keeping isolated stacks
 * (e.g. the eval harness on :8899) self-contained. `css.postcss` points at
 * this directory so PostCSS loads `tools/postcss.config.js`.
 *
 * @module vite.config
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** Repository root resolved from this config file's location. */
const worldEngineRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const directorRoot = resolve(worldEngineRoot, "frontend/director");
const directorUiPort = Number(process.env.DIRECTOR_UI_PORT ?? 5175);
// Relative gateway paths (/te-man, /dcc-import, …) proxy to the same gateway the
// browser bundle targets, so an isolated stack (e.g. the eval harness on :8899)
// stays self-contained instead of leaking into a developer's :8787 gateway.
const gatewayProxyTarget = process.env.VITE_STAGE_GATEWAY_URL ?? "http://127.0.0.1:8787";

export default defineConfig({
  root: directorRoot,
  base: "./",
  cacheDir: resolve(worldEngineRoot, "node_modules/.vite/director"),
  envDir: worldEngineRoot,
  publicDir: resolve(worldEngineRoot, "assets/library"),
  assetsInclude: ["**/*.fbx", "**/*.obj", "**/*.glb", "**/*.gltf"],
  css: {
    postcss: resolve(worldEngineRoot, "tools"),
  },
  build: {
    outDir: resolve(worldEngineRoot, "dist"),
    emptyOutDir: true,
    // Three's ESM core is deliberately isolated as a long-lived cacheable vendor chunk.
    chunkSizeWarningLimit: 800,
    modulePreload: {
      polyfill: false,
    },
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("/three/examples/") || id.includes("/three-stdlib/") || id.includes("/camera-controls/")) {
            return "vendor-three-extras";
          }
          // Spark loads lazily with the first gaussian splat asset; keep it out of the eager vendor chunk.
          if (id.includes("/@sparkjsdev/")) return "vendor-splats";
          if (id.includes("/three/")) return "vendor-three";
          if (id.includes("/@react-three/")) return "vendor-r3f";
          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("/scheduler/") ||
            id.includes("/zustand/")
          ) {
            return "vendor-react";
          }
          if (id.includes("/@modelcontextprotocol/") || id.includes("/zod/")) {
            return "vendor-agent";
          }
          if (id.includes("/@xterm/")) return "vendor-terminal";
          if (id.includes("/@dimforge/rapier")) return "vendor-physics";
          if (id.includes("/@gltf-transform/") || id.includes("/draco3dgltf/") || id.includes("/meshoptimizer/")) {
            return "vendor-gltf";
          }
          if (id.includes("/jszip/")) return "vendor-archive";
          if (id.includes("/yjs/") || id.includes("/y-protocols/") || id.includes("/lib0/")) {
            return "vendor-collaboration";
          }
          if (id.includes("/lucide-react/")) return "vendor-icons";
          if (id.includes("/katex/")) return "vendor-katex";
          return "vendor";
        },
      },
    },
  },
  plugins: [react()],
  server: {
    port: Number.isInteger(directorUiPort) && directorUiPort > 0 ? directorUiPort : 5175,
    strictPort: true,
    proxy: {
      "/dcc-import": gatewayProxyTarget,
      "/native-models": gatewayProxyTarget,
      "/te-man": gatewayProxyTarget,
    },
    fs: {
      allow: [worldEngineRoot],
    },
  },
});

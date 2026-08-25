/**
 * PostCSS pipeline for the Director Vite app (`tools/postcss.config.js`).
 *
 * Loaded because `tools/vite.config.ts` sets `css.postcss` to this directory.
 * The docs site keeps its own empty `docs/site/postcss.config.mjs` so it does
 * not inherit Tailwind.
 */
import { fileURLToPath } from "node:url";

const tailwindConfig = fileURLToPath(new URL("./tailwind.config.js", import.meta.url));

export default {
  plugins: {
    tailwindcss: { config: tailwindConfig },
    autoprefixer: {},
  },
};

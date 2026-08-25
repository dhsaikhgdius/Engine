/**
 * Tailwind content scan for `frontend/director/` (`tools/tailwind.config.js`).
 *
 * Referenced explicitly by `tools/postcss.config.js`; Tailwind does not
 * discover this file from the repository root.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const worldEngineRoot = fileURLToPath(new URL("..", import.meta.url));
const directorRoot = resolve(worldEngineRoot, "frontend/director");

/** @type {import('tailwindcss').Config} */
export default {
  content: [resolve(directorRoot, "index.html"), resolve(directorRoot, "src/**/*.{js,ts,jsx,tsx}")],
  theme: {
    extend: {
      colors: {
        bg: "rgb(var(--bg-rgb) / <alpha-value>)",
        surface: "rgb(var(--surface-rgb) / <alpha-value>)",
        "surface-hover": "rgb(var(--surface-hover-rgb) / <alpha-value>)",
        panel: "rgb(var(--panel-rgb) / <alpha-value>)",
        field: "rgb(var(--field-rgb) / <alpha-value>)",
        border: "rgb(var(--border-rgb) / <alpha-value>)",
        text: {
          DEFAULT: "rgb(var(--text-rgb) / <alpha-value>)",
          muted: "rgb(var(--text-muted-rgb) / <alpha-value>)",
          dim: "rgb(var(--text-dim-rgb) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "rgb(var(--accent-rgb) / <alpha-value>)",
          hover: "rgb(var(--accent-hover-rgb) / <alpha-value>)",
        },
        overlay: "rgb(var(--overlay-rgb) / <alpha-value>)",
      },
      spacing: {
        "left-sidebar": "var(--left-sidebar-width)",
        "right-sidebar": "var(--right-sidebar-width)",
      },
    },
  },
  plugins: [],
};

import { readFile, writeFile } from "node:fs/promises";

const bundleUrl = new URL("../../integrations/plugins/director-workbench/mcp/server.mjs", import.meta.url);
const source = await readFile(bundleUrl, "utf8");
const normalized = source.replace(/[\t ]+$/gm, "");

if (normalized !== source) await writeFile(bundleUrl, normalized);

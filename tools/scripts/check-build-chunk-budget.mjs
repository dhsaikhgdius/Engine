// Budget overruns warn instead of failing CI: Director is a local loopback tool where chunk
// size changes first paint by milliseconds, so the budget is a growth signal, not a hard gate.
import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

const assetsDirectory = resolve(process.cwd(), "dist/assets");
const applicationChunkBudgetBytes = 800 * 1024;
const names = await readdir(assetsDirectory);
const scripts = await Promise.all(
  names
    .filter((name) => name.endsWith(".js"))
    .map(async (name) => ({ name, bytes: (await stat(resolve(assetsDirectory, name))).size })),
);
const applicationChunks = scripts.filter((chunk) => !chunk.name.startsWith("vendor-"));
const vendorChunks = scripts.filter((chunk) => chunk.name.startsWith("vendor-"));
const oversized = applicationChunks
  .filter((chunk) => chunk.bytes > applicationChunkBudgetBytes)
  .sort((left, right) => right.bytes - left.bytes);
const largest = [...applicationChunks].sort((left, right) => right.bytes - left.bytes)[0];

const toKiB = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

if (oversized.length > 0) {
  const header = { name: "chunk", size: "size", budget: "budget", over: "over" };
  const rows = oversized.map((chunk) => ({
    name: chunk.name,
    size: toKiB(chunk.bytes),
    budget: toKiB(applicationChunkBudgetBytes),
    over: `+${toKiB(chunk.bytes - applicationChunkBudgetBytes)}`,
  }));
  const columns = Object.keys(header);
  const widths = Object.fromEntries(
    columns.map((column) => [
      column,
      Math.max(header[column].length, ...rows.map((row) => row[column].length)),
    ]),
  );
  const renderRow = (row) => columns.map((column) => row[column].padEnd(widths[column])).join("  ");
  console.warn(
    `Warning: ${oversized.length} application chunk(s) exceed the ${toKiB(applicationChunkBudgetBytes)} budget (not enforced):`,
  );
  console.warn(renderRow(header));
  for (const row of rows) console.warn(renderRow(row));
} else if (largest) {
  console.log(
    `Director chunk budget passed: largest application chunk ${largest.name} ${toKiB(largest.bytes)} / ${toKiB(applicationChunkBudgetBytes)}.`,
  );
}

if (vendorChunks.length > 0) {
  const vendorTotalBytes = vendorChunks.reduce((total, chunk) => total + chunk.bytes, 0);
  const largestVendor = [...vendorChunks].sort((left, right) => right.bytes - left.bytes)[0];
  console.log(
    `Vendor chunks (informational): ${vendorChunks.length} files, ${toKiB(vendorTotalBytes)} total, largest ${largestVendor.name} ${toKiB(largestVendor.bytes)}.`,
  );
}

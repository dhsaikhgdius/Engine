// CLI gate for i18n completeness (wired into `npm run repo:check`).
// Fails when a new untranslated Chinese UI string appears in
// frontend/director/src, or when a baseline entry became stale.
// Refresh known gaps intentionally with:
//   node tools/scripts/check-i18n-completeness.mjs --update-baseline
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASELINE_RELATIVE_PATH, checkI18nCompleteness } from "./i18n-completeness.mjs";

const root = process.cwd();
const { failures, stats, missing } = checkI18nCompleteness(root);

if (process.argv.includes("--update-baseline")) {
  writeFileSync(join(root, BASELINE_RELATIVE_PATH), `${JSON.stringify(missing, null, 2)}\n`);
  console.log(`i18n baseline updated: ${missing.length} known untranslated strings recorded.`);
  process.exit(0);
}

if (failures.length > 0) {
  console.error("i18n completeness check failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(
    "\nAdd English translations to frontend/director/src/comprehensive/i18n/en-US.json (or a phrase rule)." +
      "\nOnly if a string is intentionally untranslated, refresh the baseline with" +
      "\n  node tools/scripts/check-i18n-completeness.mjs --update-baseline" +
      "\nand justify the change in review. The baseline must only shrink over time.",
  );
  process.exitCode = 1;
} else {
  console.log(
    `i18n completeness passed: ${stats.translated}/${stats.total} Chinese UI strings translated, ` +
      `${stats.baselined} known gaps tracked in the baseline.`,
  );
}

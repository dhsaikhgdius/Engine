// i18n completeness library: extracts Chinese UI source strings from the
// Director frontend and checks that every one is covered by en-US.json or a
// phrase rule. Known gaps live in i18n-missing-baseline.json so the gate
// ratchets: new untranslated strings fail, and translated (or removed)
// strings must leave the baseline. CLI wrapper: check-i18n-completeness.mjs.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

/** Matches CJK Unified Ideographs (the same range language.tsx treats as translatable). */
const CJK_PATTERN = /[\u3400-\u9fff]/;

const SOURCE_ROOT = join("frontend", "director", "src");
const I18N_DIRECTORY = join(SOURCE_ROOT, "comprehensive", "i18n");
export const BASELINE_RELATIVE_PATH = join("tools", "scripts", "i18n-missing-baseline.json");

function* walkSourceFiles(directory, i18nDirectory) {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (full === i18nDirectory) continue;
    if (statSync(full).isDirectory()) {
      yield* walkSourceFiles(full, i18nDirectory);
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts")) {
      yield full;
    }
  }
}

/**
 * Extract every Chinese string literal and JSX text from one TypeScript
 * source. Mirrors the runtime translator: leading/trailing whitespace is
 * stripped and only bodies containing CJK characters count. Template
 * literals with substitutions are skipped — their composed output is covered
 * by phrase rules, which static analysis cannot verify.
 *
 * @param sourceText - The file contents.
 * @param fileName - The file name (drives TS vs TSX parsing).
 * @returns The deduplicated Chinese source strings found in the file.
 */
export function extractChineseUiStrings(sourceText, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found = new Set();
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) {
      const body = node.text.trim();
      if (body && CJK_PATTERN.test(body)) found.add(body);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...found];
}

/**
 * Compile the config-level phrase rules from phraseRules.json. Handler-backed
 * rules count as coverage too: the handler translates whatever the pattern
 * captured.
 *
 * @param phraseRuleConfigs - Parsed phraseRules.json entries.
 * @returns Compiled regular expressions.
 */
export function compilePhraseRules(phraseRuleConfigs) {
  return phraseRuleConfigs.map((config) => new RegExp(config.pattern, config.flags));
}

/**
 * Decide whether one Chinese source string is covered by the translation
 * surface: a direct en-US.json key or any phrase-rule pattern.
 *
 * @param source - The trimmed Chinese source string.
 * @param translations - The en-US.json dictionary.
 * @param phraseRules - Compiled phrase-rule patterns.
 * @returns True when the string translates to English at runtime.
 */
export function isTranslated(source, translations, phraseRules) {
  if (typeof translations[source] === "string" && translations[source].trim() !== "") return true;
  return phraseRules.some((pattern) => pattern.test(source));
}

/**
 * Scan the Director frontend and compute i18n coverage against en-US.json,
 * the phrase rules, and the checked-in baseline of known gaps.
 *
 * @param root - Repository root.
 * @returns Failures (empty when the gate passes) plus coverage statistics.
 */
export function checkI18nCompleteness(root) {
  const translations = JSON.parse(readFileSync(join(root, I18N_DIRECTORY, "en-US.json"), "utf8"));
  const phraseRules = compilePhraseRules(JSON.parse(readFileSync(join(root, I18N_DIRECTORY, "phraseRules.json"), "utf8")));
  const baseline = new Set(JSON.parse(readFileSync(join(root, BASELINE_RELATIVE_PATH), "utf8")));

  const filesByString = new Map();
  for (const file of walkSourceFiles(join(root, SOURCE_ROOT), join(root, I18N_DIRECTORY))) {
    const relativeFile = relative(root, file).split(sep).join("/");
    for (const source of extractChineseUiStrings(readFileSync(file, "utf8"), file)) {
      if (!filesByString.has(source)) filesByString.set(source, []);
      filesByString.get(source).push(relativeFile);
    }
  }

  const failures = [];
  const missing = [];
  for (const [source, files] of filesByString) {
    if (isTranslated(source, translations, phraseRules)) {
      if (baseline.has(source)) {
        failures.push(`translated but still in baseline (remove it): "${source}"`);
      }
      continue;
    }
    missing.push(source);
    if (!baseline.has(source)) {
      failures.push(
        `untranslated UI string "${source}" (${files.slice(0, 3).join(", ")}) — add an en-US.json entry or a phrase rule`,
      );
    }
  }
  const present = new Set(filesByString.keys());
  for (const entry of baseline) {
    if (!present.has(entry)) failures.push(`baseline entry no longer in source (remove it): "${entry}"`);
  }
  for (const [key, value] of Object.entries(translations)) {
    if (typeof value !== "string" || value.trim() === "") failures.push(`en-US.json has an empty translation for "${key}"`);
  }

  return {
    failures,
    stats: {
      total: filesByString.size,
      translated: filesByString.size - missing.length,
      baselined: missing.length,
    },
    missing: missing.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
  };
}

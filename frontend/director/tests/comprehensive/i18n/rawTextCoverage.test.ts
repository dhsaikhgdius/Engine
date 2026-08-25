import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { translateString } from "../../../src/comprehensive/i18n/language";

/**
 * Raw Chinese JSX text and attributes bypass t() and rely on the DOM-walking
 * translator, which can only translate what the dictionary (or a phrase rule)
 * covers. This test keeps that surface complete so English mode never shows
 * untranslated source copy. Dynamic content (data, template literals) is out
 * of scope here.
 */
const comprehensiveRoot = resolve(process.cwd(), "frontend/director/src/comprehensive");
const jsxTextNode = />([^<>{}]*[\u3400-\u9fff][^<>{}]*)</g;
const translatableAttribute =
  /(?:aria-label|title|placeholder|aria-description|alt|aria-valuetext)=["']([^"']*[\u3400-\u9fff][^"']*)["']/g;
/** Generic type params and inline handlers can match the text-node regex; skip anything code-shaped. */
const looksLikeCode = /useState|const |=>|===|\breturn\b|\?\./;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    if (!/\.tsx$/.test(entry.name) || entry.name.includes(".test.")) return [];
    return [file];
  });
}

/** Collapse JSX text the way React renders it: trim each line, join with one space. */
function collapseJsxWhitespace(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

it("translates raw Chinese JSX text and attributes through the dictionary", () => {
  const missing = sourceFiles(comprehensiveRoot).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    const phrases = new Set<string>();
    for (const match of source.matchAll(jsxTextNode)) {
      const phrase = collapseJsxWhitespace(match[1]!);
      if (phrase && !looksLikeCode.test(phrase)) phrases.add(phrase);
    }
    for (const match of source.matchAll(translatableAttribute)) {
      const phrase = collapseJsxWhitespace(match[1]!);
      if (phrase && !looksLikeCode.test(phrase)) phrases.add(phrase);
    }
    return [...phrases].filter((phrase) => /[\u3400-\u9fff]/.test(translateString(phrase, "en-US")));
  });

  expect(Array.from(new Set(missing)).sort()).toEqual([]);
});

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import translations from "../../../src/comprehensive/i18n/en-US.json";
import { translateString } from "../../../src/comprehensive/i18n/language";

const comprehensiveRoot = resolve(process.cwd(), "frontend/director/src/comprehensive");
const staticTranslationCall = /\bt\(\s*["'`]([^"'`]*[\u3400-\u9fff][^"'`]*)["'`]\s*\)/g;
const dynamicTranslationCall = /\bt\(\s*`([^`]*\$\{[^`]+)`\s*\)/g;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    if (!/\.tsx?$/.test(entry.name) || entry.name.includes(".test.")) return [];
    return [file];
  });
}

it("has an English dictionary entry for every static translated UI phrase", () => {
  const missing = sourceFiles(comprehensiveRoot).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return Array.from(source.matchAll(staticTranslationCall), (match) => match[1]!).filter(
      (phrase) => !phrase.includes("${") && !(phrase in translations),
    );
  });

  expect(Array.from(new Set(missing)).sort()).toEqual([]);
});

it("translates generated scene names instead of leaving Chinese in English mode", () => {
  expect(translateString("角色01", "en-US")).toBe("Character 01");
  expect(translateString("机位01", "en-US")).toBe("Camera 01");
  expect(translateString("机位01-截图02", "en-US")).toBe("Camera 01-Capture 02");
  expect(translateString("机位01 已有轨道", "en-US")).toBe("Camera 01 has a track");
  expect(translateString("机位01 静止机位", "en-US")).toBe("Camera 01 static camera");
});

it("translates the system copy around dynamic t() values", () => {
  const untranslated = sourceFiles(comprehensiveRoot).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return Array.from(source.matchAll(dynamicTranslationCall), (match) => match[1]!)
      .filter((phrase) => /[\u3400-\u9fff]/.test(phrase))
      .map((phrase) => phrase.replace(/\$\{[^}]+\}/g, "DirectorValue"))
      .filter((phrase) => /[\u3400-\u9fff]/.test(translateString(phrase, "en-US")));
  });

  expect(Array.from(new Set(untranslated)).sort()).toEqual([]);
});

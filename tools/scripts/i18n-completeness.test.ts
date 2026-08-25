// @vitest-environment node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs module without type declarations.
import { checkI18nCompleteness, compilePhraseRules, extractChineseUiStrings, isTranslated } from "./i18n-completeness.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("extractChineseUiStrings", () => {
  it("collects string literals, template literals, and JSX text containing CJK", () => {
    const source = [
      `const a = "保存快照";`,
      "const b = `导出完成`;",
      `const jsx = <span title="重命名 对象">确认替换</span>;`,
    ].join("\n");
    expect(extractChineseUiStrings(source, "sample.tsx").sort()).toEqual(
      ["保存快照", "导出完成", "确认替换", "重命名 对象"].sort(),
    );
  });

  it("ignores comments, non-CJK strings, and templates with substitutions", () => {
    const source = [
      `// 注释里的中文不算 UI 字符串`,
      `/** 文档注释也不算 */`,
      `const a = "plain english";`,
      "const b = `已导入 ${count} 个素材`;",
    ].join("\n");
    expect(extractChineseUiStrings(source, "sample.ts")).toEqual([]);
  });

  it("trims whitespace and deduplicates repeated strings", () => {
    const source = `const a = "  画布  "; const b = "画布";`;
    expect(extractChineseUiStrings(source, "sample.ts")).toEqual(["画布"]);
  });
});

describe("isTranslated", () => {
  const translations = { 画布: "Canvas" };
  const phraseRules = compilePhraseRules([{ pattern: "^已导入 (\\d+) 个素材$" }]);

  it("accepts direct dictionary keys and phrase-rule matches", () => {
    expect(isTranslated("画布", translations, phraseRules)).toBe(true);
    expect(isTranslated("已导入 3 个素材", translations, phraseRules)).toBe(true);
  });

  it("rejects strings with no dictionary entry or matching rule", () => {
    expect(isTranslated("没有翻译的字符串", translations, phraseRules)).toBe(false);
  });
});

describe("checkI18nCompleteness", () => {
  it("passes on the current repository (baseline is exact and en-US.json covers the rest)", () => {
    const { failures, stats } = checkI18nCompleteness(repoRoot);
    expect(failures).toEqual([]);
    expect(stats.translated).toBeGreaterThan(0);
  });
});

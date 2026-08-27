import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { expect, it } from "vitest";
import { translateString } from "../../../src/comprehensive/i18n/language";

/**
 * Notification and error copy in plain .ts modules (notifyDirector toasts,
 * thrown Error messages, terminal banners) reaches the DOM through the
 * notification layer and relies on the DOM-walking translator, which can only
 * translate what the dictionary or a phrase rule covers. This test keeps the
 * notification surface complete and ratchets the remaining thrown-error
 * backlog per file so it can only shrink.
 */
const sourceRoot = resolve(process.cwd(), "frontend/director/src");
const han = /[\u3400-\u9fff]/;

/**
 * Modules whose thrown Chinese error messages are not yet covered by the
 * dictionary or phrase rules. Remove a file once its throws translate; never
 * add new files here — cover new copy in en-US.json instead.
 */
const KNOWN_UNTRANSLATED_THROW_FILES = new Set([
  "comprehensive/editor/audio/stageTimelineAudio.ts",
  "comprehensive/editor/collaboration/directorCollaboration.ts",
  "comprehensive/editor/generated3d/generated3dPromotion.ts",
  "comprehensive/editor/loaders/localModelImport.ts",
  "comprehensive/editor/loaders/panoramaImport.ts",
  "comprehensive/editor/loaders/textureImport.ts",
  "comprehensive/editor/media/creativeMediaProbe.ts",
  "comprehensive/editor/media/mediaTranscriptionBridge.ts",
  "comprehensive/editor/media/persistentCreativeMediaStore.ts",
  "comprehensive/editor/modelLibrary/flickPublicCatalog.ts",
  "comprehensive/editor/modelLibrary/mixamoCharacterCatalog.ts",
  "comprehensive/editor/reconstruction/captureReconstructionApply.ts",
  "comprehensive/editor/reconstruction/captureReconstructionClient.ts",
  "comprehensive/editor/reconstruction/referenceImageAnalysis.ts",
  "comprehensive/editor/reconstruction/referenceSceneReconstruction.ts",
  "comprehensive/editor/schema/directorProductionEvaluator.ts",
  "comprehensive/editor/store/directorStore.ts",
  "comprehensive/editor/storyboard/storyboardCapture.ts",
  "comprehensive/editor/storyboard/storyboardPdf.ts",
  "comprehensive/editor/video/directorVideoExport.ts",
  "comprehensive/editor/video/videoRecordingStore.ts",
  "comprehensive/editor/workspaces/canvasPipeline.ts",
  "comprehensive/editor/workspaces/creativeProjectBundle.ts",
  "comprehensive/editor/workspaces/directorGallery.ts",
  "comprehensive/editor/workspaces/directorMediaLibrary.ts",
  "comprehensive/editor/workspaces/directorTimelineVideoExport.ts",
]);

const throwStatement = /throw new \w*Error\(\s*(?:"([^"\n]*)"|`([^`]*)`)/g;
const terminalBanner = /writeBanner\(\s*(?:"([^"\n]*)"|`([^`]*)`)/g;
const anyStringLiteral = /"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    if (!/\.tsx?$/.test(entry.name) || entry.name.includes(".test.")) return [];
    return [file];
  });
}

/** Substitute dynamic segments the way the phrase-rule tests do. */
function isUntranslated(phrase: string): boolean {
  const probe = phrase.replace(/\$\{[^}]+\}/g, "DirectorValue");
  return han.test(translateString(probe, "en-US"));
}

/** Every argument object passed to notifyDirector, found by brace matching. */
function notificationBlocks(source: string): string[] {
  const blocks: string[] = [];
  for (
    let index = source.indexOf("notifyDirector({");
    index >= 0;
    index = source.indexOf("notifyDirector({", index + 1)
  ) {
    const start = source.indexOf("{", index);
    let depth = 0;
    for (let cursor = start; cursor < source.length; cursor += 1) {
      if (source[cursor] === "{") depth += 1;
      else if (source[cursor] === "}") {
        depth -= 1;
        if (depth === 0) {
          blocks.push(source.slice(start, cursor + 1));
          break;
        }
      }
    }
  }
  return blocks;
}

it("translates every Chinese notifyDirector title, detail, and action label", () => {
  const missing = sourceFiles(sourceRoot).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return notificationBlocks(source).flatMap((block) =>
      Array.from(block.matchAll(anyStringLiteral), (match) => match[1] ?? match[2] ?? match[3] ?? "")
        .filter((phrase) => han.test(phrase) && isUntranslated(phrase))
        .map((phrase) => `${relative(sourceRoot, file)}: ${phrase}`),
    );
  });

  expect(Array.from(new Set(missing)).sort()).toEqual([]);
});

it("translates thrown error and terminal banner copy outside the known backlog", () => {
  const missing: string[] = [];
  const cleanBacklogFiles = new Set(KNOWN_UNTRANSLATED_THROW_FILES);
  for (const file of sourceFiles(sourceRoot)) {
    const source = readFileSync(file, "utf8");
    const relativeFile = relative(sourceRoot, file).split("\\").join("/");
    const phrases = [
      ...Array.from(source.matchAll(throwStatement), (match) => match[1] ?? match[2] ?? ""),
      ...Array.from(source.matchAll(terminalBanner), (match) => match[1] ?? match[2] ?? ""),
    ].filter((phrase) => han.test(phrase) && isUntranslated(phrase));
    if (phrases.length === 0) continue;
    cleanBacklogFiles.delete(relativeFile);
    if (KNOWN_UNTRANSLATED_THROW_FILES.has(relativeFile)) continue;
    missing.push(...phrases.map((phrase) => `${relativeFile}: ${phrase}`));
  }

  expect(Array.from(new Set(missing)).sort()).toEqual([]);
  // A file whose throws all translate must leave the backlog so it cannot regress silently.
  expect([...cleanBacklogFiles].sort()).toEqual([]);
});

it("translates the agent gateway failure messages that are thrown from variables", () => {
  // agentGatewayClient.ts composes DirectorAgentClientError messages from a
  // lookup table, so the literal scanners above never see them.
  expect(translateString("Codex 规划进程失败（codex_failed，HTTP 502）", "en-US")).toBe(
    "The Codex planning process failed (codex_failed, HTTP 502)",
  );
  expect(translateString("Codex CLI 尚未登录（codex_not_logged_in，HTTP 401）", "en-US")).toBe(
    "Codex CLI is not logged in (codex_not_logged_in, HTTP 401)",
  );
  expect(translateString("Agent Gateway 请求失败（HTTP 500）", "en-US")).toBe(
    "Agent Gateway request failed (HTTP 500)",
  );
  expect(translateString("Codex 没有返回有效的结构化计划", "en-US")).toBe(
    "Codex did not return a valid structured plan",
  );
  expect(translateString("未找到 Codex CLI", "en-US")).toBe("Codex CLI not found");
  expect(translateString("Codex 输出过长", "en-US")).toBe("Codex output was too long");
  expect(translateString("Codex 规划超时", "en-US")).toBe("Codex planning timed out");
  expect(translateString("无法确认 Codex CLI 登录状态", "en-US")).toBe("Could not verify the Codex CLI login status");
  expect(translateString("请求格式不正确", "en-US")).toBe("The request format is invalid");
  expect(translateString("规划后场景 revision 已变化，命令未执行", "en-US")).toBe(
    "The scene revision changed after planning; the command was not executed",
  );
  expect(translateString("已通过统一 Director 服务执行", "en-US")).toBe(
    "Executed through the unified Director service",
  );
  expect(translateString("命令执行失败", "en-US")).toBe("Command execution failed");
  expect(translateString("确认 update_object：obj-1、obj-2", "en-US")).toBe("Confirm update_object: obj-1、obj-2");
  // Terminal session banners rendered while the gateway socket reconnects.
  expect(translateString("Gateway 连接已中断，正在重试…", "en-US")).toBe("Gateway connection lost; retrying…");
  expect(translateString("正在启动 codex…", "en-US")).toBe("Starting codex…");
  expect(translateString("claude 进程已退出（exit 1）", "en-US")).toBe("claude exited (code 1)");
});

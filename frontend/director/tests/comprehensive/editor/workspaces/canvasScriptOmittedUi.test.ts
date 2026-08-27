import { describe, expect, it } from "vitest";
import {
  CANVAS_SCRIPT_OMIT_LABELS,
  CANVAS_SCRIPT_OMITTED_CODES,
  canvasScriptOmitLabel,
  formatCanvasScriptImportMessage,
  formatCanvasScriptOmittedDetailLine,
  summarizeCanvasScriptOmitted,
} from "../../../../src/comprehensive/editor/workspaces/canvasScriptOmittedUi";
import { DIRECTOR_FOUNTAIN_OMITTED_CODES } from "../../../../src/comprehensive/editor/interchange/fountain";

const identity = (source: string) => source;

describe("canvasScriptOmittedUi", () => {
  it("covers board_capacity plus every Fountain importer omit code", () => {
    expect(CANVAS_SCRIPT_OMITTED_CODES).toEqual(["board_capacity", ...DIRECTOR_FOUNTAIN_OMITTED_CODES]);
    for (const code of CANVAS_SCRIPT_OMITTED_CODES) {
      expect(CANVAS_SCRIPT_OMIT_LABELS[code]).toBeTruthy();
    }
  });

  it("maps known codes to zh-CN labels and falls back to the raw code", () => {
    expect(canvasScriptOmitLabel("board_capacity")).toBe("画板容量已满");
    expect(canvasScriptOmitLabel("character_dialogue")).toBe("对白未导入分镜");
    expect(canvasScriptOmitLabel("transition")).toBe("转场已跳过");
    expect(canvasScriptOmitLabel("invented_future_code")).toBe("invented_future_code");
  });

  it("formats detail lines with code, label, and subject", () => {
    expect(
      formatCanvasScriptOmittedDetailLine(
        {
          code: "board_capacity",
          subject: "node:beat-3",
          reason: "Canvas board reached its 240-node limit",
        },
        identity,
      ),
    ).toBe("board_capacity · 画板容量已满 · node:beat-3");
  });

  it("summarizes omitted entries by code with counts", () => {
    expect(
      summarizeCanvasScriptOmitted(
        [
          { code: "board_capacity", subject: "node:a", reason: "cap" },
          { code: "board_capacity", subject: "node:b", reason: "cap" },
          { code: "character_dialogue", subject: "ALICE", reason: "dialogue" },
        ],
        identity,
      ),
    ).toBe("board_capacity · 画板容量已满 ×2；character_dialogue · 对白未导入分镜");
  });

  it("keeps nodes_added success signal and never claims full import when omitted", () => {
    const withOmit = formatCanvasScriptImportMessage(
      {
        nodes_added: 2,
        omitted: [
          { code: "board_capacity", subject: "node:x", reason: "cap" },
          { code: "title_page_field", subject: "Author", reason: "title" },
        ],
        warnings: [],
      },
      identity,
    );
    expect(withOmit.severity).toBe("info");
    expect(withOmit.text).toContain("已导入剧本");
    expect(withOmit.text).toContain("2 个分镜");
    expect(withOmit.text).toContain("board_capacity · 画板容量已满");
    expect(withOmit.text).toContain("title_page_field · 标题页字段未导入");
    expect(withOmit.text).not.toMatch(/\d+ 项已省略/);
    expect(withOmit.details[0]).toContain("board_capacity");
    expect(withOmit.details[1]).toContain("title_page_field");

    const clean = formatCanvasScriptImportMessage({ nodes_added: 4, omitted: [], warnings: [] }, identity);
    expect(clean.severity).toBe("success");
    expect(clean.text).toBe("已导入剧本 · 4 个分镜");
    expect(clean.details).toEqual([]);
  });

  it("caps detail lines and appends a remainder marker", () => {
    const omitted = Array.from({ length: 8 }, (_, index) => ({
      code: "character_dialogue",
      subject: `CHAR_${index}`,
      reason: "dialogue",
    }));
    const status = formatCanvasScriptImportMessage({ nodes_added: 1, omitted, warnings: ["note"] }, identity);
    expect(status.details).toHaveLength(7);
    expect(status.details.at(-1)).toBe("+2");
    expect(status.text).toContain("character_dialogue · 对白未导入分镜 ×8");
    expect(status.text).toContain("note");
  });
});

import { describe, expect, it } from "vitest";
import { MediaTranscriptionRequestError } from "../../../../src/comprehensive/editor/media/mediaTranscriptionBridge";
import {
  formatMediaTranscriptionErrorMessage,
  MEDIA_TRANSCRIPTION_ERROR_LABELS,
  MEDIA_TRANSCRIPTION_UNCONFIGURED_CAPABILITIES_MESSAGE,
  mediaTranscriptionErrorCode,
  mediaTranscriptionErrorLabel,
  presentMediaTranscriptionError,
} from "../../../../src/comprehensive/editor/media/mediaTranscriptionPresentation";

describe("mediaTranscriptionPresentation", () => {
  it("maps known gateway codes onto zh-CN labels without inventing taxonomy", () => {
    expect(mediaTranscriptionErrorLabel("transcription_not_configured")).toBe("转录服务未配置");
    expect(mediaTranscriptionErrorLabel("transcription_job_not_found")).toBe("转录任务不存在");
    expect(mediaTranscriptionErrorLabel("transcription_source_missing")).toBe("转录源文件缺失");
    expect(mediaTranscriptionErrorLabel("gateway_unreachable")).toBe("无法连接转录网关");
    expect(mediaTranscriptionErrorLabel("made_up_code")).toBeNull();
    expect(MEDIA_TRANSCRIPTION_ERROR_LABELS.transcription_not_configured).toBe("转录服务未配置");
  });

  it("extracts structured codes from MediaTranscriptionRequestError and transport failures", () => {
    expect(
      mediaTranscriptionErrorCode(
        new MediaTranscriptionRequestError("No transcription provider is configured", "transcription_not_configured", 503),
      ),
    ).toBe("transcription_not_configured");
    expect(mediaTranscriptionErrorCode(new TypeError("Failed to fetch"))).toBe("gateway_unreachable");
    expect(mediaTranscriptionErrorCode(new Error("plain failure"))).toBeNull();
  });

  it("formats a typed zh label with the stable code for panel alerts", () => {
    const error = new MediaTranscriptionRequestError(
      "No transcription provider is configured",
      "transcription_not_configured",
      503,
    );
    expect(formatMediaTranscriptionErrorMessage(error)).toBe("转录服务未配置（transcription_not_configured）");
    expect(formatMediaTranscriptionErrorMessage(error, { t: (source) => `[${source}]` })).toBe(
      "[转录服务未配置]（transcription_not_configured）",
    );
  });

  it("keeps friendly detail when no structured code is present", () => {
    const presentation = presentMediaTranscriptionError(new Error("upstream broke"), "转录提交失败");
    expect(presentation).toMatchObject({ code: null, label: null });
    expect(formatMediaTranscriptionErrorMessage(new Error("upstream broke"), { fallbackZh: "转录提交失败" })).toContain(
      "upstream broke",
    );
  });

  it("surfaces an unknown gateway code alongside friendly detail without inventing a label", () => {
    const error = new MediaTranscriptionRequestError("Something else", "future_gateway_code", 400);
    expect(formatMediaTranscriptionErrorMessage(error)).toBe("请求失败：Something else（future_gateway_code）");
  });

  it("keeps configured:false capabilities copy honest about submit/retry", () => {
    expect(MEDIA_TRANSCRIPTION_UNCONFIGURED_CAPABILITIES_MESSAGE).toContain("transcription_not_configured");
    expect(MEDIA_TRANSCRIPTION_UNCONFIGURED_CAPABILITIES_MESSAGE).toContain("无法提交或重试");
  });
});

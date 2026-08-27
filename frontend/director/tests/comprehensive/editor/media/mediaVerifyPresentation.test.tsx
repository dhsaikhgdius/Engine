/**
 * Presentation + component tests for media.verify human-facing honesty.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MediaVerifyResultsList } from "../../../../src/comprehensive/editor/media/MediaVerifyResultsList";
import {
  mediaVerifyCountsSummary,
  mediaVerifyHasVerified,
  mediaVerifyIsPending,
  mediaVerifyOmitReasonLabel,
  mediaVerifyOutcomeLabel,
  mediaVerifyResultRows,
  mediaVerifyStorageSummary,
  type MediaVerifyResult,
  type MediaVerifyUiState,
} from "../../../../src/comprehensive/editor/media/mediaVerifyPresentation";

const identity = (value: string) => value;

const SAMPLE_RESULT: MediaVerifyResult = {
  storage: { mode: "memory", durable: false, warning: null },
  counts: { verified: 1, size_mismatch: 1, missing_bytes: 0, not_cataloged: 1, unverified: 1 },
  items: [
    {
      media_id: "media:image:ok",
      outcome: "verified",
      cataloged_bytes: 4,
      stored_bytes: 4,
      object_url_present: true,
      proxy_of: null,
      omit_reason: null,
      detail: null,
    },
    {
      media_id: "media:image:shrunk",
      outcome: "size_mismatch",
      cataloged_bytes: 100,
      stored_bytes: 5,
      object_url_present: true,
      proxy_of: null,
      omit_reason: null,
      detail: null,
    },
    {
      media_id: "media:image:ghost",
      outcome: "not_cataloged",
      cataloged_bytes: null,
      stored_bytes: null,
      object_url_present: null,
      proxy_of: null,
      omit_reason: null,
      detail: "missing",
    },
    {
      media_id: "media:image:opaque",
      outcome: "unverified",
      cataloged_bytes: 12,
      stored_bytes: null,
      object_url_present: true,
      proxy_of: null,
      omit_reason: "blob_reader_unavailable",
      detail: "no reader",
    },
  ],
};

describe("mediaVerifyPresentation", () => {
  it("maps every contract outcome and omit reason to a zh-CN label", () => {
    expect(mediaVerifyOutcomeLabel("verified")).toBe("已验证");
    expect(mediaVerifyOutcomeLabel("size_mismatch")).toBe("大小不匹配");
    expect(mediaVerifyOutcomeLabel("missing_bytes")).toBe("字节缺失");
    expect(mediaVerifyOutcomeLabel("not_cataloged")).toBe("未入册");
    expect(mediaVerifyOutcomeLabel("unverified")).toBe("未验证");
    expect(mediaVerifyOmitReasonLabel("blob_reader_unavailable")).toBe("无法读取持久字节");
    expect(mediaVerifyOmitReasonLabel("probe_failed")).toBe("探测失败");
    expect(mediaVerifyOmitReasonLabel(null)).toBeNull();
  });

  it("projects probe items into display rows without inventing outcomes", () => {
    const rows = mediaVerifyResultRows(SAMPLE_RESULT.items);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      mediaId: "media:image:ok",
      outcome: "verified",
      outcomeLabel: "已验证",
      omitReasonLabel: null,
    });
    expect(rows[3]).toMatchObject({
      outcome: "unverified",
      omitReasonLabel: "无法读取持久字节",
    });
  });

  it("summarizes storage honesty and counts in zh-CN", () => {
    expect(mediaVerifyStorageSummary({ mode: "memory", durable: false, warning: null })).toBe(
      "内存模式（不可持久，刷新后丢失）",
    );
    expect(mediaVerifyStorageSummary({ mode: "indexeddb", durable: true, warning: null })).toBe(
      "持久存储（IndexedDB）",
    );
    expect(mediaVerifyCountsSummary(SAMPLE_RESULT.counts)).toContain("1 已验证");
    expect(mediaVerifyCountsSummary(SAMPLE_RESULT.counts)).toContain("1 大小不匹配");
  });

  it("treats pending as unverified for honesty helpers", () => {
    const pending: MediaVerifyUiState = { status: "pending", mediaIds: ["media:image:ok"] };
    expect(mediaVerifyIsPending(pending)).toBe(true);
    expect(mediaVerifyHasVerified(pending)).toBe(false);
    expect(mediaVerifyHasVerified({ status: "done", result: SAMPLE_RESULT })).toBe(true);
    expect(
      mediaVerifyHasVerified({
        status: "done",
        result: {
          ...SAMPLE_RESULT,
          counts: { verified: 0, size_mismatch: 0, missing_bytes: 1, not_cataloged: 0, unverified: 0 },
        },
      }),
    ).toBe(false);
  });
});

describe("MediaVerifyResultsList", () => {
  it("shows pending copy and never claims verified while probing", () => {
    render(<MediaVerifyResultsList state={{ status: "pending", mediaIds: ["media:image:ok"] }} t={identity} />);
    expect(screen.getByText("正在验证字节…")).toBeInTheDocument();
    expect(screen.queryByText("已验证")).not.toBeInTheDocument();
  });

  it("renders typed outcomes and omit reasons from a completed receipt", () => {
    render(<MediaVerifyResultsList state={{ status: "done", result: SAMPLE_RESULT }} t={identity} />);
    expect(screen.getByLabelText("字节验证结果")).toBeInTheDocument();
    expect(screen.getByText("已验证")).toBeInTheDocument();
    expect(screen.getByText("大小不匹配")).toBeInTheDocument();
    expect(screen.getByText("未入册")).toBeInTheDocument();
    expect(screen.getByText("未验证")).toBeInTheDocument();
    expect(screen.getByText("无法读取持久字节")).toBeInTheDocument();
    expect(screen.getByText("内存模式（不可持久，刷新后丢失）")).toBeInTheDocument();
  });

  it("surfaces error state without inventing a verified claim", () => {
    render(<MediaVerifyResultsList state={{ status: "error", message: "boom" }} t={identity} />);
    expect(screen.getByRole("alert")).toHaveTextContent("字节验证失败：boom");
    expect(screen.queryByText("已验证")).not.toBeInTheDocument();
  });
});

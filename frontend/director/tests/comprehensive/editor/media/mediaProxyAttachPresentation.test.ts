/**
 * Presentation tests for media.proxy.attach storage + durability honesty.
 */

import { describe, expect, it } from "vitest";
import {
  formatMediaProxyAttachSuccessMessage,
  mediaProxyAttachHonestySuffix,
  parseMediaProxyAttachHonesty,
} from "../../../../src/comprehensive/editor/media/mediaProxyAttachPresentation";
import type {
  MediaVerifyProbeItem,
  MediaVerifyStorageStanza,
} from "../../../../src/comprehensive/editor/media/mediaVerifyPresentation";

const identity = (value: string) => value;

const VERIFIED: MediaVerifyProbeItem = {
  media_id: "media:video:proxy",
  outcome: "verified",
  cataloged_bytes: 4,
  stored_bytes: 4,
  object_url_present: true,
  proxy_of: "media:video:original",
  omit_reason: null,
  detail: null,
};

const UNVERIFIED: MediaVerifyProbeItem = {
  media_id: "media:video:proxy",
  outcome: "unverified",
  cataloged_bytes: 12,
  stored_bytes: null,
  object_url_present: true,
  proxy_of: "media:video:original",
  omit_reason: "blob_reader_unavailable",
  detail: "no reader",
};

const MEMORY: MediaVerifyStorageStanza = { mode: "memory", durable: false, warning: null };
const INDEXEDDB: MediaVerifyStorageStanza = { mode: "indexeddb", durable: true, warning: null };

describe("parseMediaProxyAttachHonesty", () => {
  it("parses storage and durability from a media.proxy.attach result", () => {
    expect(
      parseMediaProxyAttachHonesty({
        original: { id: "media:video:original" },
        proxy: { id: VERIFIED.media_id, proxy_of: "media:video:original" },
        previous_proxy_of: null,
        changed: true,
        storage: MEMORY,
        durability: VERIFIED,
      }),
    ).toEqual({ durability: VERIFIED, storage: MEMORY });
  });

  it("returns null when durability or storage is absent or invalid", () => {
    expect(parseMediaProxyAttachHonesty({ changed: true })).toBeNull();
    expect(parseMediaProxyAttachHonesty({ storage: MEMORY, durability: { outcome: "invented" } })).toBeNull();
    expect(parseMediaProxyAttachHonesty(null)).toBeNull();
  });
});

describe("mediaProxyAttachHonestySuffix", () => {
  it("surfaces verified + storage without inventing outcomes", () => {
    expect(mediaProxyAttachHonestySuffix({ durability: VERIFIED, storage: INDEXEDDB })).toBe(
      "已验证 · 持久存储（IndexedDB）",
    );
  });

  it("includes omit reason and never claims durable in memory mode", () => {
    expect(mediaProxyAttachHonestySuffix({ durability: UNVERIFIED, storage: MEMORY })).toBe(
      "未验证 · 无法读取持久字节 · 内存模式（不可持久，刷新后丢失）",
    );
  });
});

describe("formatMediaProxyAttachSuccessMessage", () => {
  it("keeps proxy id / waveform lines and appends durability honesty", () => {
    expect(
      formatMediaProxyAttachSuccessMessage({
        proxyId: "media:video:proxy-candidate-with-long-id",
        waveformReady: true,
        honesty: { durability: VERIFIED, storage: MEMORY },
        t: identity,
      }),
    ).toBe("代理媒体已关联 · media:video:proxy-candidate- · 波形已缓存 · 已验证 · 内存模式（不可持久，刷新后丢失）");
  });

  it("falls back to the thin message when honesty stanzas are missing", () => {
    expect(
      formatMediaProxyAttachSuccessMessage({
        proxyId: "media:video:proxy",
        waveformReady: false,
        honesty: null,
        t: identity,
      }),
    ).toBe("代理媒体已关联 · media:video:proxy");
  });
});

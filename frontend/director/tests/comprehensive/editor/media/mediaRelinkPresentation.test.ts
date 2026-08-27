/**
 * Presentation tests for media.relink storage + durability honesty.
 */

import { describe, expect, it } from "vitest";
import {
  formatMediaRelinkSuccessMessage,
  mediaRelinkHonestySuffix,
  parseMediaRelinkHonesty,
} from "../../../../src/comprehensive/editor/media/mediaRelinkPresentation";
import type {
  MediaVerifyProbeItem,
  MediaVerifyStorageStanza,
} from "../../../../src/comprehensive/editor/media/mediaVerifyPresentation";

const identity = (value: string) => value;

const VERIFIED: MediaVerifyProbeItem = {
  media_id: "media:image:ok",
  outcome: "verified",
  cataloged_bytes: 4,
  stored_bytes: 4,
  object_url_present: true,
  proxy_of: null,
  omit_reason: null,
  detail: null,
};

const UNVERIFIED: MediaVerifyProbeItem = {
  media_id: "media:image:opaque",
  outcome: "unverified",
  cataloged_bytes: 12,
  stored_bytes: null,
  object_url_present: true,
  proxy_of: null,
  omit_reason: "blob_reader_unavailable",
  detail: "no reader",
};

const MISSING: MediaVerifyProbeItem = {
  media_id: "media:image:gone",
  outcome: "missing_bytes",
  cataloged_bytes: 100,
  stored_bytes: null,
  object_url_present: false,
  proxy_of: null,
  omit_reason: null,
  detail: null,
};

const MEMORY: MediaVerifyStorageStanza = { mode: "memory", durable: false, warning: null };
const INDEXEDDB: MediaVerifyStorageStanza = { mode: "indexeddb", durable: true, warning: null };

describe("parseMediaRelinkHonesty", () => {
  it("parses storage and durability from a media.relink result", () => {
    expect(
      parseMediaRelinkHonesty({
        old_media_id: "media:image:old",
        new_media_id: VERIFIED.media_id,
        references_updated: 2,
        waveform_ready: true,
        storage: MEMORY,
        durability: VERIFIED,
      }),
    ).toEqual({ durability: VERIFIED, storage: MEMORY });
  });

  it("returns null when durability or storage is absent or invalid", () => {
    expect(parseMediaRelinkHonesty({ references_updated: 1 })).toBeNull();
    expect(parseMediaRelinkHonesty({ storage: MEMORY, durability: { outcome: "invented" } })).toBeNull();
    expect(parseMediaRelinkHonesty(null)).toBeNull();
  });
});

describe("mediaRelinkHonestySuffix", () => {
  it("surfaces verified + storage without inventing outcomes", () => {
    expect(mediaRelinkHonestySuffix({ durability: VERIFIED, storage: INDEXEDDB })).toBe(
      "已验证 · 持久存储（IndexedDB）",
    );
  });

  it("includes omit reason and never claims durable in memory mode", () => {
    expect(mediaRelinkHonestySuffix({ durability: UNVERIFIED, storage: MEMORY })).toBe(
      "未验证 · 无法读取持久字节 · 内存模式（不可持久，刷新后丢失）",
    );
  });

  it("labels missing_bytes with the same media.verify vocabulary", () => {
    expect(mediaRelinkHonestySuffix({ durability: MISSING, storage: MEMORY })).toBe(
      "字节缺失 · 内存模式（不可持久，刷新后丢失）",
    );
  });
});

describe("formatMediaRelinkSuccessMessage", () => {
  it("keeps references/waveform lines and appends durability honesty", () => {
    expect(
      formatMediaRelinkSuccessMessage({
        referencesUpdated: 2,
        waveformReady: true,
        honesty: { durability: VERIFIED, storage: MEMORY },
        t: identity,
      }),
    ).toBe("素材已重连 · 2 处引用 · 波形已缓存 · 已验证 · 内存模式（不可持久，刷新后丢失）");
  });

  it("falls back to the thin message when honesty stanzas are missing", () => {
    expect(
      formatMediaRelinkSuccessMessage({
        referencesUpdated: 1,
        waveformReady: false,
        honesty: null,
        t: identity,
      }),
    ).toBe("素材已重连 · 1 处引用 · 波形待生成");
  });
});

/**
 * Human-facing presentation for `director_creative media.relink` receipts.
 * Reuses media.verify outcome / omit / storage labels — never invents a sixth
 * durability status. Operators see the same typed honesty Agents already get.
 *
 * @module media-relink-presentation
 */

import {
  creativeWorkspaceMediaDurabilityProbeSchema,
  creativeWorkspaceMediaStorageStanzaSchema,
} from "../../../../../../packages/protocol/src/creativeWorkspaceProtocol";
import {
  mediaVerifyOmitReasonLabel,
  mediaVerifyOutcomeLabel,
  mediaVerifyStorageSummary,
  type MediaVerifyProbeItem,
  type MediaVerifyStorageStanza,
} from "./mediaVerifyPresentation";

/** Parsed storage + durability honesty from a successful media.relink receipt. */
export type MediaRelinkHonesty = {
  durability: MediaVerifyProbeItem;
  storage: MediaVerifyStorageStanza;
};

/**
 * Parses `storage` + `durability` from a media.relink result payload.
 * Returns null when either stanza is missing or fails the contract schema.
 *
 * @param result - `execution.result` from a successful media.relink receipt.
 */
export function parseMediaRelinkHonesty(result: unknown): MediaRelinkHonesty | null {
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  const durability = creativeWorkspaceMediaDurabilityProbeSchema.safeParse(record.durability);
  const storage = creativeWorkspaceMediaStorageStanzaSchema.safeParse(record.storage);
  if (!durability.success || !storage.success) return null;
  return { durability: durability.data, storage: storage.data };
}

/**
 * zh-CN honesty segment: typed durability outcome (+ omit reason) and storage
 * summary. Memory mode never claims durable.
 *
 * @param honesty - Parsed storage + durability stanzas from the receipt.
 */
export function mediaRelinkHonestySuffix(honesty: MediaRelinkHonesty): string {
  const parts = [mediaVerifyOutcomeLabel(honesty.durability.outcome)];
  const omit = mediaVerifyOmitReasonLabel(honesty.durability.omit_reason);
  if (omit) parts.push(omit);
  parts.push(mediaVerifyStorageSummary(honesty.storage));
  return parts.join(" · ");
}

/**
 * Full Video Editor / Canvas success toast after a file-picker relink.
 * Keeps references_updated / waveform lines and appends durability honesty.
 *
 * @param input - Relink counts plus optional parsed honesty stanzas.
 */
export function formatMediaRelinkSuccessMessage(input: {
  referencesUpdated: number;
  waveformReady: boolean;
  honesty: MediaRelinkHonesty | null;
  t: (value: string) => string;
}): string {
  const base = `${input.t("素材已重连")} · ${input.referencesUpdated} ${input.t("处引用")} · ${
    input.waveformReady ? input.t("波形已缓存") : input.t("波形待生成")
  }`;
  if (!input.honesty) return base;
  const honesty = mediaRelinkHonestySuffix(input.honesty)
    .split(" · ")
    .map((part) => input.t(part))
    .join(" · ");
  return `${base} · ${honesty}`;
}

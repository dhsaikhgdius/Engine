/**
 * Human-facing presentation for `director_creative media.proxy.attach` receipts.
 * Reuses media.verify / media.relink outcome / omit / storage labels — never
 * invents a sixth durability status. Operators see the same typed honesty
 * Agents already get on the proxy media id.
 *
 * @module media-proxy-attach-presentation
 */

import {
  mediaRelinkHonestySuffix,
  parseMediaRelinkHonesty,
  type MediaRelinkHonesty,
} from "./mediaRelinkPresentation";

/** Parsed storage + durability honesty from a successful media.proxy.attach receipt. */
export type MediaProxyAttachHonesty = MediaRelinkHonesty;

/**
 * Parses `storage` + `durability` from a media.proxy.attach result payload.
 * Same contract schemas as media.relink / media.verify — returns null when
 * either stanza is missing or fails validation.
 *
 * @param result - `execution.result` from a successful media.proxy.attach receipt.
 */
export function parseMediaProxyAttachHonesty(result: unknown): MediaProxyAttachHonesty | null {
  return parseMediaRelinkHonesty(result);
}

/**
 * zh-CN honesty segment for an attached proxy: typed durability outcome
 * (+ omit reason) and storage summary. Memory mode never claims durable.
 *
 * @param honesty - Parsed storage + durability stanzas from the receipt.
 */
export function mediaProxyAttachHonestySuffix(honesty: MediaProxyAttachHonesty): string {
  return mediaRelinkHonestySuffix(honesty);
}

/**
 * Full Video Editor success toast after a proxy file pick + attach.
 * Keeps proxy id / waveform lines and appends durability honesty.
 *
 * @param input - Proxy id, waveform flag, optional honesty, and translator.
 */
export function formatMediaProxyAttachSuccessMessage(input: {
  proxyId: string;
  waveformReady: boolean;
  honesty: MediaProxyAttachHonesty | null;
  t: (value: string) => string;
}): string {
  const shortId = input.proxyId.slice(0, 28);
  const base = `${input.t("代理媒体已关联")} · ${shortId}${
    input.waveformReady ? ` · ${input.t("波形已缓存")}` : ""
  }`;
  if (!input.honesty) return base;
  const honesty = mediaProxyAttachHonestySuffix(input.honesty)
    .split(" · ")
    .map((part) => input.t(part))
    .join(" · ");
  return `${base} · ${honesty}`;
}

/**
 * Structured list of media.verify probe outcomes for the Video Editor
 * media-engineering panel. Pending state never claims verified.
 */

import {
  mediaVerifyIsPending,
  mediaVerifyOutcomeLabel,
  mediaVerifyResultRows,
  mediaVerifyStorageSummary,
  type MediaVerifyResult,
  type MediaVerifyUiState,
} from "./mediaVerifyPresentation";

function CountsSummary({ counts, t }: { counts: MediaVerifyResult["counts"]; t: (value: string) => string }) {
  const parts: Array<[number, string]> = [
    [counts.verified, "已验证"],
    [counts.size_mismatch, "大小不匹配"],
    [counts.missing_bytes, "字节缺失"],
    [counts.not_cataloged, "未入册"],
    [counts.unverified, "未验证"],
  ];
  return (
    <span>
      {parts.map(([count, label], index) => (
        <span key={label}>
          {index > 0 ? " · " : null}
          {count} {t(label)}
        </span>
      ))}
    </span>
  );
}

export function MediaVerifyResultsList({ state, t }: { state: MediaVerifyUiState; t: (value: string) => string }) {
  if (state.status === "idle") return null;

  if (mediaVerifyIsPending(state)) {
    return (
      <div className="creative-media-verify-results" aria-busy="true" aria-live="polite">
        <p className="creative-media-verify-pending">{t("正在验证字节…")}</p>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="creative-media-verify-results" role="alert">
        <p className="creative-media-verify-error">
          {t("字节验证失败")}
          {state.message ? `：${state.message}` : ""}
        </p>
      </div>
    );
  }

  // Narrow to `done` after idle / pending / error (type predicate + exhaustiveness).
  if (state.status !== "done") return null;

  const rows = mediaVerifyResultRows(state.result.items);
  return (
    <div className="creative-media-verify-results" aria-label={t("字节验证结果")}>
      <p className="creative-media-verify-summary">
        <span>{t(mediaVerifyStorageSummary(state.result.storage))}</span>
        <CountsSummary counts={state.result.counts} t={t} />
      </p>
      <ul className="creative-media-verify-list">
        {rows.map((row) => (
          <li className={`is-${row.outcome}`} key={row.mediaId}>
            <strong>{t(mediaVerifyOutcomeLabel(row.outcome))}</strong>
            <code title={row.mediaId}>{row.mediaId}</code>
            {row.omitReasonLabel ? <span className="creative-media-verify-omit">{t(row.omitReasonLabel)}</span> : null}
            {row.catalogedBytes != null || row.storedBytes != null ? (
              <small>
                {row.catalogedBytes != null ? `${t("入册")} ${row.catalogedBytes}` : "—"}
                {" / "}
                {row.storedBytes != null ? `${t("实测")} ${row.storedBytes}` : "—"}
              </small>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * DCC 提供方浏览器，发现本地 DCC 工具（Blender 等）并生成可移植交换包。
 *
 * @module dcc-provider-browser
 */

import { Box, CheckCircle2, Download, RefreshCw, Send, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DirectorDccExchangeFormat,
  DirectorDccPortableExchangeFormat,
  DirectorDccProviderCatalog,
  DirectorDccProviderId,
  DirectorDccProviderStatus,
} from "../../../dcc/directorDccProviderContract";
import { directorDccEngineIdSchema, type DirectorDccEngineId } from "../../../dcc/directorDccEngineSpace";
import { useLanguage } from "../../i18n/language";
import {
  discoverDirectorDccProviders,
  exportDirectorDccExchangePackage,
  sendDirectorProjectToEngine,
  type DirectorDccEngineSendResult,
  type DirectorDccExchangePackageResult,
} from "../api/dccProviderClient";
import "./DccProviderBrowser.css";

/** Props for the DccProviderBrowser component. */
export interface DccProviderBrowserProps {
  onPackageExported?: (result: DirectorDccExchangePackageResult) => void;
  onEngineSendCompleted?: (result: DirectorDccEngineSendResult) => void;
}

function formatLabel(format: string) {
  return format === "usda" ? "USD" : format.toUpperCase();
}

function isPortableFormat(format: DirectorDccExchangeFormat): format is DirectorDccPortableExchangeFormat {
  return format === "glb" || format === "usda";
}

function preferredPortableFormat(status: DirectorDccProviderStatus): DirectorDccPortableExchangeFormat | null {
  const preferred = status.provider.preferredFormat;
  if (isPortableFormat(preferred)) return preferred;
  return status.provider.exchangeFormats.find(isPortableFormat) ?? null;
}

function engineSendTarget(status: DirectorDccProviderStatus): DirectorDccEngineId | null {
  if (status.provider.integration !== "engine-headless") return null;
  const parsed = directorDccEngineIdSchema.safeParse(status.provider.id);
  return parsed.success ? parsed.data : null;
}

type DirectorLocale = "zh-CN" | "en-US";

function providerStatusSummary(status: DirectorDccProviderStatus, locale: DirectorLocale) {
  if (locale === "en-US") {
    if (status.nativeReady) {
      return status.exchangeReady
        ? "Native connector detected; portable exchange is also available."
        : "Native connector detected; portable exchange is unavailable.";
    }
    if (status.installed) {
      return status.exchangeReady
        ? "Installation detected; use portable exchange while the native connector is unavailable."
        : "Installation detected, but neither a native connector nor portable exchange is ready.";
    }
    return status.exchangeReady
      ? "No local installation detected; portable exchange remains available."
      : "No local installation detected and no exchange path is currently available.";
  }

  if (status.nativeReady) {
    return status.exchangeReady ? "已检测原生连接；同时可使用可移植交换包。" : "已检测原生连接；可移植交换暂不可用。";
  }
  if (status.installed) {
    return status.exchangeReady
      ? "已检测安装；原生连接尚未就绪，可使用可移植交换包。"
      : "已检测安装；原生连接和可移植交换均未就绪。";
  }
  return status.exchangeReady ? "未检测到本机安装；仍可生成可移植交换包。" : "未检测到本机安装；当前没有可用交换路径。";
}

function ProviderReadiness({ status }: { status: DirectorDccProviderStatus }) {
  const { t } = useLanguage();
  return (
    <div className="director-dcc-provider-readiness">
      <span className={status.nativeReady ? "is-ready" : "is-unavailable"} data-native-ready={status.nativeReady}>
        {status.nativeReady ? <CheckCircle2 aria-hidden size={11} /> : <TriangleAlert aria-hidden size={11} />}
        {status.nativeReady ? t("原生连接就绪") : t("原生连接未就绪")}
      </span>
      <span className={status.exchangeReady ? "is-ready" : "is-unavailable"} data-exchange-ready={status.exchangeReady}>
        {status.exchangeReady ? <CheckCircle2 aria-hidden size={11} /> : <TriangleAlert aria-hidden size={11} />}
        {status.exchangeReady ? t("交换包就绪") : t("交换包不可用")}
      </span>
    </div>
  );
}

/**
 * DCC 提供方浏览器，自动发现本地 DCC 工具并展示连接状态和交换包生成能力。
 * @param onPackageExported - 交换包生成成功后的回调。
 */
export function DccProviderBrowser({ onPackageExported, onEngineSendCompleted }: DccProviderBrowserProps) {
  const { locale, t } = useLanguage();
  const requestRef = useRef<AbortController | null>(null);
  const [catalog, setCatalog] = useState<DirectorDccProviderCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [exportingProvider, setExportingProvider] = useState<DirectorDccProviderId | null>(null);
  const [sendingProvider, setSendingProvider] = useState<DirectorDccProviderId | null>(null);
  const [providerMessages, setProviderMessages] = useState<Partial<Record<DirectorDccProviderId, string>>>({});

  const discover = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError("");
    try {
      const next = await discoverDirectorDccProviders({ signal: controller.signal });
      if (!controller.signal.aborted) setCatalog(next);
    } catch (nextError) {
      if (!controller.signal.aborted) {
        setError(nextError instanceof Error ? nextError.message : t("DCC 提供方发现失败"));
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void discover();
    return () => requestRef.current?.abort();
  }, [discover]);

  async function sendToEngine(status: DirectorDccProviderStatus) {
    const engine = engineSendTarget(status);
    if (!engine || !status.nativeReady || sendingProvider || exportingProvider) return;
    setSendingProvider(status.provider.id);
    setProviderMessages((current) => ({ ...current, [status.provider.id]: t("正在通过原生连接器发送到引擎…") }));
    try {
      const result = await sendDirectorProjectToEngine({ provider: engine });
      const sceneNote = result.report.scenePath ? ` · ${result.report.scenePath}` : "";
      setProviderMessages((current) => ({
        ...current,
        [status.provider.id]: `${t("引擎已导入")} ${result.report.importedObjectCount + result.report.importedCameraCount} ${t("个实体")}${sceneNote}`,
      }));
      onEngineSendCompleted?.(result);
    } catch (sendError) {
      setProviderMessages((current) => ({
        ...current,
        [status.provider.id]: sendError instanceof Error ? sendError.message : t("引擎发送失败"),
      }));
    } finally {
      setSendingProvider(null);
    }
  }

  async function exportPackage(status: DirectorDccProviderStatus) {
    const provider = status.provider;
    const format = preferredPortableFormat(status);
    if (!status.exchangeReady || !format || exportingProvider || sendingProvider) return;
    setExportingProvider(provider.id);
    setProviderMessages((current) => ({ ...current, [provider.id]: t("正在生成交换包…") }));
    try {
      const result = await exportDirectorDccExchangePackage({
        provider: provider.id,
        formats: [format],
      });
      const location = result.packagePath ? ` · ${result.packagePath}` : "";
      setProviderMessages((current) => ({
        ...current,
        [provider.id]: `${formatLabel(format)} ${t("交换包已生成")}${location}`,
      }));
      onPackageExported?.(result);
    } catch (nextError) {
      setProviderMessages((current) => ({
        ...current,
        [provider.id]: nextError instanceof Error ? nextError.message : t("交换包生成失败"),
      }));
    } finally {
      setExportingProvider(null);
    }
  }

  return (
    <section aria-label={t("DCC 提供方")} className="director-dcc-provider-browser">
      <header className="director-dcc-provider-browser-heading">
        <div>
          <strong>{t("DCC 与引擎")}</strong>
          <span>{t("按运行时能力发现原生连接与可移植交换")}</span>
        </div>
        <button
          aria-label={t("刷新 DCC 提供方")}
          className="ui-icon-button"
          disabled={loading}
          onClick={() => void discover()}
          type="button"
        >
          <RefreshCw aria-hidden className={loading ? "is-spinning" : undefined} size={14} strokeWidth={1.75} />
        </button>
      </header>

      {loading && !catalog ? <p className="director-dcc-provider-empty">{t("正在发现 DCC 提供方…")}</p> : null}
      {error ? (
        <div className="director-dcc-provider-error" role="alert">
          <TriangleAlert aria-hidden size={13} />
          <span>{error}</span>
          <button onClick={() => void discover()} type="button">
            {t("重试")}
          </button>
        </div>
      ) : null}

      {catalog ? (
        <ul aria-label={t("DCC 提供方列表")} className="director-dcc-provider-list">
          {catalog.providers.map((status) => {
            const provider = status.provider;
            const portableFormat = preferredPortableFormat(status);
            const exporting = exportingProvider === provider.id;
            const engineTarget = engineSendTarget(status);
            const sending = sendingProvider === provider.id;
            return (
              <li className="director-dcc-provider-card" data-provider-id={provider.id} key={provider.id}>
                <div className="director-dcc-provider-title">
                  <span aria-hidden>
                    <Box size={14} />
                  </span>
                  <div>
                    <strong>{provider.label}</strong>
                    <small>{provider.category === "engine" ? t("实时引擎") : t("三维软件")}</small>
                  </div>
                </div>
                <ProviderReadiness status={status} />
                <div
                  className="director-dcc-provider-status-copy"
                  data-i18n-user-content
                  title={providerMessages[provider.id] ?? status.reason ?? undefined}
                >
                  {providerMessages[provider.id] ? (
                    <output className="director-dcc-provider-message">{providerMessages[provider.id]}</output>
                  ) : (
                    <p className="director-dcc-provider-reason">{providerStatusSummary(status, locale)}</p>
                  )}
                </div>
                <button
                  aria-label={`${t("为")} ${provider.label} ${t("生成")} ${portableFormat ? formatLabel(portableFormat) : ""} ${t("交换包")}`}
                  className="director-dcc-provider-export"
                  disabled={!status.exchangeReady || !portableFormat || Boolean(exportingProvider) || Boolean(sendingProvider)}
                  onClick={() => void exportPackage(status)}
                  type="button"
                >
                  <Download aria-hidden size={12} />
                  {exporting
                    ? t("生成中…")
                    : portableFormat
                      ? `${t("生成")} ${formatLabel(portableFormat)} ${t("交换包")}`
                      : t("无可移植交换格式")}
                </button>
                {engineTarget ? (
                  <button
                    aria-label={`${t("通过原生连接器发送到")} ${provider.label}`}
                    className="director-dcc-provider-send"
                    disabled={!status.nativeReady || Boolean(sendingProvider) || Boolean(exportingProvider)}
                    onClick={() => void sendToEngine(status)}
                    title={status.nativeReady ? undefined : t("原生连接器未就绪；请先配置引擎项目与可执行文件")}
                    type="button"
                  >
                    <Send aria-hidden size={12} />
                    {sending ? t("发送中…") : t("无头发送到引擎")}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

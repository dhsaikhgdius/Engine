/**
 * 「DCC / 引擎交接」工作台:Blender / Unreal / Unity / Godot 四个主机的交接入口。
 *
 * 共享目录发现(`/api/dcc` catalog)驱动诚实的能力芯片;Blender 页挂载既有的
 * BlenderLivePanel(内核控制不在此重复),三个引擎页复用 EngineDetailPanel
 * 骨架并注入各自的回执渲染与实时预览区块。
 *
 * @module engine-handoff-dock
 */

import { CheckCircle2, RefreshCw, TriangleAlert } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type {
  DirectorDccProviderCatalog,
  DirectorDccProviderStatus,
} from "../../../../dcc/directorDccProviderContract";
import type { DirectorDccEngineSendResult } from "../../../../dcc/directorDccEngineContract";
import { useLanguage } from "../../../i18n/language";
import { discoverDirectorDccProviders } from "../../api/dccProviderClient";
import { EngineDetailPanel } from "./EngineDetailPanel";
import { GODOT_SEND_NOTES, GodotLiveLinkSection, renderGodotReceipt } from "./GodotHandoffSections";
import { renderUnityReceipt, UNITY_SEND_NOTES, UnityLiveLinkSection } from "./UnityHandoffSections";
import { renderUnrealReceipt, UNREAL_SEND_NOTES, UnrealLiveLinkSection } from "./UnrealHandoffSections";
import "./EngineHandoffDock.css";

const BlenderLivePanel = lazy(() =>
  import("../BlenderLivePanel").then((module) => ({ default: module.BlenderLivePanel })),
);

/** The four handoff hosts, in product order. */
export type EngineHandoffTabId = "blender" | "unreal" | "unity" | "godot";

const TABS: Array<{ id: EngineHandoffTabId; label: string }> = [
  { id: "blender", label: "Blender" },
  { id: "unreal", label: "Unreal" },
  { id: "unity", label: "Unity" },
  { id: "godot", label: "Godot" },
];

/** Props for the engine handoff dock. */
export interface EngineHandoffDockProps {
  /** Surfaces a completed engine send in the host surface (menu footer). */
  onEngineSendCompleted?: (result: DirectorDccEngineSendResult) => void;
}

function statusOf(
  catalog: DirectorDccProviderCatalog | null,
  id: EngineHandoffTabId,
): DirectorDccProviderStatus | null {
  return catalog?.providers.find((status) => status.provider.id === id) ?? null;
}

function TabReadinessDot({ status }: { status: DirectorDccProviderStatus | null }) {
  if (!status) return null;
  const state = status.nativeReady ? "native" : status.exchangeReady ? "exchange" : "unavailable";
  return <i aria-hidden className="director-engine-handoff-tab-dot" data-state={state} />;
}

/**
 * Blender 页:目录状态芯片 + 既有 BlenderLivePanel(实时内核)。.blend 场景导入
 * 与回传(含「纳入新建对象」选项)仍在交换菜单的既有区块中,不在此重复。
 */
function BlenderHandoffTab({ status }: { status: DirectorDccProviderStatus | null }) {
  const { t } = useLanguage();
  return (
    <div className="director-engine-handoff-detail" data-engine="blender">
      {status ? (
        <div className="director-engine-handoff-readiness">
          <span className={status.installed ? "is-ready" : "is-unavailable"}>
            {status.installed ? <CheckCircle2 aria-hidden size={11} /> : <TriangleAlert aria-hidden size={11} />}
            {status.installed ? t("已检测安装") : t("未检测到安装")}
          </span>
          <span className={status.nativeReady ? "is-ready" : "is-unavailable"}>
            {status.nativeReady ? <CheckCircle2 aria-hidden size={11} /> : <TriangleAlert aria-hidden size={11} />}
            {status.nativeReady ? t("原生连接就绪") : t("原生连接未就绪")}
          </span>
          <span className={status.exchangeReady ? "is-ready" : "is-unavailable"}>
            {status.exchangeReady ? <CheckCircle2 aria-hidden size={11} /> : <TriangleAlert aria-hidden size={11} />}
            {status.exchangeReady ? t("交换包就绪") : t("交换包不可用")}
          </span>
        </div>
      ) : null}
      <p className="director-engine-handoff-hint">
        {t(".blend 场景导入与回传（含「纳入 Blender 新建对象」选项）在本菜单的「导入 Blender 场景」与「DCC 回传」区块")}
      </p>
      <Suspense fallback={<p className="director-engine-handoff-empty">{t("正在加载 Blender 实时面板…")}</p>}>
        <BlenderLivePanel />
      </Suspense>
    </div>
  );
}

/**
 * 「DCC / 引擎交接」工作台。四个主机页共享一次目录发现;每页展示诚实的
 * 就绪状态、发送回执、回传差异与仅预览的实时链路状态。
 */
export function EngineHandoffDock({ onEngineSendCompleted }: EngineHandoffDockProps) {
  const { t } = useLanguage();
  const requestRef = useRef<AbortController | null>(null);
  const [activeTab, setActiveTab] = useState<EngineHandoffTabId>("blender");
  const [catalog, setCatalog] = useState<DirectorDccProviderCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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

  const sharedDetailProps = {
    catalogError: error,
    catalogLoading: loading,
    onRefresh: () => void discover(),
    onEngineSendCompleted,
  };

  return (
    <section aria-label={t("DCC / 引擎交接")} className="director-engine-handoff-dock">
      <header className="director-engine-handoff-dock-heading">
        <div>
          <strong>{t("DCC / 引擎交接")}</strong>
          <span>{t("原生连接、发送回执、回传差异与仅预览实时链路")}</span>
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
      <div aria-label={t("交接主机")} className="director-engine-handoff-tabs" role="tablist">
        {TABS.map((tab) => (
          <button
            aria-controls={`director-engine-handoff-panel-${tab.id}`}
            aria-selected={activeTab === tab.id}
            className={activeTab === tab.id ? "is-active" : undefined}
            id={`director-engine-handoff-tab-${tab.id}`}
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            role="tab"
            type="button"
          >
            <TabReadinessDot status={statusOf(catalog, tab.id)} />
            {tab.label}
          </button>
        ))}
      </div>
      <div
        aria-labelledby={`director-engine-handoff-tab-${activeTab}`}
        className="director-engine-handoff-panel"
        id={`director-engine-handoff-panel-${activeTab}`}
        role="tabpanel"
      >
        {activeTab === "blender" ? <BlenderHandoffTab status={statusOf(catalog, "blender")} /> : null}
        {activeTab === "unreal" ? (
          <EngineDetailPanel
            engine="unreal"
            liveLink={<UnrealLiveLinkSection />}
            renderReceipt={renderUnrealReceipt}
            sendNotes={UNREAL_SEND_NOTES}
            status={statusOf(catalog, "unreal")}
            supportsCleanFrame
            {...sharedDetailProps}
          />
        ) : null}
        {activeTab === "unity" ? (
          <EngineDetailPanel
            engine="unity"
            liveLink={<UnityLiveLinkSection />}
            renderReceipt={renderUnityReceipt}
            sendNotes={UNITY_SEND_NOTES}
            status={statusOf(catalog, "unity")}
            {...sharedDetailProps}
          />
        ) : null}
        {activeTab === "godot" ? (
          <EngineDetailPanel
            engine="godot"
            liveLink={<GodotLiveLinkSection />}
            renderReceipt={renderGodotReceipt}
            sendNotes={GODOT_SEND_NOTES}
            status={statusOf(catalog, "godot")}
            {...sharedDetailProps}
          />
        ) : null}
      </div>
    </section>
  );
}

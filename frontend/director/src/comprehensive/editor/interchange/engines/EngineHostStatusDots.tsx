/**
 * 顶栏四主机就绪点簇(Blender / Unreal / Unity / Godot):挂载时静默发现一次
 * 提供方目录,以三种状态着色 —— 原生就绪 / 仅交换包 / 不可用。绝不伪造
 * "已连接";目录不可达时整个簇隐藏。
 *
 * @module engine-host-status-dots
 */

import { useEffect, useState } from "react";
import type { DirectorDccProviderCatalog } from "../../../../dcc/directorDccProviderContract";
import { useLanguage } from "../../../i18n/language";
import { discoverDirectorDccProviders } from "../../api/dccProviderClient";

const HOSTS: Array<{ id: string; label: string }> = [
  { id: "blender", label: "Blender" },
  { id: "unreal", label: "Unreal" },
  { id: "unity", label: "Unity" },
  { id: "godot", label: "Godot" },
];

const STATE_LABELS: Record<string, string> = {
  native: "原生就绪",
  exchange: "仅交换包",
  unavailable: "不可用",
};

function hostState(catalog: DirectorDccProviderCatalog, id: string): "native" | "exchange" | "unavailable" {
  const status = catalog.providers.find((entry) => entry.provider.id === id);
  if (!status) return "unavailable";
  if (status.nativeReady) return "native";
  if (status.exchangeReady) return "exchange";
  return "unavailable";
}

/**
 * 交换菜单触发按钮上的主机就绪点簇。数据只在挂载时取一次;打开交接坞后
 * 的刷新按钮才做实时重查。
 */
export function EngineHostStatusDots() {
  const { t } = useLanguage();
  const [catalog, setCatalog] = useState<DirectorDccProviderCatalog | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void discoverDirectorDccProviders({ signal: controller.signal })
      .then((next) => {
        if (!controller.signal.aborted) setCatalog(next);
      })
      .catch(() => {
        // Silent: an unreachable gateway just hides the cluster.
      });
    return () => controller.abort();
  }, []);

  if (!catalog) return null;
  const summary = HOSTS.map((host) => `${host.label} ${t(STATE_LABELS[hostState(catalog, host.id)])}`).join(" · ");

  return (
    <span className="director-host-status-dots" title={summary}>
      {HOSTS.map((host) => (
        <i aria-hidden data-state={hostState(catalog, host.id)} key={host.id} />
      ))}
    </span>
  );
}

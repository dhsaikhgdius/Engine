/**
 * Agent 工作区：把 DeepSeek Harness Web 嵌进导演台。
 *
 * @module agent-workspace
 */

import { useEffect, useState } from "react";
import { useLanguage } from "../../i18n/language";
import "./AgentWorkspace.css";

/** DSH Web 默认监听地址（`webStartup.port ?? 3080`）。 */
export const DEFAULT_DSH_WEB_URL = "http://127.0.0.1:3080";
export const DIRECTOR_DSH_HEALTH_PATH = "/director/health";

const REQUIRED_DIRECTOR_TOOLS = [
  "director_creative",
  "director_workbench",
  "stage_video",
  "blender_native",
  "director_model_routes",
];
const PROBE_INTERVAL_MS = 2000;

type DshStatus = "checking" | "ready" | "unavailable" | "incompatible";

/**
 * 解析 Agent 工作区要嵌入的 DSH Web 地址。
 * @param raw - `VITE_DSH_WEB_URL`，空则回落到默认端口。
 */
export function resolveDshWebUrl(raw = import.meta.env.VITE_DSH_WEB_URL): string {
  if (typeof raw !== "string") return DEFAULT_DSH_WEB_URL;
  return raw.trim().replace(/\/$/, "") || DEFAULT_DSH_WEB_URL;
}

export function isDirectorDshHealth(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const health = value as { service?: unknown; version?: unknown; tools?: unknown };
  const tools = health.tools;
  return (
    health.service === "director-deepseek-harness" &&
    health.version === 1 &&
    Array.isArray(tools) &&
    REQUIRED_DIRECTOR_TOOLS.every((tool) => tools.includes(tool))
  );
}

/** Agent 工作区页面组件。 */
export function AgentWorkspace() {
  const { t } = useLanguage();
  const src = resolveDshWebUrl();
  const [status, setStatus] = useState<DshStatus>("checking");

  useEffect(() => {
    let cancelled = false;
    let interval = 0;

    const probe = async () => {
      try {
        const response = await fetch(`${src}${DIRECTOR_DSH_HEALTH_PATH}`, {
          headers: { accept: "application/json" },
        });
        const health: unknown = response.ok ? await response.json() : undefined;
        if (!isDirectorDshHealth(health)) throw new Error("Director DSH plugin is not loaded");
        if (cancelled) return;
        setStatus("ready");
        window.clearInterval(interval);
      } catch {
        try {
          await fetch(src, { mode: "no-cors" });
          if (!cancelled) setStatus("incompatible");
        } catch {
          if (!cancelled) setStatus("unavailable");
        }
      }
    };

    void probe();
    interval = window.setInterval(() => void probe(), PROBE_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [src]);

  return (
    <main aria-label={t("Agent 工作区")} className="director-agent-workspace">
      {status === "ready" ? (
        <iframe
          allow="clipboard-read; clipboard-write"
          className="director-agent-workspace-frame"
          src={src}
          title={t("DeepSeek Harness")}
        />
      ) : null}
      {status === "unavailable" ? (
        <section className="director-agent-workspace-guide">
          <h1>{t("用 DeepSeek Harness 驱动导演台")}</h1>
          <ol>
            <li>
              <code>npm run dev:gateway</code>
            </li>
            <li>
              <code>npm run dsh</code>
            </li>
          </ol>
        </section>
      ) : null}
      {status === "incompatible" ? (
        <section className="director-agent-workspace-guide">
          <h1>{t("DeepSeek Harness 未加载 Director 插件")}</h1>
          <p>{t("当前运行的 Agent 无法可靠操作导演台，请停止它并从项目根目录重新启动。")}</p>
          <code>npm run dsh</code>
        </section>
      ) : null}
    </main>
  );
}

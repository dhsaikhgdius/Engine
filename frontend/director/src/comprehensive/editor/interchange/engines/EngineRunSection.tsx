/**
 * 「工程与运行」区块:在引擎编辑器中打开配置的工程(三引擎),以及
 * Godot 项目运行 —— 有界调试输出尾部、状态徽章、SIGTERM 停止。
 * 网关只用固定参数向量启动已发现的引擎可执行文件,绝不执行请求提供的脚本。
 *
 * @module engine-run-section
 */

import { AppWindow, CircleStop, Play } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DirectorDccEngineRunStatus } from "../../../../dcc/directorDccEngineRunContract";
import type { DirectorDccEngineId } from "../../../../dcc/directorDccEngineSpace";
import { useLanguage } from "../../../i18n/language";
import {
  DirectorDccEngineRunClientError,
  fetchDirectorEngineRunStatus,
  launchDirectorEngineEditor,
  runDirectorEngineProject,
  stopDirectorEngineProject,
} from "../../api/dccEngineRunClient";

/** Poll cadence for the run status while a run is active. */
const RUN_POLL_INTERVAL_MS = 2_000;

const RUN_STATE_LABELS: Record<DirectorDccEngineRunStatus["state"], string> = {
  running: "运行中",
  exited: "已退出",
  stopped: "已停止",
  failed: "已失败",
};

function errorView(error: unknown, fallback: string): { message: string; recovery: string[] } {
  if (error instanceof DirectorDccEngineRunClientError) {
    return { message: error.message, recovery: error.recovery };
  }
  return { message: error instanceof Error ? error.message : fallback, recovery: [] };
}

/**
 * 打开引擎编辑器 + Godot 运行控制。运行输出是有界尾部(带截断标记),
 * 每 2 秒轮询一次直到运行结束。
 */
export function EngineRunSection({ engine }: { engine: DirectorDccEngineId }) {
  const { t } = useLanguage();
  const [launching, setLaunching] = useState(false);
  const [launchNote, setLaunchNote] = useState("");
  const [error, setError] = useState<{ message: string; recovery: string[] } | null>(null);
  const [scene, setScene] = useState("");
  const [headless, setHeadless] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [run, setRun] = useState<DirectorDccEngineRunStatus | null>(null);
  const pollRef = useRef<number | null>(null);
  const outputRef = useRef<HTMLPreElement | null>(null);
  const supportsRun = engine === "godot";

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  useEffect(() => {
    const node = outputRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [run?.output]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = window.setInterval(() => {
      void fetchDirectorEngineRunStatus(engine)
        .then((status) => {
          setRun(status);
          if (status.state !== "running") stopPolling();
        })
        .catch(() => {
          // A missing run (gateway restart) simply ends the poll; the last
          // known status stays visible.
          stopPolling();
        });
    }, RUN_POLL_INTERVAL_MS);
  }, [engine, stopPolling]);

  async function launchEditor() {
    setLaunching(true);
    setError(null);
    setLaunchNote("");
    try {
      const receipt = await launchDirectorEngineEditor(engine);
      setLaunchNote(`${t("编辑器已启动")} · PID ${receipt.pid}`);
    } catch (launchError) {
      setError(errorView(launchError, t("引擎编辑器启动失败")));
    } finally {
      setLaunching(false);
    }
  }

  async function startRun() {
    setStarting(true);
    setError(null);
    try {
      const status = await runDirectorEngineProject(engine, {
        ...(scene.trim() ? { scene: scene.trim() } : {}),
        headless,
      });
      setRun(status);
      startPolling();
    } catch (runError) {
      setError(errorView(runError, t("引擎项目运行启动失败")));
    } finally {
      setStarting(false);
    }
  }

  async function stopRun() {
    setStopping(true);
    setError(null);
    try {
      const status = await stopDirectorEngineProject(engine);
      setRun(status);
      stopPolling();
    } catch (stopError) {
      setError(errorView(stopError, t("引擎项目停止失败")));
    } finally {
      setStopping(false);
    }
  }

  const running = run?.state === "running";

  return (
    <section aria-label={t("工程与运行")} className="director-engine-handoff-block">
      <div className="director-engine-handoff-block-heading">
        <strong>{t("工程与运行")}</strong>
        <small>{t("固定参数向量启动本机引擎；绝不执行请求提供的脚本")}</small>
      </div>
      <div className="director-engine-run-toolbar">
        <button disabled={launching} onClick={() => void launchEditor()} type="button">
          <AppWindow aria-hidden size={12} />
          {launching ? t("启动中…") : t("在引擎编辑器中打开")}
        </button>
        {launchNote ? <output className="director-engine-handoff-applied">{launchNote}</output> : null}
      </div>
      {supportsRun ? (
        <>
          <div className="director-engine-run-toolbar">
            <input
              aria-label={t("运行场景（res:// 路径，留空用主场景）")}
              className="ui-field"
              disabled={running || starting}
              onChange={(event) => setScene(event.currentTarget.value)}
              placeholder="res://scenes/main.tscn"
              spellCheck={false}
              value={scene}
            />
            <label className="director-engine-handoff-opt-in">
              <input
                checked={headless}
                disabled={running || starting}
                onChange={(event) => setHeadless(event.currentTarget.checked)}
                type="checkbox"
              />
              <span>{t("无窗口运行")}</span>
            </label>
            {running ? (
              <button
                className="director-engine-run-stop"
                disabled={stopping}
                onClick={() => void stopRun()}
                type="button"
              >
                <CircleStop aria-hidden size={12} />
                {stopping ? t("停止中…") : t("停止运行")}
              </button>
            ) : (
              <button disabled={starting} onClick={() => void startRun()} type="button">
                <Play aria-hidden size={12} />
                {starting ? t("启动中…") : t("运行项目")}
              </button>
            )}
          </div>
          {run ? (
            <div className="director-engine-run-status" data-state={run.state}>
              <span>{t(RUN_STATE_LABELS[run.state])}</span>
              {run.exitCode !== null ? <small>{`${t("退出码")} ${run.exitCode}`}</small> : null}
              {run.outputTruncated ? <small>{t("输出已截断，仅保留尾部")}</small> : null}
            </div>
          ) : null}
          {run?.output ? (
            <pre aria-label={t("运行输出")} className="director-engine-run-output" ref={outputRef}>
              {run.output}
            </pre>
          ) : null}
        </>
      ) : (
        <p className="director-engine-handoff-hint">
          {t("项目运行暂不支持该引擎（需要引擎侧支持）；先打开编辑器，在引擎内运行验证")}
        </p>
      )}
      {error ? (
        <div className="director-engine-handoff-error" role="alert">
          <p>{error.message}</p>
          {error.recovery.length ? (
            <ul className="director-engine-handoff-list">
              {error.recovery.slice(0, 4).map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Director browser entry point.
 *
 * Route-aware boot: the research portal and the main creative workbench are
 * separate SPA surfaces served from the same origin. The entry decides which
 * one to mount based on the pathname, then lazy-loads only the chunks needed
 * for that surface.
 *
 * The Agent bridge (gatewayClient) is loaded after first paint so that the
 * control-plane WebSocket does not inflate or block the browser entry chunk.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

const isResearchPortal = window.location.pathname === "/research" || window.location.pathname === "/research/docs";
const root = createRoot(document.getElementById("root")!);

/**
 * Lazy-loads and mounts the correct SPA surface, then initializes the
 * Agent gateway bridge independently of first paint.
 *
 * On failure, renders a static recovery card without relying on any lazy
 * chunk — the chunk network path is exactly what may be broken.
 */
async function bootstrap() {
  if (isResearchPortal) {
    const { default: ResearchPortal } = await import("./research/ResearchPortal");
    root.render(
      <StrictMode>
        <ResearchPortal />
      </StrictMode>,
    );
    return;
  }

  const [{ default: App }, { initializeDirectorTheme }, { WorkspaceErrorBoundary }] = await Promise.all([
    import("./comprehensive/App"),
    import("./comprehensive/app/theme/directorTheme"),
    import("./comprehensive/app/errors/WorkspaceErrorBoundary"),
  ]);
  initializeDirectorTheme();
  root.render(
    <StrictMode>
      <WorkspaceErrorBoundary title="Director 加载出错">
        <App />
      </WorkspaceErrorBoundary>
    </StrictMode>,
  );

  // The Agent bridge is independent from first paint and includes the complete
  // command/audit/capture protocol. Loading it after the UI prevents that
  // control plane from inflating or blocking the browser entry chunk.
  const { initializeGateway } = await import("./agent/gatewayClient");
  const disposeGateway = initializeGateway();
  import.meta.hot?.dispose(disposeGateway);
}

void bootstrap().catch((error: unknown) => {
  // The recovery card below cannot come from a lazy chunk: if bootstrap failed
  // the chunk network path is exactly what is broken.
  console.error("Director bootstrap failed", error);
  root.render(
    <StrictMode>
      <div
        role="alert"
        style={{
          display: "grid",
          placeItems: "center",
          height: "100%",
          padding: 24,
          textAlign: "center",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "center", maxWidth: 420 }}>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Director 启动失败</p>
          <p style={{ margin: 0, fontSize: 12, opacity: 0.75 }}>
            可能是网络中断导致资源加载失败。你的工程数据仍保存在本地，不会因此丢失。
          </p>
          <button onClick={() => window.location.reload()} style={{ padding: "7px 16px" }} type="button">
            刷新页面
          </button>
        </div>
      </div>
    </StrictMode>,
  );
});

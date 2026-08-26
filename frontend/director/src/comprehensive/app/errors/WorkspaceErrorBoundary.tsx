import "./workspaceErrorBoundary.css";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertCircle } from "lucide-react";

interface WorkspaceErrorBoundaryProps {
  children: ReactNode;
  /** Full failure headline, e.g. "3D 片场加载失败". */
  title?: string;
  /** Called before clearing the error so parents can recreate lazy imports. */
  onRetry?: () => void;
}

interface WorkspaceErrorBoundaryState {
  error: Error | null;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Catches render errors and rejected lazy-chunk loads below it so a single
 * broken workspace (or a failed network fetch of its chunk) degrades to an
 * inline recovery card instead of a blank page.
 */
export class WorkspaceErrorBoundary extends Component<WorkspaceErrorBoundaryProps, WorkspaceErrorBoundaryState> {
  state: WorkspaceErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): WorkspaceErrorBoundaryState {
    return { error: toError(error) };
  }

  componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    console.error("WorkspaceErrorBoundary caught a render/chunk failure", error, errorInfo.componentStack);
  }

  private readonly retry = () => {
    this.props.onRetry?.();
    this.setState({ error: null });
  };

  private readonly reloadPage = () => {
    window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <main className="workspace-error-boundary" role="alert">
        <div className="workspace-error-boundary-card">
          <AlertCircle aria-hidden size={26} />
          <h2 className="workspace-error-boundary-title">{this.props.title ?? "界面加载出错"}</h2>
          <p className="workspace-error-boundary-description">
            可能是网络中断导致模块加载失败，或界面组件发生了错误。你的工程数据仍保存在本地，不会因此丢失。
          </p>
          {error.message ? (
            <p className="workspace-error-boundary-message" title={error.message}>
              {error.message}
            </p>
          ) : null}
          <div className="workspace-error-boundary-actions">
            <button className="is-primary" onClick={this.retry} type="button">
              重试
            </button>
            <button onClick={this.reloadPage} type="button">
              刷新页面
            </button>
          </div>
        </div>
      </main>
    );
  }
}

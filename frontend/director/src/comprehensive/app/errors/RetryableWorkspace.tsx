import { lazy, Suspense, useMemo, useState, type ComponentProps, type ComponentType } from "react";
import { WorkspaceErrorBoundary } from "./WorkspaceErrorBoundary";

function WorkspaceLoading({ label }: { label: string }) {
  return (
    <main aria-busy="true" aria-label={label} className="workspace-loading-state">
      <div className="workspace-loading-content">
        <span aria-hidden="true" className="workspace-loading-spinner" />
        <span>{label}</span>
      </div>
    </main>
  );
}

type RetryableWorkspaceProps<T extends ComponentType<any>> = {
  title: string;
  /** Omit for invisible hosts (e.g. capture bridges) that must not paint a loading state. */
  loadingLabel?: string;
  loader: () => Promise<{ default: T }>;
  children?: never;
} & ComponentProps<T>;

/**
 * Loads a workspace chunk lazily and recreates the lazy import on boundary retry
 * so rejected dynamic imports can succeed after a transient network failure.
 */
export function RetryableWorkspace<T extends ComponentType<any>>({
  title,
  loadingLabel,
  loader,
  ...props
}: RetryableWorkspaceProps<T>) {
  const [attempt, setAttempt] = useState(0);
  const LazyComponent = useMemo(() => lazy(loader), [attempt, loader]);
  return (
    <WorkspaceErrorBoundary title={title} onRetry={() => setAttempt((value) => value + 1)}>
      <Suspense fallback={loadingLabel ? <WorkspaceLoading label={loadingLabel} /> : null}>
        <LazyComponent key={attempt} {...props} />
      </Suspense>
    </WorkspaceErrorBoundary>
  );
}

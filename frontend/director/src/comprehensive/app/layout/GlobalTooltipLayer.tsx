import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

const TOOLTIP_DELAY_MS = 550;
const TOOLTIP_EDGE_GAP = 10;

type TooltipAnchor = {
  button: HTMLButtonElement;
  label: string;
  rect: DOMRect;
};

type TooltipPosition = {
  left: number;
  top: number;
};

function getTooltipButton(target: EventTarget | null) {
  return target instanceof Element ? target.closest<HTMLButtonElement>("button") : null;
}

function getTooltipLabel(button: HTMLButtonElement) {
  const explicitLabel = button.dataset.tooltip?.trim();
  if (explicitLabel) return explicitLabel;

  const ariaLabel = button.getAttribute("aria-label")?.trim();
  return ariaLabel && !button.textContent?.trim() ? ariaLabel : null;
}

function isInside(button: HTMLButtonElement, target: EventTarget | null) {
  return target instanceof Node && button.contains(target);
}

/**
 * Tooltips are portalled to document.body so the independent editor regions
 * (sidebars, viewport and timeline) can keep clipping their own scrolling
 * content without clipping a hover label.
 */
export function GlobalTooltipLayer() {
  const timeoutRef = useRef<number | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<TooltipAnchor | null>(null);
  const [position, setPosition] = useState<TooltipPosition | null>(null);

  const cancelPendingTooltip = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const hideTooltip = useCallback(() => {
    cancelPendingTooltip();
    setAnchor(null);
    setPosition(null);
  }, [cancelPendingTooltip]);

  const showTooltip = useCallback(
    (button: HTMLButtonElement, immediately: boolean) => {
      const label = getTooltipLabel(button);
      if (!label || button.disabled) return;

      cancelPendingTooltip();
      const show = () => {
        timeoutRef.current = null;
        // A delayed pointer event may outlive a React re-render that removed the
        // original icon button. Do not keep a detached element as a tooltip
        // anchor: ResizeObserver rejects non-live targets in some browsers.
        if (!button.isConnected) return;
        setPosition(null);
        setAnchor({ button, label, rect: button.getBoundingClientRect() });
      };

      if (immediately) show();
      else timeoutRef.current = window.setTimeout(show, TOOLTIP_DELAY_MS);
    },
    [cancelPendingTooltip],
  );

  useEffect(() => {
    const handlePointerOver = (event: PointerEvent) => {
      const button = getTooltipButton(event.target);
      if (!button || isInside(button, event.relatedTarget)) return;
      showTooltip(button, false);
    };
    const handlePointerOut = (event: PointerEvent) => {
      const button = getTooltipButton(event.target);
      if (button && !isInside(button, event.relatedTarget)) hideTooltip();
    };
    const handleFocusIn = (event: FocusEvent) => {
      const button = getTooltipButton(event.target);
      if (button) showTooltip(button, true);
    };
    const handleFocusOut = (event: FocusEvent) => {
      const button = getTooltipButton(event.target);
      if (button && !isInside(button, event.relatedTarget)) hideTooltip();
    };

    document.addEventListener("pointerover", handlePointerOver);
    document.addEventListener("pointerout", handlePointerOut);
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("focusout", handleFocusOut);
    return () => {
      cancelPendingTooltip();
      document.removeEventListener("pointerover", handlePointerOver);
      document.removeEventListener("pointerout", handlePointerOut);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("focusout", handleFocusOut);
    };
  }, [cancelPendingTooltip, hideTooltip, showTooltip]);

  useEffect(() => {
    if (!anchor) return;
    if (!anchor.button.isConnected) {
      setAnchor(null);
      setPosition(null);
      return;
    }
    const refreshAnchor = () => {
      setPosition(null);
      setAnchor((current) =>
        current && current.button === anchor.button
          ? { ...current, rect: current.button.getBoundingClientRect() }
          : current,
      );
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(refreshAnchor);
    const observeLiveElement = (element: unknown) => {
      if (element instanceof Element && element.isConnected) observer?.observe(element);
    };
    observeLiveElement(anchor.button);
    observeLiveElement(document.documentElement);
    window.addEventListener("resize", refreshAnchor);
    window.addEventListener("scroll", refreshAnchor, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", refreshAnchor);
      window.removeEventListener("scroll", refreshAnchor, true);
    };
  }, [anchor]);

  useLayoutEffect(() => {
    if (!anchor || !tooltipRef.current) return;
    const tooltipRect = tooltipRef.current.getBoundingClientRect();
    const left = Math.min(
      window.innerWidth - tooltipRect.width / 2 - TOOLTIP_EDGE_GAP,
      Math.max(tooltipRect.width / 2 + TOOLTIP_EDGE_GAP, anchor.rect.left + anchor.rect.width / 2),
    );
    const above = anchor.rect.top - tooltipRect.height - TOOLTIP_EDGE_GAP;
    const top =
      above >= TOOLTIP_EDGE_GAP
        ? above
        : Math.min(window.innerHeight - tooltipRect.height - TOOLTIP_EDGE_GAP, anchor.rect.bottom + TOOLTIP_EDGE_GAP);
    setPosition({ left, top });
  }, [anchor]);

  if (!anchor || typeof document === "undefined") return null;

  return createPortal(
    <div
      aria-hidden="true"
      className="director-global-tooltip"
      ref={tooltipRef}
      role="tooltip"
      style={(position ? { left: position.left, top: position.top } : { left: -10000, top: -10000 }) as CSSProperties}
    >
      {anchor.label}
    </div>,
    document.body,
  );
}
